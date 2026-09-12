"""
把「学院赛设计方案」排版成 Word 文档。

用法：
    python tools/college-design-to-docx.py [输出.docx]

依赖 python-docx。默认输出到仓库根目录的「学院赛设计方案.docx」。
本文件是设计阶段的决策汇总，用于指导后续学院赛的开发；落地实现后
请把它与代码一起更新，避免设计与实现脱节。
"""

import sys

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

BODY_EA = "宋体"
HEAD_EA = "微软雅黑"
ASCII_FONT = "Times New Roman"
ACCENT = RGBColor(0x1F, 0x4E, 0x79)
MUTED = RGBColor(0x59, 0x59, 0x59)
HEAD_FILL = "1F4E79"

COLLEGES = [
    "中华民族共同体学院",
    "民族学与社会学学院",
    "中国少数民族语言文学学院",
    "文学院",
    "历史文化学院",
    "哲学与宗教学院",
    "新闻与传播学院",
    "外国语学院",
    "马克思主义学院",
    "经济学院",
    "管理学院",
    "法学院",
    "生命与环境科学学院",
    "药学院",
    "理学院",
    "信息工程学院",
    "音乐学院",
    "舞蹈学院",
    "美术学院",
    "体育学院",
    "教育学院",
    "国际教育学院",
    "海南国际学院",
    "预科教育学院",
    "继续教育学院（干部培训部）",
    "藏学研究院",
]


def set_font(run, size=10.5, bold=False, color=None, ea=BODY_EA, ascii_font=ASCII_FONT):
    run.font.name = ascii_font
    run.font.size = Pt(size)
    run.font.bold = bold
    if color is not None:
        run.font.color.rgb = color
    run._element.rPr.rFonts.set(qn("w:eastAsia"), ea)


def shade(cell, color):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:fill"), color)
    tc_pr.append(shd)


def heading(doc, text, level=1):
    sizes = {1: 16, 2: 13, 3: 11.5}
    paragraph = doc.add_paragraph()
    paragraph.paragraph_format.space_before = Pt(14 if level == 1 else 10)
    paragraph.paragraph_format.space_after = Pt(6)
    run = paragraph.add_run(text)
    set_font(run, size=sizes.get(level, 11.5), bold=True, color=ACCENT, ea=HEAD_EA)
    return paragraph


def para(doc, text, bold=False, muted=False, size=10.5):
    paragraph = doc.add_paragraph()
    paragraph.paragraph_format.space_after = Pt(4)
    paragraph.paragraph_format.line_spacing = 1.25
    run = paragraph.add_run(text)
    set_font(run, size=size, bold=bold, color=MUTED if muted else None)
    return paragraph


def bullet(doc, text, level=0):
    paragraph = doc.add_paragraph(style="List Bullet")
    paragraph.paragraph_format.left_indent = Cm(0.75 + 0.6 * level)
    paragraph.paragraph_format.space_after = Pt(2)
    paragraph.paragraph_format.line_spacing = 1.25
    run = paragraph.add_run(text)
    set_font(run)
    return paragraph


def numbered(doc, text):
    paragraph = doc.add_paragraph(style="List Number")
    paragraph.paragraph_format.left_indent = Cm(0.75)
    paragraph.paragraph_format.space_after = Pt(2)
    paragraph.paragraph_format.line_spacing = 1.25
    run = paragraph.add_run(text)
    set_font(run)
    return paragraph


def table(doc, headers, rows, widths=None):
    tbl = doc.add_table(rows=1, cols=len(headers))
    tbl.style = "Table Grid"
    tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
    head_cells = tbl.rows[0].cells
    for index, text in enumerate(headers):
        head_cells[index].text = ""
        run = head_cells[index].paragraphs[0].add_run(text)
        set_font(run, size=10, bold=True, color=RGBColor(0xFF, 0xFF, 0xFF), ea=HEAD_EA)
        head_cells[index].paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.CENTER
        shade(head_cells[index], HEAD_FILL)

    for row in rows:
        cells = tbl.add_row().cells
        for index, value in enumerate(row):
            cells[index].text = ""
            run = cells[index].paragraphs[0].add_run(str(value))
            set_font(run, size=9.5)
            cells[index].paragraphs[0].paragraph_format.line_spacing = 1.15

    if widths:
        for row in tbl.rows:
            for index, width in enumerate(widths):
                row.cells[index].width = Cm(width)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)
    return tbl


def callout(doc, text, label="提示"):
    paragraph = doc.add_paragraph()
    paragraph.paragraph_format.left_indent = Cm(0.4)
    paragraph.paragraph_format.space_before = Pt(4)
    paragraph.paragraph_format.space_after = Pt(6)
    run_label = paragraph.add_run(f"【{label}】")
    set_font(run_label, size=10, bold=True, color=ACCENT)
    run = paragraph.add_run(text)
    set_font(run, size=10)
    p_pr = paragraph._p.get_or_add_pPr()
    borders = OxmlElement("w:pBdr")
    left = OxmlElement("w:left")
    left.set(qn("w:val"), "single")
    left.set(qn("w:space"), "6")
    left.set(qn("w:sz"), "18")
    left.set(qn("w:color"), "1F4E79")
    borders.append(left)
    p_pr.append(borders)
    return paragraph


