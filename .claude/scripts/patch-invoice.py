#!/usr/bin/env python3
"""Patches date, currency, and line items in a Numbers invoice template.

Usage:
  patch-invoice.py <work_dir> <new_date> <currency> [<items_json>]

items_json: JSON array of {description, amount} objects e.g.
  '[{"description":"Professional Services","amount":5880}]'
"""
import sys, re, pathlib, json, subprocess, os, textwrap

work_dir = sys.argv[1]
new_date = sys.argv[2]
currency = sys.argv[3][:3].upper().encode()
items = json.loads(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] else None
client_info = json.loads(sys.argv[5]) if len(sys.argv) > 5 and sys.argv[5] else None

tables = pathlib.Path(work_dir) / "Index" / "Tables"

# --- Patch date (plain text replacement in DataList-905252.iwa) ---
date_file = tables / "DataList-905252.iwa"
data = date_file.read_bytes()
if not re.search(rb'Submitted on \d{2}/20/\d{2}', data):
    print("WARNING: date pattern not found", file=sys.stderr)
    sys.exit(1)
data = re.sub(rb'Submitted on \d{2}/20/\d{2}', new_date.encode(), data)

date_file.write_bytes(data)
print(f"Patched date: {new_date}")

# Client fields are NOT binary-patched. The .iwa files are Snappy-framed with
# byte-length headers, so any replacement that changes length desyncs the frame
# and makes Numbers crash on open. Only same-length edits (date, currency) are
# safe here; everything else is set through the AppleScript sidecar below.

# --- Patch currency in DataList-905255.iwa ---
curr_file = tables / "DataList-905255.iwa"
data = curr_file.read_bytes()
data = data.replace(b'\x1a\x03MXN ', b'\x1a\x03' + currency + b' ', 1)
curr_file.write_bytes(data)

# --- Patch currency in Document.iwa ---
doc_file = pathlib.Path(work_dir) / "Index" / "Document.iwa"
data = doc_file.read_bytes()
data = data.replace(b'\x03MXN', b'\x03' + currency, 1)
doc_file.write_bytes(data)
print(f"Patched currency: {currency.decode()}")

# --- Write AppleScript sidecar to set text cells after Numbers opens ---
# Template cell map (each label is duplicated across the columns listed, which
# is how the template renders one wrapped block spanning them):
#   r5  c2-c4 : "Email: <your address>"      r12 c2-c3 : client company
#   r16 c2-c3 : "email: <client address>"    r20-24    : line items
#   r27 c2    : payment info
if items or client_info:
    lines = []
    MAX_ROWS = 5  # template has rows 20-24 for items (rows 25+ are totals/footer)
    # Template layout: description spans cols 2+3+4, qty=col5, amount=col7, first data row=20
    FIRST_ROW = 20
    DESC_COLS = [2, 3, 4]
    QTY_COL, AMT_COL = 5, 7
    def as_string(text):
        """Quote a Python string as an AppleScript literal, newlines included."""
        parts = text.replace('"', '\\"').split('\n')
        return ' & return & '.join(f'"{p}"' for p in parts)

    def set_cells(row, cols, text):
        """Write the label, then blank the rest of its merged span.

        These label rows are merged regions. Writing every column renders each
        one as its own clipped box, and leaving a space in the trailing columns
        stops the text spilling across, so only the first column gets the value
        and the others are emptied outright.
        """
        first, rest = cols[0], cols[1:]
        lines.append(f'set value of cell {first} of row {row} to {as_string(text)}')
        for c in rest:
            lines.append(f'set value of cell {c} of row {row} to ""')

    # Clear all data rows first
    for r in range(FIRST_ROW, FIRST_ROW + MAX_ROWS):
        for c in DESC_COLS:
            lines.append(f'set value of cell {c} of row {r} to ""')
        lines.append(f'set value of cell {QTY_COL} of row {r} to ""')
        lines.append(f'set value of cell {AMT_COL} of row {r} to ""')
    # Set actual items — description only in col 2, cols 3+4 stay empty
    for i, item in enumerate(items or []):
        row = FIRST_ROW + i
        desc = item.get('description', '').replace('"', '\\"')
        amt = float(item.get('amount', 0))
        qty = int(item.get('qty', 1))
        lines.append(f'set value of cell 2 of row {row} to "{desc}"')
        lines.append(f'set value of cell {QTY_COL} of row {row} to {qty}')
        lines.append(f'set value of cell {AMT_COL} of row {row} to {amt}')
    if client_info:
        def wrap(text, width):
            """Break an address to the cell's width. These merged cells clip
            instead of wrapping, so the line breaks have to be explicit — the
            template ships its own address pre-broken for the same reason.
            Any breaks the user typed are kept."""
            out = []
            for para in text.split('\n'):
                out.extend(textwrap.wrap(para, width) or [''])
            return '\n'.join(out)

        def set_field(row, cols, key, prefix='', wrap_at=0):
            """Write unconditionally: an unset field has to blank the cell,
            otherwise the template's own placeholder shows up on the invoice
            as if it were this client's data."""
            value = (client_info.get(key) or '').strip()
            if not value:
                return set_cells(row, cols, '')
            text = f'{prefix}{value}'
            set_cells(row, cols, wrap(text, wrap_at) if wrap_at else text)

        # Both blocks live on the client record rather than in the template,
        # since each client is billed under different details on both sides.
        set_field(3, [2, 3, 4], 'my_name')
        set_field(4, [2, 3, 4], 'my_id', 'Id: ')
        set_field(5, [2, 3, 4], 'my_email', 'Email: ')
        set_field(6, [2, 3], 'my_phone', 'Cellphone: ')
        # Left unwrapped: this row is a single fixed-height line that spills
        # into the empty cells beside it, so an extra line would be cut off.
        set_field(7, [2, 3], 'my_address', 'Address: ')

        set_field(12, [2, 3], 'company_name')
        set_field(13, [2, 3], 'payer_address', wrap_at=28)
        set_field(14, [2, 3], 'payer_phone', 'Phone: ')
        set_field(15, [2, 3], 'payer_id', 'Id: ')
        set_field(16, [2, 3], 'payer_email', 'email: ')

        set_field(27, [2, 3, 4, 5], 'payment_info')

    sidecar = '\n'.join(lines)
    sidecar_path = pathlib.Path(work_dir) / "_set_amounts.applescript"
    sidecar_path.write_text(sidecar)
    print(f"Wrote sidecar: {len(items or [])} items, {len(lines)} cell writes")
