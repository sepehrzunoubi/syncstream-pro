"""
Makes fixtures/xlsx/kitchen-sink.xlsx, the workbook the spreadsheet tests read: every kind of
formatting, formula and sheet setting the reader carries over. Needs Python with openpyxl.

    python3 scripts/make-xlsx-fixture.py fixtures/xlsx/kitchen-sink.xlsx

The tests' expectations for it are what Google's own import of this file gave, so changing it
means measuring that again.
"""
import sys, datetime
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Border, Side, Alignment, Color
from openpyxl.comments import Comment
from openpyxl.cell.rich_text import CellRichText, TextBlock
from openpyxl.cell.text import InlineFont
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.formatting.rule import CellIsRule, ColorScaleRule
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.worksheet.formula import ArrayFormula
wb=Workbook(); ws=wb.active; ws.title="Formats"
# fonts
ws["A1"]="Default"; 
ws["B1"]="Arial10"; ws["B1"].font=Font(name="Arial",size=10)
ws["C1"]="TNR14bi"; ws["C1"].font=Font(name="Times New Roman",size=14,bold=True,italic=True)
ws["D1"]="under"; ws["D1"].font=Font(underline="single")
ws["E1"]="dbl"; ws["E1"].font=Font(underline="double")
ws["F1"]="strike"; ws["F1"].font=Font(strike=True,color="FFFF0000")
ws["G1"]="theme4"; ws["G1"].font=Font(color=Color(theme=4))
ws["H1"]="theme4tint"; ws["H1"].font=Font(color=Color(theme=4,tint=0.4),name="Georgia",size=9)
ws["I1"]="Courier"; ws["I1"].font=Font(name="Courier New",size=12)
ws["J1"]="super"; ws["J1"].font=Font(vertAlign="superscript")
# fills
ws["A2"]="yellow"; ws["A2"].fill=PatternFill("solid",fgColor="FFFFFF00")
ws["B2"]="theme5"; ws["B2"].fill=PatternFill("solid",fgColor=Color(theme=5))
ws["C2"]="theme5t"; ws["C2"].fill=PatternFill("solid",fgColor=Color(theme=5,tint=0.6))
ws["D2"]="gray125"; ws["D2"].fill=PatternFill("gray125")
ws["E2"]="dark-"; ws["E2"].fill=PatternFill("solid",fgColor=Color(theme=1,tint=-0.25))
ws["F2"]="indexed"; ws["F2"].fill=PatternFill("solid",fgColor=Color(indexed=10))
# borders
styles=["thin","medium","thick","dashed","dotted","double","hair","mediumDashed","dashDot","mediumDashDot","dashDotDot","slantDashDot"]
for i,s in enumerate(styles):
    c=ws.cell(row=4,column=1+i,value=s); c.border=Border(bottom=Side(style=s,color="FF0000FF"))
ws["A6"]="box"; ws["A6"].border=Border(left=Side(style="thin"),right=Side(style="medium",color="FFFF0000"),top=Side(style="thick",color=Color(theme=4)),bottom=Side(style="double"))
ws["C6"]="L"; ws["C6"].border=Border(right=Side(style="thin",color="FF00AA00"))
ws["D6"]="R"; ws["D6"].border=Border(left=Side(style="thick",color="FFAA0000"))
# alignment
for i,(h) in enumerate(["left","center","right","justify","fill","centerContinuous","distributed","general"]):
    c=ws.cell(row=8,column=1+i,value=h); c.alignment=Alignment(horizontal=h)
for i,(v) in enumerate(["top","center","bottom","justify","distributed"]):
    c=ws.cell(row=9,column=1+i,value=v); c.alignment=Alignment(vertical=v)
ws.row_dimensions[9].height=40
ws["A10"]="wrap this long text please ok"; ws["A10"].alignment=Alignment(wrap_text=True)
ws["B10"]="shrink this long text please"; ws["B10"].alignment=Alignment(shrink_to_fit=True)
ws["C10"]="indent2"; ws["C10"].alignment=Alignment(indent=2)
ws["D10"]="rot45"; ws["D10"].alignment=Alignment(text_rotation=45)
ws["E10"]="rot90"; ws["E10"].alignment=Alignment(text_rotation=90)
ws["F10"]="rot-45"; ws["F10"].alignment=Alignment(text_rotation=135)
ws["G10"]="vert"; ws["G10"].alignment=Alignment(text_rotation=255)
ws["H10"]="indR"; ws["H10"].alignment=Alignment(horizontal="right",indent=1)
ws["I10"]="overflow text that is long enough to spill"
ws["J10"]=12345678901234
# number formats
fmts=["General","0","0.00","#,##0","#,##0.00","0%","0.00%","0.00E+00","# ?/?","m/d/yyyy","d-mmm-yy","h:mm AM/PM","h:mm:ss","m/d/yyyy h:mm","@",'"$"#,##0.00','_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)','[Red]-0.0;[Blue]0.0','0.0,"k"','yyyy-mm-dd','[h]:mm','#,##0_);(#,##0)','mmm yyyy','dddd','0.000']
for i,f in enumerate(fmts):
    c=ws.cell(row=12+i,column=1,value=f if f!="@" else "@fmt"); 
    v=ws.cell(row=12+i,column=2,value=45123.5678 if i!=14 else "0123"); v.number_format=f
    n=ws.cell(row=12+i,column=3,value=-1234.5); n.number_format=f
    z=ws.cell(row=12+i,column=4,value=0); z.number_format=f
