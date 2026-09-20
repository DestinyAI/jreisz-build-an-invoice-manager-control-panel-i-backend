const { chromium } = require('playwright');
const https = require('https');
const fs = require('fs');

const JIRA_USERNAME = 'jreisz@contractor.indeed.com';
const JIRA_ACCOUNT_ID = '712020:f46959f2-2735-4aee-b2a2-42dcb3d10e8d';
const SVITLA_EMAIL = 'j.reisz@svitla.com';
const SVITLA_PASS = process.env.SVITLA_PASS;
const CALENDAR_URL = 'https://id.svitla.com/users/2900/calendar';

function getJiraToken() {
  if (process.env.JIRA_API_TOKEN) return process.env.JIRA_API_TOKEN;
  try {
    const settings = JSON.parse(fs.readFileSync(`${process.env.HOME}/.claude/settings.json`, 'utf8'));
    return settings.mcpServers?.atlassian?.env?.JIRA_API_TOKEN;
  } catch (e) { return null; }
}

function fetchJiraTickets(token) {
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const body = JSON.stringify({
    jql: `assignee = "${JIRA_ACCOUNT_ID}" AND updated >= "${monthStart}" ORDER BY updated DESC`,
    maxResults: 100,
    fields: ['summary']
  });
  const auth = Buffer.from(`${JIRA_USERNAME}:${token}`).toString('base64');
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'indeed.atlassian.net',
      path: '/rest/api/3/search/jql',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve((parsed.issues || []).map(i => `${i.key} — ${i.fields.summary}`));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function login(page) {
  await page.goto(CALENDAR_URL);
  await page.click('a[href="/auth/saml"]');
  await page.waitForURL(/login\.microsoftonline/);
  await page.fill('input[type="email"]', SVITLA_EMAIL);
  await page.click('input[type="submit"]');
  await page.waitForTimeout(1500);
  await page.fill('input[type="password"]', SVITLA_PASS);
  await page.click('input[type="submit"]');
  await page.waitForTimeout(2000);
  try {
    await page.waitForSelector('input[value="Yes"]', { timeout: 3000 });
    await page.click('input[value="Yes"]');
  } catch (e) { /* no prompt */ }
  await page.waitForURL(/svitla\.com/, { timeout: 20000 });
}

async function getDaysToLog(page) {
  await page.goto(CALENDAR_URL);
  await page.waitForLoadState('networkidle');

  return await page.evaluate(() => {
    const cells = document.querySelectorAll('td.day:not(.otherMonth)');
    const days = [];
    for (const cell of cells) {
      const header = cell.querySelector('.cell-header');
      if (!header) continue;
      const dateAttr = header.getAttribute('data-date');
      if (!dateAttr) continue;

      // Skip weekends
      if (cell.classList.contains('weekend')) continue;

      // Skip holidays: orange day-number span on a non-weekend
      const span = header.querySelector('span');
      if (span) {
        const rgb = window.getComputedStyle(span).color.match(/\d+/g);
        if (rgb) {
          const [r, g, b] = rgb.map(Number);
          // Orange-ish: high red, medium green, low blue — not the default dark text
          if (r > 180 && g > 80 && g < 175 && b < 50) continue;
        }
      }

      // Skip days that already have time entries (cell has content beyond cell-header)
      const cellClone = cell.cloneNode(true);
      cellClone.querySelector('.cell-header')?.remove();
      if (cellClone.textContent.trim().length > 0) continue;

      const [y, m, d] = dateAttr.split('-');
      days.push({ date: dateAttr, urlDate: `${d}-${m}-${y}` });
    }
    return days;
  });
}

// --dry-run: does everything read-only (fetch tickets, log in, scan the
// calendar for empty days, compute the same round-robin day→ticket
// assignment the real run would use) but skips the fill+submit loop. Lets
// the app show "this will log N days with these descriptions" before the
// user commits to an irreversible submission. Runs headless (no visible
// browser, no slowMo) since there's no fill-in to visually verify here.
const DRY_RUN = process.argv.includes('--dry-run');

(async () => {
  if (!SVITLA_PASS) { console.error('Set SVITLA_PASS env var'); process.exit(1); }

  const jiraToken = getJiraToken();
  if (!jiraToken) { console.error('No Jira token found'); process.exit(1); }

  console.log('Fetching Jira tickets...');
  const tickets = await fetchJiraTickets(jiraToken);
  console.log(`${tickets.length} tickets loaded`);
  if (tickets.length === 0) { console.error('No tickets found — aborting'); process.exit(1); }

  const browser = await chromium.launch(
    DRY_RUN ? { headless: true } : { headless: false, slowMo: 400 }
  );
  const page = await browser.newPage();

  console.log('Logging in to Svitla...');
  await login(page);

  const days = await getDaysToLog(page);
  console.log(`\nDays to log: ${days.length}`);
  days.forEach(d => console.log(`  ${d.date}`));

  if (days.length === 0) {
    console.log('Nothing to log — all days already filled or no working days found.');
    if (DRY_RUN) console.log(`PREVIEW:${JSON.stringify({ days: [] })}`);
    await browser.close();
    return;
  }

  if (DRY_RUN) {
    const plan = days.map((day, i) => ({
      date: day.date,
      description: tickets[i % tickets.length],
    }));
    console.log(`PREVIEW:${JSON.stringify({ days: plan })}`);
    await browser.close();
    return;
  }

  let logged = 0;
  const loggedDays = [];
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const description = tickets[i % tickets.length];
    console.log(`\n[${i + 1}/${days.length}] ${day.date} → ${description.substring(0, 70)}...`);

    await page.goto(`https://id.svitla.com/time_entries/new?date=${day.urlDate}`);
    await page.waitForLoadState('networkidle');

    // Select project 706 - Glassdoor via jQuery/Select2
    await page.evaluate(() => {
      if (window.$) {
        $('#time_entry_project_id').val('706').trigger('change');
      }
    });
    await page.waitForTimeout(600);

    // Verify selection; fallback to clicking Select2 UI
    const selected = await page.evaluate(() => {
      const s = document.querySelector('#time_entry_project_id');
      return s && s.value === '706';
    });
    if (!selected) {
      await page.click('#select2-time_entry_project_id-container');
      await page.waitForSelector('.select2-results__option');
      await page.click('.select2-results__option:has-text("Glassdoor")');
      await page.waitForTimeout(400);
    }

    // Fill description and time
    await page.fill('#time_entry_description', description);
    await page.fill('#time_entry_human_time', '8h');

    // Submit
    await page.click('input[type="submit"][value="Enter time"]');
    await page.waitForLoadState('networkidle');

    logged++;
    loggedDays.push({ date: day.date, description });
    console.log(`  ✓ Logged`);
    await page.waitForTimeout(300);
  }

  console.log(`\n✓ Done — ${logged}/${days.length} days logged`);
  console.log(`RESULT:${JSON.stringify({ days: loggedDays })}`);
  await browser.close();
})();
