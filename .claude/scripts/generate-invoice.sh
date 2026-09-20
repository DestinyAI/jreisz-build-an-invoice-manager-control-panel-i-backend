#!/bin/zsh
# Generates a monthly invoice PDF from invoice-template.numbers.
# Patches date, currency, descriptions, and amounts via binary patch + AppleScript.

set -euo pipefail

# Resolve relative to this script — works wherever the repo is cloned.
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
BACKEND_ROOT="$(cd "$SCRIPTS/../.." && pwd)"
TEMPLATE_PATH="$BACKEND_ROOT/invoice-template.numbers"
OUTPUT_DIR="$BACKEND_ROOT/invoices"
WORK_DIR="/tmp/invoice-work-$$"
PATCHED="/tmp/invoice-patched-$$.numbers"

MONTH=$(date +%-m)
MONTH_PAD=$(date +%m)
YEAR=$(date +%Y)
YEAR_SHORT=$(date +%y)

CURRENCY=${CURRENCY:-USD}
CLIENT_NAME=${CLIENT_NAME:-Svitla}
ITEMS_JSON=${ITEMS_JSON:-''}
INVOICE_DATE=${INVOICE_DATE:-"${MONTH_PAD}/20/${YEAR_SHORT}"}

OUTPUT_NAME="${OUTPUT_NAME_OVERRIDE:-"Invoice ${CLIENT_NAME} ${MONTH}_${YEAR}.pdf"}"
OUTPUT_PATH="${OUTPUT_DIR}/${OUTPUT_NAME}"
NEW_DATE="Submitted on ${INVOICE_DATE}"

echo "Generating: ${OUTPUT_NAME} (currency: ${CURRENCY})"

# 1. Unzip template
mkdir -p "$OUTPUT_DIR" "$WORK_DIR"
unzip -q "$TEMPLATE_PATH" -d "$WORK_DIR"

# 2. Binary-patch date, currency, descriptions; write amounts sidecar
CLIENT_INFO=${CLIENT_INFO:-''}
python3 "$SCRIPTS/patch-invoice.py" "$WORK_DIR" "$NEW_DATE" "$CURRENCY" "$ITEMS_JSON" "$CLIENT_INFO"

# 3. Re-zip. The .applescript helpers live in WORK_DIR but must stay out of the
# archive, and Numbers rejects bare directory entries, hence -D.
cd "$WORK_DIR"
zip -r -X -D "$PATCHED" . -x '*.applescript' > /dev/null
cd - > /dev/null

# 4. Open in Numbers, set amounts via AppleScript if sidecar exists, export PDF
SIDECAR="${WORK_DIR}/_set_amounts.applescript"
RUNNER="${WORK_DIR}/_run_invoice.applescript"

# Build full AppleScript as a file (avoids bash heredoc interpolation issues)
if [[ -f "$SIDECAR" ]]; then
  AMOUNTS_BODY=$(cat "$SIDECAR")
else
  AMOUNTS_BODY=""
fi

cat > "$RUNNER" << EOF
set patchedPath to POSIX file "${PATCHED}"
set outputPath to POSIX file "${OUTPUT_PATH}"
tell application "Numbers" to activate
delay 2
tell application "Numbers"
    open patchedPath
    delay 4
    tell front document
        tell sheet 1
            tell table 1
${AMOUNTS_BODY}
            end tell
        end tell
    end tell
    delay 1
    export front document to outputPath as PDF
    close front document saving no
end tell
EOF

osascript "$RUNNER"

# 5. Cleanup
rm -rf "$WORK_DIR" "$PATCHED"
echo "Saved to: $OUTPUT_PATH"