# values
ws["F12"]=True; ws["F13"]=False; ws["F14"]="=1/0"; ws["F15"]="=NA()"; ws["F16"]="  lead"; ws["F17"]="0123"; ws["F18"]=datetime.date(2024,2,29); ws["F19"]=datetime.datetime(2024,2,29,13,45,10); ws["F20"]=datetime.time(8,30); ws["F21"]=1e-7; ws["F22"]=0.1+0.2; ws["F23"]="=text"; ws["F23"].data_type="s"; ws["F24"]="line1\nline2"; ws["F25"]=""
# formulas
ws["H12"]=1; ws["H13"]=2; ws["H14"]=3; ws["H15"]="=SUM(H12:H14)"; ws["I12"]="=H12*2"; ws["I13"]="=H13*2"; ws["I14"]="=H14*2"; ws["I15"]="=SUM(I12:I14)"
ws["H16"]="=H15/$I$15"; ws["H17"]='=IF(H15>5,"big","small")'; ws["H18"]='="a"&"b"'; ws["H19"]="=Data!B2+Data!B3"; ws["H20"]="=VLOOKUP(2,Data!A2:B4,2,FALSE)"; ws["H21"]="=SUM(Data!B:B)"; ws["H22"]="=TotalData*2"
ws["H23"]=ArrayFormula("H23", "=SUM(H12:H14*I12:I14)")
ws["H24"]="=_xlfn.IFS(H12=1,\"one\",TRUE,\"other\")"; ws["H25"]="=TODAY()-TODAY()"; ws["H26"]="=AVERAGE(H12:H14)"; ws["H27"]="=H12=1"
# merges
ws.merge_cells("K1:M1"); ws["K1"]="merged 3"; ws["K1"].alignment=Alignment(horizontal="center"); ws["K1"].fill=PatternFill("solid",fgColor="FFDDEBF7")
ws.merge_cells("K3:L5"); ws["K3"]="block"; ws["K3"].alignment=Alignment(horizontal="center",vertical="center"); ws["K3"].border=Border(left=Side(style="thin"),top=Side(style="thin"))
# hyperlink, comment, rich
ws["K7"]="link"; ws["K7"].hyperlink="https://example.com/x"; ws["K7"].font=Font(color="FF0563C1",underline="single")
ws["K8"]="note"; ws["K8"].comment=Comment("a note here","Author")
ws["K9"]=CellRichText("plain ",TextBlock(InlineFont(b=True),"bold "),TextBlock(InlineFont(i=True,color="FFFF0000",sz=14),"red-it"))
# dims
for col,w in [("A",5),("B",8.43),("C",10),("D",20),("E",50),("F",12.63),("G",1),("L",30.5)]: ws.column_dimensions[col].width=w
for r,h in [(2,10),(4,15),(6,30),(8,60),(10,45),(11,12.75)]: ws.row_dimensions[r].height=h
ws.column_dimensions["N"].hidden=True; ws.row_dimensions[40].hidden=True
ws.freeze_panes="B2"; ws.sheet_properties.tabColor="FF00B050"
dv=DataValidation(type="list",formula1='"a,b,c"',allow_blank=True); ws.add_data_validation(dv); dv.add("K11"); ws["K11"]="a"
ws.conditional_formatting.add("H12:H14",CellIsRule(operator="greaterThan",formula=["1"],fill=PatternFill("solid",bgColor="FFFFC7CE"),font=Font(color="FF9C0006")))
ws.conditional_formatting.add("I12:I14",ColorScaleRule(start_type="min",start_color="FFF8696B",end_type="max",end_color="FF63BE7B"))
# sheet 2
d=wb.create_sheet("Data"); d.sheet_view.showGridLines=False
d.append(["id","val"]); d.append([1,10]); d.append([2,20]); d.append([3,30.5])
d["A1"].font=Font(bold=True); d["B1"].font=Font(bold=True)
d.column_dimensions["A"].width=14; d.sheet_format.defaultColWidth=9; d.sheet_format.defaultRowHeight=18; d.sheet_format.customHeight=True
d.freeze_panes="A2"
wb.defined_names["TotalData"]=DefinedName("TotalData",attr_text="Data!$B$4")
h=wb.create_sheet("Hidden sheet"); h["A1"]="secret"; h.sheet_state="hidden"
q=wb.create_sheet("Q'uote & co"); q["A1"]="=Formats!H15"; q["B2"]=5; q.sheet_view.rightToLeft=False; q.sheet_view.zoomScale=120
wb.save(sys.argv[1])
