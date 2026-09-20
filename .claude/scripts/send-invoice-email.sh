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

# The app's Send screen lets the user pick the recipient/subject/message —
# server.js passes those through already URL-encoded via RECIPIENT_EMAIL_ENC/
# EMAIL_SUBJECT_ENC/EMAIL_MESSAGE_ENC so this script never has to do its own
# (fragile, shell-quoting-prone) URL encoding. Falls back to the old
# hardcoded defaults only when called with no overrides at all (e.g. a bare
# manual run), so this stays backward compatible.
TO_ENC="${RECIPIENT_EMAIL_ENC:-juan.reisz%40glassdoor.com}"
SUBJECT_ENC="${EMAIL_SUBJECT_ENC:-Invoice%20Juan%20Reisz%20-%20Glassdoor}"
BODY_ENC="${EMAIL_MESSAGE_ENC:-Buenas%20tardes%20Carlos%2C%0AAdjunto%20factura%20correspondiente%20al%20mes%20en%20curso.%0A%0ASaludos%21}"

# 1. Open compose with pre-filled fields in Svitla Chrome profile.
# Capture the *window id* of whichever window we just navigated (not its
# positional index) — "window 1" is whatever's frontmost, and that can (and
# did) drift to a different window during the sleeps below if focus changes,
# e.g. because the caller is itself a page open in another Chrome tab.
COMPOSE_URL="https://outlook.office.com/mail/deeplink/compose?to=${TO_ENC}&subject=${SUBJECT_ENC}&body=${BODY_ENC}"

WIN_ID=$(osascript << APPLESCRIPT
tell application "Google Chrome"
  activate
  set theWin to window 1
  set URL of (tab 1 of theWin) to "$COMPOSE_URL"
  return id of theWin
end tell
APPLESCRIPT
)

echo "Opening compose window (window id $WIN_ID)..."
sleep 5

# 2. Verify compose loaded — targets the captured window id, not "window 1".
LOADED=$(osascript << APPLESCRIPT
tell application "Google Chrome"
  set theTab to tab 1 of (window id $WIN_ID)
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

# 3. Click the attach button — this only opens a dropdown menu (Browse this
# computer / OneDrive / Upload and share / Suggested files), it does NOT
# open a native file picker directly. Confirmed via manual inspection: the
# button's own aria-label is "Attach file" (singular), not "Attach files",
# so the first selector below never actually matches — it always falls
# through to the generic [aria-label*="ttach"] fallback, which happens to
# still find the right button, but the click only pops the menu open.
ATTACH_RESULT=$(osascript << APPLESCRIPT
tell application "Google Chrome"
  set theWin to window id $WIN_ID
  set index of theWin to 1
  activate
  set theTab to tab 1 of theWin
  execute theTab javascript "
    var attachBtn = document.querySelector('button[aria-label=\"Attach files\"]') ||
                    document.querySelector('button[title*=\"Attach\"]') ||
                    document.querySelector('[aria-label*=\"ttach\"]');
    if (attachBtn) { attachBtn.click(); 'clicked'; } else { 'not found'; }
  "
end tell
APPLESCRIPT
)

if [[ "$ATTACH_RESULT" != "clicked" ]]; then
  echo "ERROR: Could not click attach button ($ATTACH_RESULT)"
  exit 1
fi

sleep 1

# 3b. The attach menu is now open but nothing inside it has keyboard focus
# yet (it was opened via a synthetic JS .click(), not a real user gesture).
# "click at {x,y}" would be the obvious fix but requires a macOS permission
# this box doesn't have (System Events UI coordinate clicking, distinct from
# basic Accessibility keystroke access — confirmed via testing, fails with
# "osascript is not allowed assistive access"). Down-arrow + Enter works
# fine with only the keystroke/key-code permission we already have, and
# "Browse this computer" is reliably the first item in the menu.
osascript -e 'tell application "System Events" to key code 125' # Down arrow
sleep 0.3
FOCUSED=$(osascript << APPLESCRIPT
tell application "Google Chrome"
  execute (tab 1 of (window id $WIN_ID)) javascript "
    var f = document.activeElement;
    f ? f.getAttribute('aria-label') : '';
  "
end tell
APPLESCRIPT
)

if [[ "$FOCUSED" != "Browse this computer" ]]; then
  echo "ERROR: Expected 'Browse this computer' focused, got '$FOCUSED'"
  exit 1
fi

osascript -e 'tell application "System Events" to key code 36' # Enter — opens native file picker
sleep 1.5

HAS_SHEET=$(osascript -e 'tell application "System Events" to tell process "Google Chrome" to exists sheet 1 of window 1')
if [[ "$HAS_SHEET" != "true" ]]; then
  echo "ERROR: Native file picker did not open"
  exit 1
fi

# 4. Type the full file path via Cmd+Shift+G ("Go to Folder", which also
# accepts and selects a full file path directly), then Enter to select it,
# then Enter again to confirm/attach — this part was already correct.
osascript << APPLESCRIPT
tell application "System Events"
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

# 5. Click Send — again targets the captured window id.
RESULT=$(osascript << APPLESCRIPT
tell application "Google Chrome"
  set theTab to tab 1 of (window id $WIN_ID)
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
