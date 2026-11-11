# 用 python-docx、openpyxl 生成两份小样例（第二种办法），和测试里手搭的同内容文件对照。
# 只在生成样例时用，不是仓库依赖。重新生成：
#   python -m venv venv && venv/Scripts/python -m pip install python-docx openpyxl
#   venv/Scripts/python make_samples.py
# 生成时用的版本：python-docx 1.2.0、openpyxl 3.1.5。
import datetime
import os

import docx
import openpyxl

here = os.path.dirname(os.path.abspath(__file__))

d = docx.Document()
d.add_heading("周报", 0)
d.add_heading("本周进展", 1)
p = d.add_paragraph()
p.add_run("新首页").bold = True
p.add_run("按计划").italic = True
p.add_run("推进。")
r = d.add_paragraph().add_run("A & B <C>")
r.add_tab()
r.add_text("D")
r.add_break()
r.add_text("第二行")
d.add_paragraph("首页", style="List Bullet")
d.add_paragraph("右栏", style="List Bullet")
d.add_paragraph("先对样例", style="List Number")
d.add_paragraph("再上预发", style="List Number")
d.add_heading("细节", 2)
t = d.add_table(rows=2, cols=2)
for (i, j), text in {(0, 0): "事项", (0, 1): "进展评估", (1, 0): "新首页", (1, 1): "良好"}.items():
    t.cell(i, j).text = text
d.save(os.path.join(here, "python-docx.docx"))

wb = openpyxl.Workbook()
ws = wb.active
ws.title = "预算"
ws.append(["项目", "金额", "日期"])
ws.append(["新首页", 1200, datetime.datetime(2026, 11, 11)])
ws.append(["右栏", 800.5, datetime.datetime(2026, 11, 11, 12)])
ws.append(["合计", "=SUM(B2:B3)", True])
ws["A6"] = "合并说明"
ws.merge_cells("A6:B6")
note = wb.create_sheet("备注")
note["B2"] = "隐藏表里的字"
note.sheet_state = "hidden"
wb.save(os.path.join(here, "openpyxl.xlsx"))
