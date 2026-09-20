#!/bin/zsh
# Sends the current month invoice PDF via Outlook (Svitla profile in Chrome).
# Requires: Chrome open with Svitla profile + "Allow JavaScript from Apple Events" enabled.
# Requires: Accessibility permission granted to Terminal in System Settings.

set -euo pipefail

MONTH=$(date +%-m)
YEAR=$(date +%Y)
# Allow caller to override the filename via $1 or INVOICE_FILE env var
if [[ -n "${1:-}" ]]; then
  INVOICE_PATH="$1"
elif [[ -n "${INVOICE_FILE:-}" ]]; then
  INVOICE_PATH="$INVOICE_FILE"
else
  BACKEND_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
  INVOICE_PATH="$BACKEND_ROOT/invoices/Invoice ${MONTH}_${YEAR}.pdf"
fi

if [[ ! -f "$INVOICE_PATH" ]]; then
  echo "ERROR: Invoice file not found: $INVOICE_PATH"
  exit 1
fi

echo "Invoice found: $INVOICE_PATH"

# 1. Open compose with pre-filled fields in Svitla Chrome profile
COMPOSE_URL="https://outlook.office.com/mail/deeplink/compose?to=juan.reisz%40glassdoor.com&subject=Invoice%20Juan%20Reisz%20-%20Glassdoor&body=Buenas%20tardes%20Carlos%2C%0AAdjunto%20factura%20correspondiente%20al%20mes%20en%20curso.%0A%0ASaludos%21"

osascript << APPLESCRIPT
tell application "Google Chrome"
  activate
  set theWin to window 1
  set URL of (tab 1 of theWin) to "$COMPOSE_URL"
end tell
APPLESCRIPT

echo "Opening compose window..."
sleep 5

# 2. Verify compose loaded
LOADED=$(osascript << 'APPLESCRIPT'
tell application "Google Chrome"
  set theTab to tab 1 of window 1
  execute theTab javascript "
    var sendBtn = document.querySelector('button[aria-label=\"Send\"]');
    var subj = document.querySelector('input[aria-label=\"Subject\"]');
    sendBtn && subj ? 'ready' : 'not ready';
  "
end tell
APPLESCRIPT
)

if [[ "$LOADED" != "ready" ]]; then
  echo "ERROR: Compose window did not load properly. Is Chrome open with Svitla profile?"
  exit 1
fi

echo "Compose loaded. Clicking attach button..."

# 3. Click the attach button to open file picker
osascript << 'APPLESCRIPT'
tell application "Google Chrome"
  activate
  set theTab to tab 1 of window 1
  execute theTab javascript "
    var attachBtn = document.querySelector('button[aria-label=\"Attach files\"]') ||
                    document.querySelector('button[title*=\"Attach\"]') ||
                    document.querySelector('[aria-label*=\"ttach\"]');
    if (attachBtn) { attachBtn.click(); 'clicked'; } else { 'not found'; }
  "
end tell
APPLESCRIPT

sleep 2

# 4. Use System Events to type the file path in the Open dialog and confirm
osascript << APPLESCRIPT
tell application "System Events"
  -- Type the full path and press Enter to navigate directly to it
  keystroke "g" using {command down, shift down}
  delay 1
  keystroke "$INVOICE_PATH"
  delay 0.5
  key code 36
  delay 0.5
  key code 36
end tell
APPLESCRIPT

echo "Waiting for file to upload..."
sleep 4

# 5. Click Send
RESULT=$(osascript << 'APPLESCRIPT'
tell application "Google Chrome"
  set theTab to tab 1 of window 1
  execute theTab javascript "
    var sendBtn = document.querySelector('button[aria-label=\"Send\"]');
    if (sendBtn && !sendBtn.disabled) { sendBtn.click(); 'sent'; } else { 'send btn: ' + (sendBtn ? 'disabled' : 'not found'); }
  "
end tell
APPLESCRIPT
)

echo "Send result: $RESULT"

if [[ "$RESULT" == "sent" ]]; then
  echo "Email sent successfully with invoice attachment."
else
  echo "WARNING: Send may not have worked — $RESULT"
  exit 1
fi
