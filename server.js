// Wraps the /invoice slash command's four steps as a real HTTP API, so this
// tool can run as a standing background process (like balance-ops,
// sync-server) instead of only being invocable from inside a live Claude
// Code session. See .claude/commands/invoice.md for the original manual
// flow this mirrors — same scripts, same order, just triggered over HTTP.
const http = require('http');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

// Load .env from the project root so GH_TOKEN, PORT, etc. don't need to be
// set in the shell — just put them in .env next to server.js.
try {
  const envPath = path.join(__dirname, '.env');
  fs.readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
    const m = line.match(/^\s*([^#=\s][^=]*?)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch { /* .env is optional */ }

const PORT = process.env.PORT || 4100;
const ROOT = __dirname;
const SCRIPTS = path.join(ROOT, '.claude', 'scripts');
const INVOICES_DIR = path.join(ROOT, 'invoices');

// Shared infrastructure — same for all users, no configuration needed.
const GH_REPO = 'DestinyAI/jreisz-build-an-invoice-manager-control-panel-i-backend';
const SUPABASE_URL = 'https://hikapyybttjgawhkdpga.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhpa2FweXlidHRqZ2F3aGtkcGdhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NjgwNDI2NSwiZXhwIjoyMTAyMzgwMjY1fQ.cqSUnNM6lhfAg1AQduzcPCoiQm8qX2PNyZC5KEkyG5s';

// Per-user — each person sets only their own GitHub token (repo scope for runner registration).
const GH_TOKEN = process.env.GH_TOKEN || '';

async function sbFetch(method, path, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'apikey': SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return r.status === 204 ? { ok: true } : r.json();
}

// Resolves the current user from the X-Api-Key request header.
// Falls back to INVOICER_USER env var for local curl testing.
const FALLBACK_USER = process.env.INVOICER_USER || 'jreisz';
const userCache = new Map(); // api_key → {id, display_name}, TTL ~5 min

async function resolveUser(req) {
  const apiKey = req.headers['x-api-key'] || '';
  if (!apiKey) return { id: FALLBACK_USER, display_name: FALLBACK_USER };

  if (userCache.has(apiKey)) {
    const cached = userCache.get(apiKey);
    if (Date.now() < cached.expiresAt) return cached.user;
    userCache.delete(apiKey);
  }

  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/invoicer_users?api_key=eq.${encodeURIComponent(apiKey)}&limit=1`,
    { headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'apikey': SUPABASE_SERVICE_KEY } }
  );
  const rows = await r.json();
  if (!Array.isArray(rows) || rows.length === 0) return null; // unauthorized
  const user = { id: rows[0].id, display_name: rows[0].display_name };
  userCache.set(apiKey, { user, expiresAt: Date.now() + 5 * 60 * 1000 });
  return user;
}


async function ghApi(method, path, body) {
  if (!GH_TOKEN) throw new Error('GH_TOKEN is not set in the server environment');
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${GH_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 204) return { ok: true };
  return res.json();
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
  });
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// Runs a script and resolves with its output rather than rejecting on a
// non-zero exit — callers report the script's own error text back to the
// caller instead of a generic 500.
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: ROOT, env: process.env, timeout: 5 * 60 * 1000, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: stdout?.trim() ?? '', stderr: stderr?.trim() ?? '' });
    });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Split off the query string so every existing exact-match route below
  // (url === '/foo') keeps working unchanged, while routes that need query
  // params (currently just GET /time/preview's ?overtime=) can read them
  // from searchParams instead of re-parsing req.url themselves.
  const [urlPath, queryString] = (req.url ?? '/').split('?');
  const url = urlPath;
  const searchParams = new URLSearchParams(queryString || '');

  if (req.method === 'GET' && url === '/ping') {
    return json(res, 200, { ok: true });
  }

  // Resolve caller identity — all routes below this point are user-scoped.
  const currentUser = await resolveUser(req);
  if (!currentUser) return json(res, 401, { ok: false, error: 'Invalid or missing X-Api-Key header' });
  const CURRENT_USER = currentUser.id;

  // Read-only: what's already been generated, no side effects.
  if (req.method === 'GET' && url === '/invoices') {
    const files = fs
      .readdirSync(INVOICES_DIR)
      .filter((f) => f.endsWith('.pdf'))
      .map((f) => {
        const stat = fs.statSync(path.join(INVOICES_DIR, f));
        return { name: f, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return json(res, 200, { invoices: files });
  }

  // Streams one generated PDF back to the caller. /invoices only lists
  // metadata, so without this the web app has no way to actually open a
  // file it can see in that list. The name is taken from the URL rather
  // than a query string so the browser's download filename is sensible;
  // basename() keeps a crafted name from escaping INVOICES_DIR.
  if (req.method === 'GET' && url.startsWith('/invoices/file/')) {
    const requested = decodeURIComponent(url.slice('/invoices/file/'.length));
    const name = path.basename(requested);
    const filePath = path.join(INVOICES_DIR, name);
    if (!name.endsWith('.pdf') || !fs.existsSync(filePath)) {
      return json(res, 404, { ok: false, error: `No such invoice: ${name}` });
    }
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${name}"`,
      'Content-Length': fs.statSync(filePath).size,
    });
    return fs.createReadStream(filePath).pipe(res);
  }

  // Fills the Numbers template with this month's date and exports a PDF.
  // Local side effect only (opens/closes Numbers, writes into invoices/) —
  // no network call, safe to re-run (overwrites this month's file).
  if (req.method === 'POST' && url === '/invoices/generate') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { /* ignore */ }
    const scriptPath = path.join(SCRIPTS, 'generate-invoice.sh');
    const env = {
      ...process.env,
      CURRENCY: body.currency || 'USD',
      CLIENT_NAME: body.client_name || '',
      INVOICE_DATE: body.invoice_date || '',
      ITEMS_JSON: body.items ? JSON.stringify(body.items) : '',
      OUTPUT_NAME_OVERRIDE: body.output_name || '',
      CLIENT_INFO: body.client_info ? JSON.stringify(body.client_info) : '',
    };
    return new Promise((resolve) => {
      execFile('bash', [scriptPath], { env, cwd: __dirname }, (err, stdout, stderr) => {
        if (err) {
          console.error('generate error:', stderr);
          resolve(json(res, 500, { ok: false, error: stderr || err.message }));
        } else {
          const match = stdout.match(/Saved to: (.+)/);
          const filename = match ? path.basename(match[1].trim()) : null;
          resolve(json(res, 200, { ok: true, filename }));
        }
      });
    });
  }

  // Read-only preview of what /time/log would submit: which weekdays this
  // month are still empty on Svitla's calendar and which Jira ticket each
  // one would be filled with (same round-robin as the real run). Lets the
  // app show "this will log N days" before the user commits to the
  // irreversible POST below — no browser window, no submission.
  if (req.method === 'GET' && url === '/time/preview') {
    if (!process.env.SVITLA_PASS) {
      return json(res, 500, { ok: false, error: 'SVITLA_PASS is not set in the server environment' });
    }
    // Optional ?overtime=<json> — same shape as POST /time/log's
    // overtimeByDate body field, e.g. {"2026-09-03":{"hours":3,"description":"..."}}
    // — so the preview reflects manual overtime overrides before submission.
    let overtimeByDate = {};
    const overtimeParam = searchParams.get('overtime');
    if (overtimeParam) {
      try {
        overtimeByDate = JSON.parse(overtimeParam);
      } catch {
        return json(res, 400, { ok: false, error: 'invalid JSON in ?overtime=' });
      }
    }
    const result = await run('node', [path.join(SCRIPTS, 'log-time.js'), '--dry-run'], {
      env: { ...process.env, OVERTIME_JSON: JSON.stringify(overtimeByDate) },
    });
    const match = result.stdout.match(/PREVIEW:(\{.*\})/);
    if (!match) {
      return json(res, 500, { ok: false, error: result.stderr || 'Preview script produced no PREVIEW: line' });
    }
    const { days } = JSON.parse(match[1]);
    return json(res, 200, { ok: true, days });
  }

  // Logs real billable hours into Svitla's time tracker for the current
  // month — an outward-facing, hard-to-undo action once submitted, so it
  // requires an explicit {"confirm": true} body rather than firing on any
  // POST, and needs SVITLA_PASS set in this server's own environment
  // (never accepted over HTTP).
  if (req.method === 'POST' && url === '/time/log') {
    const body = await readBody(req);
    let confirm = false;
    let overtimeByDate = {};
    try {
      const parsed = JSON.parse(body || '{}');
      confirm = parsed.confirm === true;
      // Manual overtime overrides, keyed by "YYYY-MM-DD", e.g.
      // {"2026-09-03":{"hours":3,"description":"ir-critical-secvulgd-33074"}}
      // — that day gets 8 (base) + 3 = 11h, description becomes
      // "<round-robin Jira ticket> Overtime Hours ir-critical-secvulgd-33074".
      overtimeByDate = parsed.overtimeByDate || {};
    } catch {
      return json(res, 400, { ok: false, error: 'invalid JSON body' });
    }
    if (!confirm) return json(res, 400, { ok: false, error: 'POST {"confirm": true} to actually log time' });
    if (!process.env.SVITLA_PASS) {
      return json(res, 500, { ok: false, error: 'SVITLA_PASS is not set in the server environment' });
    }
    const result = await run('node', [path.join(SCRIPTS, 'log-time.js')], {
      env: { ...process.env, OVERTIME_JSON: JSON.stringify(overtimeByDate) },
    });
    if (!result.ok) return json(res, 500, result);
    const match = result.stdout.match(/RESULT:(\{.*\})/);
    const days = match ? JSON.parse(match[1]).days : [];
    return json(res, 200, { ok: true, days });
  }

  // Sends the current month's invoice PDF to the client by email via
  // Outlook — a real, irreversible send once it succeeds, so it also
  // requires an explicit {"confirm": true} body.
  if (req.method === 'POST' && url === '/invoices/send') {
    const body = await readBody(req);
    let confirm = false;
    try {
      confirm = JSON.parse(body || '{}').confirm === true;
    } catch {
      return json(res, 400, { ok: false, error: 'invalid JSON body' });
    }
    if (!confirm) return json(res, 400, { ok: false, error: 'POST {"confirm": true} to actually send the email' });
    const result = await run('bash', [path.join(SCRIPTS, 'send-invoice-email.sh')]);
    return json(res, result.ok ? 200 : 500, result);
  }

  // Checks whether the local machine is ready to send email via Outlook/Chrome.
  // Returns {ok, checks: [{name, pass, hint}]} so the Setup screen can show
  // per-step status without triggering any real side effects.
  if (req.method === 'GET' && url === '/invoices/send/preflight') {
    const checks = [];

    // 1. Is Chrome running?
    const chrome = await run('pgrep', ['-x', 'Google Chrome']);
    checks.push({ name: 'Chrome is running', passed: chrome.ok, hint: 'Open Google Chrome before sending' });

    // 2. Accessibility permission — osascript can drive System Events
    const ax = await run('osascript', ['-e', 'tell application "System Events" to return name of first process whose frontmost is true']);
    checks.push({ name: 'Accessibility permission granted', passed: ax.ok, hint: 'System Settings → Privacy & Security → Accessibility → enable Terminal (or the app running this server)' });

    // 3. Chrome JS from Apple Events enabled
    const jsAe = await run('defaults', ['read', 'com.google.Chrome', 'AllowJavascriptFromAppleEvents']);
    checks.push({ name: '"Allow JavaScript from Apple Events" enabled in Chrome', passed: jsAe.stdout === '1', hint: 'Chrome menu → View → Developer → Allow JavaScript from Apple Events' });

    // 4. Is the invoices/ folder writable (sanity check)?
    const writable = fs.existsSync(INVOICES_DIR);
    checks.push({ name: 'invoices/ folder exists', passed: writable, hint: `Create the folder at ${INVOICES_DIR}` });

    const allPass = checks.every((c) => c.passed);
    return json(res, 200, { ok: allPass, checks });
  }

  // Uploads a locally-generated PDF into Supabase storage so the app can
  // see it. Called when the user taps "Finalize Invoice" in the web app.
  if (req.method === 'POST' && url === '/invoices/finalize') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch {
      return json(res, 400, { ok: false, error: 'invalid JSON body' });
    }
    if (!body.filename) return json(res, 400, { ok: false, error: 'filename is required' });
    const name = path.basename(body.filename);
    const filePath = path.join(INVOICES_DIR, name);
    if (!name.endsWith('.pdf') || !fs.existsSync(filePath)) {
      return json(res, 404, { ok: false, error: `Invoice not found locally: ${name}` });
    }
    if (!SUPABASE_SERVICE_KEY) {
      return json(res, 500, { ok: false, error: 'SUPABASE_SERVICE_KEY is not set in server .env' });
    }
    const fileBytes = fs.readFileSync(filePath);
    const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/invoices/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/pdf',
        'x-upsert': 'true',
      },
      body: fileBytes,
    });
    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      return json(res, 500, { ok: false, error: `Supabase upload failed: ${err}` });
    }
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/invoices/${encodeURIComponent(name)}`;
    return json(res, 200, { ok: true, url: publicUrl, filename: name });
  }

  // App-facing send endpoint — accepts {filename, recipientEmail, subject, message}
  // and runs the same send script, overriding the PDF path via INVOICE_FILE.
  // recipientEmail/subject/message are URL-encoded here (Node's encodeURIComponent)
  // and handed to the script as already-encoded env vars — the script just
  // concatenates them into the Outlook deeplink, no shell-side encoding needed.
  if (req.method === 'POST' && url === '/api/invoices/send') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch {
      return json(res, 400, { ok: false, error: 'invalid JSON body' });
    }
    if (!body.filename) return json(res, 400, { ok: false, error: 'filename is required' });
    const filePath = path.join(INVOICES_DIR, path.basename(body.filename));
    if (!fs.existsSync(filePath)) return json(res, 404, { ok: false, error: `Invoice not found: ${body.filename}` });
    const env = { ...process.env };
    if (body.recipientEmail) env.RECIPIENT_EMAIL_ENC = encodeURIComponent(body.recipientEmail);
    if (body.subject) env.EMAIL_SUBJECT_ENC = encodeURIComponent(body.subject);
    if (body.message) env.EMAIL_MESSAGE_ENC = encodeURIComponent(body.message);
    const result = await run('bash', [path.join(SCRIPTS, 'send-invoice-email.sh'), filePath], { env });
    return json(res, result.ok ? 200 : 500, result);
  }

  // GHA fallback (kept for remote runners).
  if (req.method === 'POST' && url === '/invoices/generate-via-gha') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { /* ignore */ }
    try {
      const result = await ghApi('POST', `/repos/${GH_REPO}/actions/workflows/generate-invoice.yml/dispatches`, {
        ref: 'main',
        inputs: {
          ...(body.currency ? { currency: body.currency } : {}),
          ...(body.client_name ? { client_name: body.client_name } : {}),
          ...(body.month ? { month: String(body.month) } : {}),
          ...(body.year ? { year: String(body.year) } : {}),
          ...(body.invoice_date ? { invoice_date: body.invoice_date } : {}),
          ...(body.items ? { items: JSON.stringify(body.items) } : {}),
          ...(body.output_name ? { output_name: body.output_name } : {}),
          ...(body.client_info ? { client_info: JSON.stringify(body.client_info) } : {}),
        },
      });
      // 204 = dispatched; anything else is an error from GitHub
      return json(res, result.ok ? 202 : 500, result.ok
        ? { ok: true, message: 'Workflow dispatched — PDF will appear in invoices/ within ~60 seconds' }
        : { ok: false, error: result.message ?? JSON.stringify(result) });
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message });
    }
  }

  // Returns registration token + copy-paste Terminal commands so the web app
  // can guide any user through adding their Mac as a self-hosted runner.
  // Token is valid for 1 hour; never forwarded to the browser directly —
  // the commands are pre-formatted here so the token stays server-side.
  if (req.method === 'POST' && url === '/runner/token') {
    try {
      const data = await ghApi('POST', `/repos/${GH_REPO}/actions/runners/registration-token`);
      if (!data.token) return json(res, 500, { ok: false, error: data.message ?? 'GitHub did not return a token' });
      const arch = process.arch === 'arm64' ? 'osx-arm64' : 'osx-x64';
      const version = '2.337.0';
      const tarball = `actions-runner-${arch}-${version}.tar.gz`;
      const commands = [
        `mkdir -p ~/invoicer-runner && cd ~/invoicer-runner`,
        `curl -o ${tarball} -L https://github.com/actions/runner/releases/download/v${version}/${tarball}`,
        `tar xzf ${tarball}`,
        `./config.sh --url https://github.com/${GH_REPO} --token ${data.token} --name "$(hostname -s)" --unattended`,
        `./run.sh`,
      ];
      return json(res, 200, { ok: true, commands, expiresAt: data.expires_at });
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message });
    }
  }

  // Lists self-hosted runners for this repo so the web app can show
  // whether the user's Mac is online without exposing GH_TOKEN to the browser.
  if (req.method === 'GET' && url === '/runner/status') {
    try {
      const data = await ghApi('GET', `/repos/${GH_REPO}/actions/runners`);
      const runners = (data.runners ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,      // 'online' | 'offline'
        busy: r.busy,
        os: r.os,
      }));
      return json(res, 200, { ok: true, runners, total: data.total_count ?? runners.length });
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message });
    }
  }

  if (req.method === 'GET' && url === '/clients') {
    const data = await sbFetch('GET', `/clients?user_id=eq.${CURRENT_USER}&order=name`);
    return json(res, 200, { ok: true, clients: Array.isArray(data) ? data : [] });
  }

  if (req.method === 'POST' && url === '/clients') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch {
      return json(res, 400, { ok: false, error: 'invalid JSON' });
    }
    const { name, email, filename_format, contact_name, company_name, payment_info } = body;
    const data = await sbFetch('POST', '/clients', { name, email, filename_format, contact_name, company_name, payment_info, user_id: CURRENT_USER });
    return json(res, 201, { ok: true, client: Array.isArray(data) ? data[0] : data });
  }

  if (req.method === 'PUT' && url.startsWith('/clients/')) {
    const id = url.split('/clients/')[1];
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch {
      return json(res, 400, { ok: false, error: 'invalid JSON' });
    }
    const { name, email, filename_format, contact_name, company_name, payment_info } = body;
    const data = await sbFetch('PATCH', `/clients?id=eq.${id}&user_id=eq.${CURRENT_USER}`, { name, email, filename_format, contact_name, company_name, payment_info });
    return json(res, 200, { ok: true, client: Array.isArray(data) ? data[0] : data });
  }

  if (req.method === 'DELETE' && url.startsWith('/clients/')) {
    const id = url.split('/clients/')[1];
    await sbFetch('DELETE', `/clients?id=eq.${id}&user_id=eq.${CURRENT_USER}`);
    return json(res, 200, { ok: true });
  }

  json(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`Invoicer API running at http://localhost:${PORT}`);
});
