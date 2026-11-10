"""
Makes fixtures/xlsx/features.xlsx: a workbook with the things beyond cells and formatting that the
spreadsheet reader carries over: charts, a table whose formulas name its columns, a filter, row and
column groups, validation rules, conditional formatting rules of every kind, indents and number
formats with Excel-only tags. Needs Python with openpyxl.

    python3 scripts/make-xlsx-features-fixture.py fixtures/xlsx/features.xlsx
"""
import sys
import datetime
from openpyxl import Workbook
from openpyxl.chart import BarChart, LineChart, PieChart, ScatterChart, Reference, Series
from openpyxl.formatting.rule import Rule, DataBarRule
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.styles.differential import DifferentialStyle
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.worksheet.table import Table, TableStyleInfo

wb = Workbook()
ws = wb.active
ws.title = "Sales"
ws.append(["Region", "Units", "Price", "Revenue"])
for region, units, price in [("North", 120, 9.5), ("South", 80, 11), ("East", 150, 8.25), ("West", 60, 12), ("Central", 95, 10), ("Coast", 130, 9)]:
    ws.append([region, units, price, None])
for r in range(2, 8):
    ws.cell(row=r, column=4, value="=Sales[[#This Row],[Units]]*Sales[[#This Row],[Price]]")
table = Table(displayName="Sales", ref="A1:D7")
table.tableStyleInfo = TableStyleInfo(name="TableStyleMedium2", showRowStripes=True)
ws.add_table(table)
ws["F1"] = "=SUM(Sales[Revenue])"
ws["F2"] = "=AVERAGE(Sales[Units])"
ws["F3"] = "=COUNTA(Sales[#Headers])"
ws["F4"] = "=SUM(Sales[[Units]:[Price]])"
ws["F5"] = '=COUNTIF(Sales[Region],"North")&" in [brackets]"'

bar = BarChart()
bar.type = "col"
bar.title = "Revenue by region"
bar.x_axis.title = "Region"
bar.y_axis.title = "Revenue"
bar.add_data(Reference(ws, min_col=4, min_row=1, max_row=7), titles_from_data=True)
bar.set_categories(Reference(ws, min_col=1, min_row=2, max_row=7))
ws.add_chart(bar, "H2")

line = LineChart()
line.title = "Units and price"
line.add_data(Reference(ws, min_col=2, max_col=3, min_row=1, max_row=7), titles_from_data=True)
line.set_categories(Reference(ws, min_col=1, min_row=2, max_row=7))
line.legend.position = "b"
ws.add_chart(line, "H20")

pie = PieChart()
pie.title = "Share of units"
pie.add_data(Reference(ws, min_col=2, min_row=1, max_row=7), titles_from_data=True)
pie.set_categories(Reference(ws, min_col=1, min_row=2, max_row=7))
ws.add_chart(pie, "Q2")

stacked = BarChart()
stacked.type = "bar"
stacked.grouping = "stacked"
stacked.overlap = 100
stacked.add_data(Reference(ws, min_col=2, max_col=3, min_row=1, max_row=7), titles_from_data=True)
stacked.set_categories(Reference(ws, min_col=1, min_row=2, max_row=7))
stacked.legend = None
ws.add_chart(stacked, "Q20")

scatter = ScatterChart()
scatter.title = "Price against units"
xs = Reference(ws, min_col=2, min_row=2, max_row=7)
ys = Reference(ws, min_col=3, min_row=2, max_row=7)
scatter.series.append(Series(ys, xs, title="Price"))
ws.add_chart(scatter, "H38")

rules = wb.create_sheet("Rules")
for i, v in enumerate([5, 12, 7, 12, 30, 3, 18, 9, 25, 1, 14, 7], start=1):
    rules.cell(row=i, column=1, value=v)
red = DifferentialStyle(fill=PatternFill("solid", bgColor="FFFFC7CE"), font=Font(color="FF9C0006"))
green = DifferentialStyle(fill=PatternFill("solid", bgColor="FFC6EFCE"), font=Font(color="FF006100", bold=True))
rules.conditional_formatting.add("A1:A12", Rule(type="top10", rank=3, dxf=green, priority=1))
rules.conditional_formatting.add("A1:A12", Rule(type="top10", rank=25, percent=True, bottom=True, dxf=red, priority=2))
rules.conditional_formatting.add("A1:A12", Rule(type="aboveAverage", aboveAverage=False, dxf=red, priority=3))
rules.conditional_formatting.add("A1:A12", Rule(type="duplicateValues", dxf=red, priority=4))
rules.conditional_formatting.add("A1:A12", Rule(type="containsErrors", dxf=red, priority=5))
rules.conditional_formatting.add("A1:A12", DataBarRule(start_type="min", end_type="max", color="FF638EC6"))

def validation(cell, **kw):
    dv = DataValidation(**kw)
    rules.add_data_validation(dv)
    dv.add(cell)

validation("C1:C5", type="whole", operator="between", formula1="1", formula2="10", showErrorMessage=True, showInputMessage=True, prompt="A whole number from 1 to 10")
validation("C6", type="decimal", operator="greaterThan", formula1="0", showErrorMessage=True, errorStyle="warning")
validation("C7", type="date", operator="greaterThanOrEqual", formula1="45292", showErrorMessage=True)
validation("C8", type="textLength", operator="lessThanOrEqual", formula1="5", showErrorMessage=True)
validation("C9", type="custom", formula1="ISNUMBER(C9)", showErrorMessage=True)
validation("C10", type="list", formula1='"yes,no"', showErrorMessage=True)

rules["E1"] = "indented twice"
rules["E1"].alignment = Alignment(indent=2)
rules["E2"] = "from the right"
rules["E2"].alignment = Alignment(horizontal="right", indent=1)
rules["E3"] = datetime.date(2024, 3, 9)
rules["E3"].number_format = "[$-409]mmmm d, yyyy"
rules["E4"] = 1234.5
rules["E4"].number_format = "[$€-407] #,##0.00"
rules["E5"] = 7
rules["E5"].number_format = 'General "units"'
rules["E6"] = 0.25
rules["E6"].number_format = "[DBNum1]0.0%"

for r in range(3, 7):
    rules.row_dimensions[r].outlineLevel = 1
for r in range(4, 6):
    rules.row_dimensions[r].outlineLevel = 2
for r in range(9, 12):
    rules.row_dimensions[r].outlineLevel = 1
    rules.row_dimensions[r].hidden = True
rules.column_dimensions.group("H", "J", outline_level=1)
rules.row_dimensions[14].hidden = True

for c, v in enumerate(["Name", "Team", "Score"], start=5):
    rules.cell(row=16, column=c, value=v)
for r, row in enumerate([("Ann", "Red", 8), ("Bo", "Blue", 6), ("Cy", "Red", 9)], start=17):
    for c, v in enumerate(row, start=5):
        rules.cell(row=r, column=c, value=v)
rules.auto_filter.ref = "E16:G19"

wb.save(sys.argv[1])
