import sys
from openpyxl import Workbook
from openpyxl.worksheet.table import Table, TableStyleInfo
from openpyxl.utils import get_column_letter as L
wb = Workbook()
ws = wb.active; ws.title = "Styles"
names = [f"TableStyleLight{i}" for i in range(1, 22)] + [f"TableStyleMedium{i}" for i in range(1, 29)] + [f"TableStyleDark{i}" for i in range(1, 12)]
for k, name in enumerate(names):
    c0 = 1 + k * 4
    short = name.replace("TableStyle", "")
    for j in range(3): ws.cell(1, c0 + j, f"{short}{'abc'[j]}")
    for r in range(2, 6):
        ws.cell(r, c0, f"row{r-1}"); ws.cell(r, c0 + 1, r * 10); ws.cell(r, c0 + 2, r * 1.5)
    t = Table(displayName=f"T{k+1}", ref=f"{L(c0)}1:{L(c0+2)}5")
    t.tableStyleInfo = TableStyleInfo(name=name, showFirstColumn=False, showLastColumn=False, showRowStripes=True, showColumnStripes=False)
    ws.add_table(t)
ws2 = wb.create_sheet("Options")
opts = [("M2 first+last col", dict(showFirstColumn=True, showLastColumn=True, showRowStripes=True, showColumnStripes=False)),
        ("M2 col stripes", dict(showFirstColumn=False, showLastColumn=False, showRowStripes=False, showColumnStripes=True)),
        ("M2 no stripes", dict(showFirstColumn=False, showLastColumn=False, showRowStripes=False, showColumnStripes=False)),
        ("M9 first col", dict(showFirstColumn=True, showLastColumn=False, showRowStripes=True, showColumnStripes=False)),
        ("L9 both stripes", dict(showFirstColumn=False, showLastColumn=False, showRowStripes=True, showColumnStripes=True))]
for k, (label, o) in enumerate(opts):
    c0 = 1 + k * 4
    for j in range(3): ws2.cell(1, c0 + j, f"O{k+1}{'abc'[j]}")
    for r in range(2, 7):
        ws2.cell(r, c0, f"row{r-1}"); ws2.cell(r, c0 + 1, r * 10); ws2.cell(r, c0 + 2, r * 1.5)
    style = "TableStyleMedium9" if label.startswith("M9") else "TableStyleLight9" if label.startswith("L9") else "TableStyleMedium2"
    t = Table(displayName=f"O{k+1}", ref=f"{L(c0)}1:{L(c0+2)}6")
    t.tableStyleInfo = TableStyleInfo(name=style, **o)
    ws2.add_table(t)
# a table with a totals row
c0 = 1 + len(opts) * 4
for j in range(3): ws2.cell(1, c0 + j, f"Tot{'abc'[j]}")
for r in range(2, 6):
    ws2.cell(r, c0, f"row{r-1}"); ws2.cell(r, c0 + 1, r * 10); ws2.cell(r, c0 + 2, r * 1.5)
ws2.cell(6, c0, "Total"); ws2.cell(6, c0 + 2, f"=SUBTOTAL(109,{L(c0+2)}2:{L(c0+2)}5)")
t = Table(displayName="Tot", ref=f"{L(c0)}1:{L(c0+2)}6", totalsRowCount=1)
t.tableStyleInfo = TableStyleInfo(name="TableStyleMedium2", showFirstColumn=False, showLastColumn=False, showRowStripes=True, showColumnStripes=False)
t.autoFilter = None
ws2.add_table(t)
wb.save(sys.argv[1])
