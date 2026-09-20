Generate the monthly invoice PDF from the Numbers template and send it by email.

## Step 1 — Generate PDF

Run the following script and report the result:

```bash
bash /Users/juanreisz/code/create-app/workspaces/jreisz/invoicer/.claude/scripts/generate-invoice.sh
```

Confirm to the user:
- The PDF filename that was created (e.g. `Invoice 4_2026.pdf`)
- Its location in the `invoices/` folder
- That the template was left unchanged

## Step 2 — Fetch Jira tickets for the current month

Use the Jira REST API to retrieve all tickets assigned to Juan Reisz updated during the current calendar month.

```bash
ACCOUNT_ID="712020:f46959f2-2735-4aee-b2a2-42dcb3d10e8d"
MONTH_START=$(date +%Y-%m-01)
curl -s -u "jreisz@contractor.indeed.com:$(cat ~/.jira_token 2>/dev/null || echo $JIRA_API_TOKEN)" \
  -X POST -H "Content-Type: application/json" \
  -d "{\"jql\": \"assignee = \\\"$ACCOUNT_ID\\\" AND updated >= \\\"$MONTH_START\\\" ORDER BY updated DESC\", \"maxResults\": 100, \"fields\": [\"summary\",\"status\",\"issuetype\",\"updated\",\"project\"]}" \
  "https://indeed.atlassian.net/rest/api/3/search/jql"
```

**Credentials:**
- Username: `jreisz@contractor.indeed.com`
- Token: read from `~/.jira_token` if present, otherwise use `$JIRA_API_TOKEN` env var, otherwise use the token from `~/.claude/settings.json` mcpServers.atlassian.env.JIRA_API_TOKEN

Display the results grouped by status:
- **In Review** / **In Progress** — tickets actively being worked on
- **Pending Triage** / **Backlog** — upcoming work
- **Closed** — completed this month

Show each ticket as: `KEY — Summary (status, updated date)`

Confirm to the user the list is ready to be used for time tracking registration.

## Step 3 — Register time in Svitla time tracker

Run the time tracking script:

```bash
SVITLA_PASS='<password>' node /Users/juanreisz/code/create-app/workspaces/jreisz/invoicer/.claude/scripts/log-time.js
```

**Credentials:**
- Svitla password via `SVITLA_PASS` env var (`j.reisz@svitla.com` / Microsoft SSO)
- Jira token auto-read from `~/.claude/settings.json` (mcpServers.atlassian.env.JIRA_API_TOKEN)

The script will:
1. Fetch this month's Jira tickets from `indeed.atlassian.net` (used as day descriptions)
2. Log in to `id.svitla.com` via Microsoft SSO
3. Parse the calendar for the current month — skipping:
   - Saturdays and Sundays (`td.day.weekend`)
   - Holidays (non-weekend days with orange-colored day number)
   - Days that already have entries logged
4. For each remaining weekday, open `https://id.svitla.com/time_entries/new?date=DD-MM-YYYY` and fill:
   - **Project:** 706 - Glassdoor
   - **Description:** next ticket from the Jira list (cycling through them)
   - **Time:** 8h
5. Submit and report logged vs skipped days

After the script completes, report how many days were logged and which ones were skipped.

## Step 4 — Send email with invoice attached

Run the send script:

```bash
SVITLA_PASS='<password>' node /Users/juanreisz/code/create-app/workspaces/jreisz/invoicer/.claude/scripts/send-invoice-email.js
```

This uses Playwright (Chromium) to log in to Outlook as `j.reisz@svitla.com`, compose the email, attach the current month's PDF, and send it to `ca.guerrero@svitla.com` with:
- **Subject:** Invoice Juan Reisz - Glassdoor
- **Body:** Buenas tardes Carlos, / Adjunto factura correspondiente al mes en curso. / Saludos!

After the script completes, confirm the email was sent successfully.