def college_grid(doc):
    rows = []
    for start in range(0, len(COLLEGES), 3):
        chunk = COLLEGES[start:start + 3]
        row = []
        for offset in range(3):
            if offset < len(chunk):
                row.extend([str(start + offset + 1), chunk[offset]])
            else:
                row.extend(["", ""])
        rows.append(row)
    table(
        doc,
        ["#", "学院", "#", "学院", "#", "学院"],
        rows,
        widths=[1.0, 4.4, 1.0, 4.4, 1.0, 4.4],
    )


def build():
    doc = Document()

    section = doc.sections[0]
    section.page_height = Cm(29.7)
    section.page_width = Cm(21)
    section.top_margin = Cm(2.2)
    section.bottom_margin = Cm(2.2)
    section.left_margin = Cm(2.4)
    section.right_margin = Cm(2.4)

    normal = doc.styles["Normal"]
    normal.font.name = ASCII_FONT
    normal.font.size = Pt(10.5)
    normal._element.rPr.rFonts.set(qn("w:eastAsia"), BODY_EA)

    # ---------------- 封面标题区 ----------------
    title = doc.add_paragraph()
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    title.paragraph_format.space_after = Pt(2)
    run = title.add_run("中央民族大学匹克球俱乐部小程序")
    set_font(run, size=13, bold=True, color=MUTED, ea=HEAD_EA)

    subtitle = doc.add_paragraph()
    subtitle.alignment = WD_ALIGN_PARAGRAPH.CENTER
    subtitle.paragraph_format.space_after = Pt(2)
    run = subtitle.add_run("学院赛设计方案")
    set_font(run, size=26, bold=True, color=ACCENT, ea=HEAD_EA)

    tagline = doc.add_paragraph()
    tagline.alignment = WD_ALIGN_PARAGRAPH.CENTER
    tagline.paragraph_format.space_after = Pt(12)
    run = tagline.add_run("学院身份 · 学院负责人 · 名单制报名 · 大场对阵 · 单打只计 ELO")
    set_font(run, size=11, color=MUTED)

    table(
        doc,
        ["项目", "说明"],
        [
            ["文档定位", "设计决策汇总，用于指导学院赛的后续开发；不含代码改动"],
            ["讨论结论", "32 项决策已确认，遗留 3 项待定（见第十章）"],
            ["与现有赛事关系", "学院赛独立成体系；个人赛全部保留，一级赛依然可以是个人赛"],
            ["学院名单", "26 所学院，来自学校现行院系设置；不再保留「其他」选项"],
            ["计分口径", "学院赛单打小项只计个人 ELO（按一级口径），不计赛事积分；双打小项不计分"],
        ],
        widths=[3.2, 13.0],
    )

    # ---------------- 一、目标与范围 ----------------
    heading(doc, "一、目标与范围", 1)
    para(doc, "现在的赛事是「以个人为单位」的：一个人报名、一个人进签表、一个人的等级分与积分。接下来要新增一类「以学院为单位」的比赛——学院赛：两个学院之间的一场对抗由多场小项比赛组成，参赛单位是学院。")
    para(doc, "同时，干事（STAFF）的定位正式明确为「学院负责人」：他只管自己学院的事，不再是一个全局管理员。")

    heading(doc, "1.1 学院赛与个人赛并行", 2)
    para(doc, "讨论中明确把学院团体赛与一级赛事分开，学院赛单列为一个独立体系，不去改造现有个人赛框架。个人赛（单败/循环/小组+淘汰/循环+淘汰/双败/小组+双败）全部保留，一级赛事以后依然可以是个人赛。")
    callout(doc, "学院赛内单打小项的个人 ELO 按「一级赛事」的 K 值（32）计算。借用的是一级赛事的等级分规则，而不是把学院赛做成一条一级赛事记录；学院赛不产生赛事积分。", "说明")

    heading(doc, "1.2 本期边界", 2)
    bullet(doc, "本期只做设计，不写代码；文档确认后再分期开发。")
    bullet(doc, "只覆盖学院赛，不顺手改个人赛的赛制与页面。")
    bullet(doc, "遗留待定项集中在第十章，未拍板前不进入开发。")

    # ---------------- 二、决策汇总 ----------------
    heading(doc, "二、已确认决策汇总", 1)
    para(doc, "以下 27 条来自两轮讨论，作为后续设计与开发的基线。编号在文档内引用。")

    heading(doc, "2.1 架构与定位", 2)
    table(
        doc,
        ["编号", "决策"],
        [
            ["D1", "学院团体赛与一级赛事分开，学院赛单列为一个独立体系"],
            ["D2", "个人赛全部保留；一级赛事以后依然可以是个人赛，两者并行"],
            ["D3", "学院赛与个人赛互不影响：不改动个人赛的报名、签表与计分"],
        ],
        widths=[1.6, 14.6],
    )

    heading(doc, "2.2 学院身份", 2)
    table(
        doc,
        ["编号", "决策"],
        [
            ["D4", "不建 colleges 集合，学院名单以代码常量维护"],
            ["D5", "去掉「其他」选项；注册时必须选择一个确定的学院"],
            ["D6", "学院注册后不可修改"],
            ["D7", "目前尚未上云，不存在需要迁移的存量账号；直接改现有模拟数据即可"],
        ],
        widths=[1.6, 14.6],
    )

    heading(doc, "2.3 角色与权限", 2)
    table(
        doc,
        ["编号", "决策"],
        [
            ["D8", "干事即学院负责人，权限收口到本学院；个人赛同样收口"],
            ["D9", "管理员可点进用户头像将其设为干事；设完后自动按其所在学院获得对应权限"],
        ],
        widths=[1.6, 14.6],
    )

    heading(doc, "2.4 报名与名单", 2)
    table(
        doc,
        ["编号", "决策"],
        [
            ["D10", "报名采用名单制：由学院负责人提交本学院参赛名单"],
            ["D11", "名单需要管理员审核"],
            ["D12", "名单只有一份，不单列替补；名单内未上场的成员即为替补"],
            ["D13", "名单在管理员开始抽签时锁定"],
            ["D14", "锁定后只能换替补上场；换替补由干事自行操作，无需再次审核"],
        ],
        widths=[1.6, 14.6],
    )

    heading(doc, "2.5 赛制与对阵", 2)
    table(
        doc,
        ["编号", "决策"],
        [
            ["D15", "对阵分两层：大场（学院对学院）+ 小场（具体小项比赛）"],
            ["D16", "赛制先行只做团体单败，跑通后再考虑团体循环 / 小组"],
            ["D17", "学院赛种子必须由管理员手工指定"],
            ["D18", "小项（第 n 场打什么）由管理员自定义"],
            ["D19", "小项项目池为男单、女单、男双、女双、混双五个；同名项目可以重复出现"],
            ["D20", "是否允许兼项由管理员开关控制，默认允许兼项"],
            ["D21", "同一小项内，禁止同一个人重复出场"],
            ["D22", "名单人数上下限由管理员自定义，默认 4–20 人"],
            ["D23", "大场胜负算法由管理员二选一：先到 N 场胜 / 打满比净胜"],
        ],
        widths=[1.6, 14.6],
    )

    heading(doc, "2.6 计分与赛季", 2)
    table(
        doc,
        ["编号", "决策"],
        [
            ["D24", "学院赛单打小项只计个人 ELO，不计赛事积分；ELO 按一级赛事口径（K=32）"],
            ["D25", "双打小项（男双/女双/混双）不计分：ELO 与积分都不计"],
            ["D26", "名次只记给学院；不做学院榜、不给个人发名次分"],
            ["D27", "学院赛计入赛季的只有个人 ELO；该 ELO 随赛季软重置一起重置"],
        ],
        widths=[1.6, 14.6],
    )

    heading(doc, "2.7 参赛流程补充（R1–R5 答复）", 2)
    table(
        doc,
        ["编号", "决策"],
        [
            ["D28", "替补计入名单人数上限（默认 4–20）；名单里只要没上场就视为替补，不单独维护替补栏"],
            ["D29", "大场胜负默认用「打满比净胜」；若选「先到 N 场胜」，N = 小项数的一半加一"],
            ["D30", "出场安排在「大场被排出来时」由双方学院提交；新增「自动沿用上次提交」，换替补也在同一界面完成"],
            ["D31", "学院赛不设签到，提交名单 / 排阵即视为签到；双方都提交后由管理员点「开始比赛」"],
            ["D32", "小场比分确认后，个人 ELO 立即生效"],
        ],
        widths=[1.6, 14.6],
    )

    heading(doc, "2.8 赛制流程与弃权补充（S1–S3 答复）", 2)
    table(
        doc,
        ["编号", "决策"],
        [
            ["D33", "大场胜负的两套算法（先到 N 场胜 / 打满比净胜）都实现，由管理员在发布学院赛时二选一"],
            ["D34", "「打满比净胜」里「净胜」的两套口径（小场胜场差 / 累计局分净胜）也都实现，同样由管理员发布时选择"],
            ["D35", "赛事级「开始」：报名截止或学院报满后，管理员排种子 → 点抽签 → 点开始，整个学院赛进入比赛态"],
            ["D36", "赛事开始后，系统自动给出第一轮的各场大场；每产生一轮新的对阵，系统就自动生成该轮的大场"],
            ["D37", "每个大场由双方干事各提交一次本大场的出场安排（本大场各小项的参赛者），提交的人必须在赛事开始前已在本院名单内"],
            ["D38", "每个大场有独立的大场级「开始」：双方排阵都提交后，管理员点该大场的「开始」按钮，该大场才开打"],
            ["D39", "一个大场比完、录完成绩后，系统自动生成下一轮对阵；如此重复直到决出全部名次"],
            ["D40", "干事未排人不能提交排阵，未提交也不能开始该大场；大场一旦开始，未到场的一方由管理员记弃权"],
            ["D41", "弃权规则推广到所有赛事：个人赛事中本人可以自选弃权；弃权场次不计 ELO 分，对手直接晋级下一轮"],
            ["D42", "小组赛中出现弃权，则小组内按对手获胜计入积分，但同样不计 ELO 分"],
            ["D43", "对手因对方弃权而获胜时，其来自最终排名的赛事积分照旧计算，不受弃权影响"],
        ],
        widths=[1.6, 14.6],
    )

    # ---------------- 三、学院身份 ----------------
    heading(doc, "三、学院身份与注册", 1)

    heading(doc, "3.1 学院名单（26 所）", 2)
    para(doc, "以学校现行院系为准，共 26 所，注册时必选其一。名单顺序即注册页下拉顺序。")
    college_grid(doc)

    heading(doc, "3.2 注册规则", 2)
    bullet(doc, "学院为必选项，不提供「其他」这类兜底选项，也不允许留空（D5）。")
    bullet(doc, "学院在注册后不可修改，沿用现有「不可变字段」的口径（D6）。")
    bullet(doc, "校验仍然是「必须命中 26 所名单之一」，只是名单本身换新。")

    heading(doc, "3.3 为什么不建 colleges 集合", 2)
    para(doc, "学院是一个封闭、稳定的码表，不参与业务写入，也不需要在运行时增删。把它固化成代码常量，可以少建一个集合、少一处同步、少一处权限面（D4）。代价是：以后学校院系调整，需要改代码并发版。")
    callout(doc, "因此学院的主键就是学院全名本身，不额外引入学院编号。所有涉及学院的字段（报名、名单、对阵等）统一使用名单里的学院全名，禁止自由输入，避免同一学院出现多种写法。", "说明")

    heading(doc, "3.4 数据现状与处理", 2)
    para(doc, "项目目前还没有上云，云端没有任何存量账号，也就不存在「其他」学院的迁移问题（D7）。现有学院枚举与模拟数据直接按 26 所名单改掉即可：")
    bullet(doc, "现有枚举是「17 所学院 + 其他」，新名单 26 所；原有 17 所名称全部保留。")
    bullet(doc, "新增 9 所：中华民族共同体学院、文学院、马克思主义学院、药学院、舞蹈学院、海南国际学院、预科教育学院、继续教育学院（干部培训部）、藏学研究院。")
    bullet(doc, "删除「其他」；模拟数据（seed）里如出现该值，直接改成某个确定学院。")

    # ---------------- 四、角色与权限 ----------------
    heading(doc, "四、角色与权限：干事 = 学院负责人", 1)

    heading(doc, "4.1 角色", 2)
    table(
        doc,
        ["角色", "定位", "权限范围"],
        [
            ["会员", "普通参赛者", "报名、查赛程、录自己的比分、确认对手比分"],
            ["干事", "学院负责人", "只能管理本学院：代签到、录分、提交与修改本学院名单（含换替补）"],
            ["管理员", "赛事主办方", "全局：发布/抽签/开赛/结束、确认任意比分、审核、赛季重置"],
        ],
        widths=[2.0, 3.2, 11.0],
    )

    heading(doc, "4.2 权限收口口径", 2)
    para(doc, "干事的每一项能力都要带「本学院」这个限定。判定原则：管理员通行；干事仅当目标属于自己学院时放行。")
    table(
        doc,
        ["能力", "会员", "干事（本学院）", "干事（他院）", "管理员"],
        [
            ["代签到", "不可", "可", "不可", "可"],
            ["录入比分", "仅本人参赛", "可", "不可", "可"],
            ["提交 / 修改本学院名单", "不可", "可", "不可", "可"],
            ["锁定后换替补", "不可", "可（仅本学院）", "不可", "可"],
            ["发布 / 抽签 / 开赛 / 结束", "不可", "不可", "不可", "可"],
            ["确认比分", "本人参赛且为对手方", "本人参赛且为对手方", "本人参赛且为对手方", "任意"],
        ],
        widths=[4.6, 3.2, 3.2, 2.6, 2.6],
    )
    bullet(doc, "个人赛（二级、三级）里的干事权限同样收口到本学院，不搞两套规则。")
    bullet(doc, "确认比分维持「对手方确认」的正式口径，管理员可越权确认任意场。")

    heading(doc, "4.3 任命干事（新增功能）", 2)
    para(doc, "管理员在会员列表 / 个人主页点进某个用户的头像，即可把该用户设为干事（D9）。")
    numbered(doc, "管理员点用户头像，出现「设为干事」入口。")
    numbered(doc, "确认后，该用户的 role 变为干事。")
    numbered(doc, "系统自动读取该用户注册时填写的学院，作为其管理范围——不需要再手工指定学院。")
    numbered(doc, "该用户重开小程序后生效，此后只能管理本学院的签到、录分与名单事务。")
    callout(doc, "干事的范围完全由「用户自己的学院」决定，因此任命前要确认该用户的学院填得对。学院不可自行修改，填错只能由管理员在后台处理。", "注意")

    # ---------------- 五、名单制报名 ----------------
    heading(doc, "五、学院赛的参赛模型：名单制", 1)
    para(doc, "学院赛不采用「个人自己报名」，而是由学院负责人提交一份本学院参赛名单（D10）。")

    heading(doc, "5.1 名单对象", 2)
    table(
        doc,
        ["字段", "含义"],
        [
            ["赛事", "所属学院赛"],
            ["学院", "报名的学院（26 选一）"],
            ["提交人", "该学院负责人（干事）"],
            ["队员名单", "本学院参赛队员的集合（成员为用户）；未上场者即视为替补"],
            ["状态", "待提交 / 待审核 / 已通过 / 已退回"],
            ["提交时间", "报名时间点"],
            ["备注", "特殊情况说明"],
        ],
        widths=[3.2, 13.0],
    )

    heading(doc, "5.2 报名流程", 2)
    numbered(doc, "管理员发布学院赛，设定小项序列、兼项开关、名单人数上下限、赛程时间。")
    numbered(doc, "学院负责人进入报名页，从本学院在册会员中勾选队员，凑够人数后提交名单。")
    numbered(doc, "管理员审核名单（D11）；通过后名单有效，等待抽签。")
    numbered(doc, "管理员开始抽签时名单锁定（D13），学院进入签表。")
    numbered(doc, "抽签排定大场后，双方学院提交该场的出场安排（见 5.5）。")
    numbered(doc, "双方都提交后，管理员点「开始比赛」；逐场录入小场比分，大场随之汇总。")

    heading(doc, "5.3 名单构成与人数", 2)
    bullet(doc, "名单只有一份，人数需落在管理员设定的上下限内（D22，默认 4–20，替补计入其中，D28）。")
    bullet(doc, "不单独维护「替补栏」：名单内只要本场没上场，就被视为替补，可直接被换上场（D28）。")
    bullet(doc, "名单成员必须是「在册」会员，且学院与报名学院一致——从源头杜绝跨院凑人。")
    bullet(doc, "同一赛事同一学院只有一份有效名单。")

    heading(doc, "5.4 锁定与换人", 2)
    callout(doc, "名单的锁定时机就是「管理员开始抽签」的那一刻。抽签之后报名与名单编辑一律关闭。", "关键")
    bullet(doc, "锁定后唯一允许的调整是「换队员」：把已上场的人换成名单内尚未上场的成员（即替补）。")
    bullet(doc, "换人在「出场安排」界面完成，由干事自行操作，不需要管理员审核（D14、D30）。")
    bullet(doc, "只能换名单内的人，不能临时加人；换下的人是否还能再换回，见第十章的遗留项。")

    heading(doc, "5.5 出场安排（排阵）", 2)
    numbered(doc, "某个大场被排出来后（抽签或上一轮晋级时），双方学院各提交一份本场出场安排：第 1 场男单谁打、第 2 场男双谁上……")
    numbered(doc, "系统自动沿用本学院上一次提交的排阵——例如 16 进 8 提交过的，会默认出现在 8 进 4 的提交界面；无需修改就直接提交（D30）。")
    numbered(doc, "换替补也在这个界面完成：把某个小项的出场人换成名单内未上场的成员（D30）。")
    numbered(doc, "双方都提交后，管理员点「开始比赛」，该场才开打（D31）。")
    bullet(doc, "学院赛不设签到环节：提交名单 / 排阵即视为签到（D31）。")
    bullet(doc, "排阵受赛事配置约束：小项序列、是否允许兼项、同一小项内禁止同一人重复出场。")
    bullet(doc, "一方未提交时不能开赛，需要该学院负责人补齐排阵。")

    heading(doc, "5.6 与个人报名的关系", 2)
    para(doc, "学院赛用名单制，个人赛继续用现有的「一人一行」报名。两条链路互不干扰：名单制是学院赛专属，不改动现有 event_signups 的语义。")

    # ---------------- 六、学院赛赛制框架 ----------------
    heading(doc, "六、学院赛赛制框架", 1)

    heading(doc, "6.1 两层结构：大场与小场", 2)
    para(doc, "学院赛的核心是把「学院对学院的对抗」和「具体几场单项比赛」拆成两层（D15）：")
    table(
        doc,
        ["层级", "单位", "说明"],
        [
            ["大场（tie）", "两个学院", "签表上的一轮对阵，胜者晋级；胜负由名下小场汇总而来"],
            ["小场（leg）", "具体选手", "男单 / 女单 / 男双 / 女双 / 混双等，是一场正常的比赛，有比分与胜负"],
        ],
        widths=[2.8, 2.6, 10.8],
    )
    callout(doc, "小场仍是真实选手之间的比赛，因此单打小场的个人 ELO 可以在小场层面自然产生；大场只负责汇总「哪个学院赢了这一轮」。两者分开记录，互不污染。", "说明")

    heading(doc, "6.2 大场（tie）", 2)
    table(
        doc,
        ["字段", "含义"],
        [
            ["赛事、轮次、签位", "大场在签表中的位置"],
            ["学院 A / 学院 B", "对阵双方（学院全名）"],
            ["小场列表", "本场包含的若干小场"],
            ["胜负算法", "先到 N 场胜 / 打满比净胜，由赛事配置决定"],
            ["大场胜方", "按选定算法由小场胜负汇总判定"],
            ["状态", "待进行 / 进行中 / 已结束"],
        ],
        widths=[4.0, 12.2],
    )
    para(doc, "胜负算法二选一，两种都要实现，由管理员在发布赛事时选择（D23）。默认是「打满比净胜」；若选「先到 N 场胜」，N = 小项数的一半加一（D29）。")

    heading(doc, "6.3 小场（leg）", 2)
    table(
        doc,
        ["字段", "含义"],
        [
            ["所属大场", "归属哪一场学院对抗"],
            ["项目", "男单 / 女单 / 男双 / 女双 / 混双（由赛事配置决定）"],
            ["第几场", "在本大场中的出场顺序"],
            ["双方选手", "代表两学院的队员"],
            ["比分", "逐局比分，胜者由比分判定"],
            ["状态", "待确认 / 已生效 / 已撤销"],
        ],
        widths=[3.2, 13.0],
    )

    heading(doc, "6.4 赛制与签表", 2)
    bullet(doc, "先行只做团体单败：学院进签表，输一场即出局，最终排定学院名次（D16）。")
    bullet(doc, "签表的槽位是学院，而不是个人。")
    bullet(doc, "后续再扩团体循环、团体小组+淘汰；扩展时沿用同一套大场/小场结构。")

    heading(doc, "6.5 种子：管理员手工指定", 2)
    para(doc, "学院赛种子不按个人等级分或上赛季成绩自动计算，一律由管理员在抽签时手工指定（D17）。管理员按顺序点选学院，先点的排 1 号种子，系统据此把强队分散到不同半区。")

    heading(doc, "6.6 小项配置（全部由管理员自定义）", 2)
    table(
        doc,
        ["配置项", "规则", "默认"],
        [
            ["第 n 场项目", "管理员逐项指定第 1 场、第 2 场……分别是什么项目（D18）：默认先摆 1 项，点「＋ 添加小项」逐项增加，每项用下拉选；行号即出场顺序", "默认 1 项（男单）"],
            ["项目池", "男单、女单、男双、女双、混双共 5 项（D19）", "—"],
            ["项目重复", "同一项目可在一场大场中重复出现，例如两场男单（D19）", "允许"],
            ["是否允许兼项", "管理员开关；允许时同一队员可参加多个小项（D20）", "允许"],
            ["同一小项内重复出场", "禁止同一个人在同一小项里出现两次（D21）", "禁止"],
            ["名单人数上下限", "管理员设定每院最少 / 最多报名人数（D22）", "4 – 20 人"],
        ],
        widths=[3.4, 9.4, 3.4],
    )

    heading(doc, "6.7 状态流转", 2)
    para(doc, "学院赛沿用现有的单向状态机，并保留「先抽签、后开赛」的约束。完整链路如下（D35–D39）：")
    numbered(doc, "发布赛事：管理员设置赛制、小项、算法与人数上下限，开放报名。")
    numbered(doc, "报名：干事只提交本学院参加本赛事的名单，管理员审核（D10、D11）。")
    numbered(doc, "截止：报名时间到，或学院报名数已满。")
    numbered(doc, "排种子：管理员手工指定种子顺序（D17）。")
    numbered(doc, "抽签：管理员点「抽签」，名单锁定（D13），学院进签表。")
    numbered(doc, "开始赛事：管理员点「开始」，整个学院赛进入比赛态；系统自动生成第一轮的各场大场（D35、D36）。")
    para(doc, "进入比赛态后，每一轮的推进方式：")
    numbered(doc, "系统自动给出本轮的各场大场（tie）。")
    numbered(doc, "每个大场由双方干事各提交一次「出场安排」——即本大场各小项的参赛者（D37）。")
    numbered(doc, "双方排阵都提交后，管理员点该大场的「开始」（大场级独立开始，D38）。")
    numbered(doc, "该大场逐个小项录入比分；单打小项确认后个人 ELO 立刻生效（D32）。")
    numbered(doc, "大场汇总出胜负（按发布时选定的算法，D33、D34）。")
    numbered(doc, "该轮所有大场打完后，系统自动生成下一轮对阵（D39）。")
    numbered(doc, "重复以上步骤，直到决出全部名次。")
    numbered(doc, "已结束：管理员录入学院名次，赛事结束。")

    heading(doc, "6.8 弃权规则（D40–D43）", 2)
    para(doc, "弃权是一套通用规则，同时适用于学院赛与现有的个人赛事：")
    table(
        doc,
        ["场景", "规则"],
        [
            ["干事未排人", "不能提交排阵；未提交排阵就不能开始该大场，从源头避免弃权（D40）"],
            ["大场开始后未到场", "由管理员记弃权（D40）"],
            ["个人赛事", "参赛者本人可以自选弃权（D41）"],
            ["ELO", "弃权场次不计 ELO 分，双方都不因此产生等级分变化（D41）"],
            ["晋级", "对手直接晋级下一轮（D41）"],
            ["小组赛", "小组内按对手获胜计入积分，同样不计 ELO 分（D42）"],
            ["排名积分", "对手因对方弃权获胜后，其来自最终排名的赛事积分照旧计算（D43）"],
        ],
        widths=[3.6, 12.6],
    )

    # ---------------- 七、计分与赛季 ----------------
    heading(doc, "七、计分与赛季", 1)

    heading(doc, "7.1 单打小项：只计 ELO，不计积分", 2)
    para(doc, "学院赛里的单打小项：")
    table(
        doc,
        ["项目", "口径"],
        [
            ["个人等级分（ELO）", "计入；按一级赛事 K 值 32 计算；小场确认后立即生效（D24、D32）"],
            ["赛事积分", "不计入；个人单打比赛不从学院赛中获得任何赛事积分（D24）"],
            ["赛事等级", "学院赛统一按一级处理，无等级选项（D24）"],
        ],
        widths=[4.6, 11.6],
    )
    callout(doc, "这是本轮的关键调整：学院赛只影响个人的等级分，不产生赛季积分。个人赛季积分仍然只来自个人赛。", "关键")

    heading(doc, "7.2 双打小项：不计分", 2)
    para(doc, "男双 / 女双 / 混双小项不计任何个人分数：既不计 ELO，也不计积分（D25）。它们只参与大场胜负的汇总。")

    heading(doc, "7.3 名次：只记学院", 2)
    para(doc, "学院赛名次只记给学院（冠军学院、亚军学院……），不做学院榜、不给参赛个人发名次分（D26）。")

    heading(doc, "7.4 赛季：仅个人 ELO 计入并重置", 2)
    para(doc, "学院赛计入赛季的只有个人 ELO，而个人 ELO 本来就会随赛季软重置一起重置（D27）。因此赛季更新的口径不变：重置时把个人 ELO 向锚点分压缩，学院赛产生的 ELO 也在其中。")

    # ---------------- 八、改动清单 ----------------
    heading(doc, "八、数据与代码改动清单（概要）", 1)
    para(doc, "以下为落地时预计触及的范围，仅供评估工作量，不是最终实现方案。")
    table(
        doc,
        ["层面", "预计改动"],
        [
            ["学院码表", "替换现有 17+其他 名单为 26 所；去掉「其他」；注册必选"],
            ["模拟数据", "seed 中的学院值改为 26 所名单内的确定学院"],
            ["权限层", "新增「本学院」判定；干事能力全部加范围限定；新增头像设干事入口"],
            ["报名", "新增学院名单制对象与提交 / 审核 / 锁定流程"],
            ["对阵", "新增大场与小场两层结构；签表槽位改为学院"],
            ["抽签", "支持学院签表与手工指定种子；抽签即锁定名单"],
            ["排阵", "新增出场安排界面：大场排出后提交、自动沿用上次、换替补同界面完成"],
            ["开赛", "两级开赛：赛事级统一开始并生成首轮；每个大场各自开始；学院赛不设签到"],
            ["轮次", "一轮大场全部打完后，自动生成下一轮对阵，循环至名次决出"],
            ["弃权", "新增弃权判定：管理员代记（大场）与本人自选（个人赛）；不计 ELO、对手晋级、小组赛记对手胜、排名积分照旧"],
            ["计分", "单打小项接入一级 K 值、确认即生效；不计积分；双打不计分"],
            ["页面", "学院报名页、学院赛详情页（大场/小场展示）、名单管理页、排阵页、头像设干事入口"],
            ["云函数", "名单提交/审核/换替补、抽签与轮次生成、小场录分与汇总、弃权、学院名次录入"],
            ["镜像与测试", "同步云函数共享库；补齐权限、名单、对阵、计分测试"],
        ],
        widths=[3.0, 13.2],
    )

    heading(doc, "8.1 必须正面处理的技术点", 2)
    bullet(doc, "比赛主键冲突：小场需要独立的、赛事内唯一的标识，不能沿用个人赛的自然键，否则会撞记录。")
    bullet(doc, "回放引擎的边界：现有回放只认「人」，大场不能直接混进去，必须拆成小场后再回放。")
    bullet(doc, "参赛者容量：现有比赛每方最多 2 人，学院显然超出，因此大场必须独立存放，不能塞进现有比赛结构。")
    bullet(doc, "权限范围：现有权限只有全局角色，没有「学院」维度，需要新增范围判定。")
    bullet(doc, "计分调整：现有规则下双打本就不计分，单打计积分；学院赛要改成「单打只计 ELO、不计积分」，需要在结算层按赛事类型分流。")
    bullet(doc, "弃权分流：弃权场次不能进 ELO 结算，但要参与大场汇总、小组积分与排名分计算，需要在回放与结算层同时开一个「弃权」旁路。")

    # ---------------- 九、分期落地 ----------------
    heading(doc, "九、分期落地建议", 1)
    table(
        doc,
        ["阶段", "内容", "目标"],
        [
            ["第 0 期", "学院码表更新为 26 所、去掉「其他」、注册必选、改 seed", "先把身份地基换对"],
            ["第 1 期", "干事权限收口到本学院；新增头像「设为干事」", "让「学院负责人」真正成立"],
            ["第 2 期", "学院名单制报名（提交 / 审核 / 抽签锁定）", "报名以学院为单位"],
            ["第 3 期", "大场 + 小场 + 团体单败最小闭环；两级开赛与轮次自动推进；出场安排（自动沿用 + 换替补）；单打只计 ELO", "跑通一场完整的学院赛"],
            ["第 4 期", "小项自定义、兼项、种子手工指定、两种胜负算法与两套净胜口径等配置完善", "管理员可自主编排"],
            ["第 5 期", "弃权规则（管理员代记 + 个人赛本人自选），贯通 ELO / 小组积分 / 排名分", "规则闭环、无争议场次"],
            ["第 6 期", "团体循环 / 团体小组扩展", "按需再扩赛制"],
        ],
        widths=[2.2, 8.8, 5.2],
    )
    para(doc, "建议至少先完成第 0、1 期：它们不新增赛制页面，却能让学院身份与负责人权限立即生效，风险最低。")

    # ---------------- 十、确认记录与遗留 ----------------
    heading(doc, "十、问题确认记录与遗留", 1)

    heading(doc, "10.1 上一轮 12 个问题的答复", 2)
    table(
        doc,
        ["编号", "问题", "答复"],
        [
            ["Q1", "小项是否统一按一级计分、有无例外", "没有例外，全部按一级"],
            ["Q2", "双打小项是否计个人分", "不计，双打保持不计分"],
            ["Q3", "名次记给学院还是个人", "只记给学院"],
            ["Q4", "学院赛是否计入赛季", "计入；但因不做学院榜，计入赛季的只有个人 ELO，且随赛季重置"],
            ["Q5", "个人赛是否保留、一级赛归属", "个人赛全部保留，一级赛依然可以是个人赛，学院赛单列"],
            ["Q6", "干事如何任命", "管理员点用户头像设为干事，自动按其学院授权"],
            ["Q7", "名单审核、替补、锁定与换人", "要审核；要有替补；抽签时锁定；锁定后只能换替补，由干事自行操作"],
            ["Q8", "大场胜负算法", "由管理员选，两种算法都要有"],
            ["Q9", "小项项目池与重复", "共 5 项（男单/女单/男双/女双/混双），可以重复出现"],
            ["Q10", "同一小项内能否重复出场", "禁止"],
            ["Q11", "名单人数上下限", "默认 4–20"],
            ["Q12", "存量「其他」账号迁移", "尚未上云，没有存量；直接改模拟数据"],
        ],
        widths=[1.4, 5.4, 9.4],
    )

    heading(doc, "10.2 R1–R5 答复", 2)
    table(
        doc,
        ["编号", "问题", "答复"],
        [
            ["R1", "替补是否计入人数、是否有上限、换人次数", "计入；名单里没上场的都视为替补"],
            ["R2", "默认胜负算法与 N", "默认「打满比净胜」；「先到 N 场胜」时 N = 小项数一半加一"],
            ["R3", "出场安排由谁在何时提交", "大场被排出来时提交；可自动沿用上次排阵；换替补在同一界面完成"],
            ["R4", "学院赛是否签到", "不签到，提交名单即视为签到；双方都提交后管理员点「开始比赛」"],
            ["R5", "个人 ELO 生效时机", "立即生效"],
        ],
        widths=[1.4, 5.4, 9.4],
    )

    heading(doc, "10.3 S1–S3 答复（已闭环）", 2)
    para(doc, "上一轮遗留的 3 个问题已全部拍板，对应决策见 2.8 与 6.8。")
    table(
        doc,
        ["编号", "问题", "答复"],
        [
            ["S1", "「打满比净胜」中的「净胜」按什么算：小场胜场差，还是把所有小场的局分 / 净胜分累计？",
             "两套口径都实现，由管理员在创建赛事时二选一（D34）"],
            ["S2", "「开始比赛」的粒度：每个大场各自开始，还是整个赛事统一开始？",
             "两者都要：赛事级先统一「开始」并生成首轮大场，之后每个大场各自「开始」（D35、D38）"],
            ["S3", "某个小项一方未到场 / 未排人时，如何判定弃权、比分怎么记？",
             "未排人不能提交也不能开赛；开赛后未到场由管理员记弃权；个人赛本人可自选弃权；弃权不计 ELO、对手直接晋级，小组赛记对手胜，排名积分照旧（D40–D43）"],
        ],
        widths=[1.4, 6.0, 8.8],
    )

    closing = doc.add_paragraph()
    closing.paragraph_format.space_before = Pt(16)
    run = closing.add_run("—— 方案结束。全部遗留项已闭环，可进入开发；设计与实现不一致时，以最新讨论为准。——")
    set_font(run, size=9.5, color=MUTED)

    return doc


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "学院赛设计方案.docx"
    doc = build()
    doc.save(out)
    print(f"已生成：{out}")


if __name__ == "__main__":
    main()
