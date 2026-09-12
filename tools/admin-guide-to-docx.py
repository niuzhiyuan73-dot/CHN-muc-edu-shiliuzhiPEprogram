"""
把「赛事管理员操作手册」排版成 Word 文档。

用法：
    python tools/admin-guide-to-docx.py [输出.docx]

依赖 python-docx。默认输出到仓库根目录的「赛事管理员操作手册.docx」。
内容与小程序当前实现严格对应，改赛后流程时请一并更新本文件。
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


def rich(doc, segments):
    """一段里混排多种样式：segments = [(文本, {样式}), ...]"""
    paragraph = doc.add_paragraph()
    paragraph.paragraph_format.space_after = Pt(4)
    paragraph.paragraph_format.line_spacing = 1.25
    for text, style in segments:
        run = paragraph.add_run(text)
        set_font(run, **style)
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
    run = subtitle.add_run("赛事管理员操作手册")
    set_font(run, size=26, bold=True, color=ACCENT, ea=HEAD_EA)

    tagline = doc.add_paragraph()
    tagline.alignment = WD_ALIGN_PARAGRAPH.CENTER
    tagline.paragraph_format.space_after = Pt(12)
    run = tagline.add_run("发布赛事 → 收报名 → 抽签 → 开赛签到 → 录分确认 → 录入名次并结算")
    set_font(run, size=11, color=MUTED)

    table(
        doc,
        ["项目", "说明"],
        [
            ["适用对象", "管理员（发布与赛程管理）；干事（代签到、录分）；普通会员只能报名与查看"],
            ["适用版本", "含循环赛 / 小组赛 / 双败淘汰 / 复合赛制，小组数 2–8、出线 1–4 人"],
            ["核心原则", "先抽签、后开赛；比分由选手录、对手确认；名次提交即结束"],
        ],
        widths=[3.0, 13.2],
    )

    # ---------------- 一、总览 ----------------
    heading(doc, "一、先读这一页：权限与流程总览", 1)

    heading(doc, "1.1 谁可以做管理操作", 2)
    para(doc, "小程序把账号分成三种角色。发布、抽签、开赛、结束赛事这类「定盘子」的操作只开放给管理员；干事相对会员只多两件事——代会员签到、给比赛录入比分。普通会员只能报名、取消报名、查看赛程与成绩。")
    table(
        doc,
        ["操作", "会员", "干事", "管理员"],
        [
            ["发布赛事 / 修改赛事", "不可", "不可", "可"],
            ["抽签 / 重新抽签", "不可", "不可", "可"],
            ["开始赛事", "不可", "不可", "可"],
            ["录入名次并结束赛事", "不可", "不可", "可"],
            ["代会员签到", "不可", "可", "可"],
            ["录入比分", "仅本人参赛的场次", "任意场次", "任意场次"],
            ["确认比分", "本人参赛且为对手方", "本人参赛且为对手方", "任意场次"],
            ["撤销已生效的比赛", "仅本人录入的", "仅本人录入的", "任意场次"],
        ],
        widths=[4.6, 3.6, 3.6, 4.4],
    )
    callout(doc, "管理员可以确认任意一场比分，哪怕自己没参加；干事与会员仍需本人参赛、且站在录入者对面。改已生效的比分没有「直接修改」，一律先撤销再重录。", "注意")

    heading(doc, "1.2 一条主线：从发布到结算", 2)
    para(doc, "一场赛事在系统里只有三种状态，按下面的顺序单向推进，不会回头：")
    table(
        doc,
        ["步骤", "赛事状态", "谁来操作", "做什么"],
        [
            ["1. 发布赛事", "报名中", "管理员", "填表发布，系统开放报名"],
            ["2. 收集报名", "报名中", "会员自助", "会员自行报名 / 取消"],
            ["3. 抽签", "报名中", "管理员", "锁定名单，排出签表或分组，生成比赛"],
            ["4. 开始赛事", "进行中", "管理员", "报名截止，进入比赛日"],
            ["5. 签到", "进行中", "干事 / 管理员", "给到场的已报名者代签"],
            ["6. 录分 → 确认", "进行中", "选手录、对手确认（干事以上可代录）", "逐场出结果，系统自动排下一轮"],
            ["7. 录入名次并结束", "已结束", "管理员", "确认名次，系统自动结算等级分与积分"],
        ],
        widths=[3.0, 2.4, 3.4, 7.4],
    )

    heading(doc, "1.3 最容易搞错的五个顺序问题", 2)
    numbered(doc, "先抽签，后开始。抽签入口只在「报名中」出现；一旦点了「开始赛事」，就再也不能抽签或重抽了。单打没抽签就点「开始赛事」不会生效，会提示「请先抽签，再开始赛事」；双打不需要抽签，不受此限。")
    numbered(doc, "抽签即冻结名单。抽签后再也没有报名与取消报名的入口，要换人只能重抽。")
    numbered(doc, "已有比赛确认生效后不能重抽。系统会提示「该赛事已有比赛确认生效，不能再重抽」。")
    numbered(doc, "没录比分不能确认。系统会提示「这场比赛还没有比分，请先录入成绩」。")
    numbered(doc, "名次一提交，赛事立即结束且不可再改。请确认无误再点「提交并结束赛事」。")

    # ---------------- 二、发布赛事 ----------------
    heading(doc, "二、第一步：发布赛事", 1)

    heading(doc, "2.1 入口", 2)
    para(doc, "在「赛事」页右上角点「＋ 发布」进入发布表单。没有管理员角色时，详情/列表不会出现管理入口，直接打开表单也会提示「当前账号没有发布赛事的权限，请联系管理员」。")

    heading(doc, "2.2 表单逐项说明", 2)
    table(
        doc,
        ["字段", "是否必填", "说明与可选值"],
        [
            ["赛事名称", "必填", "2–30 个字"],
            ["项目", "必填", "单打 / 双打。双打不计等级分与积分，也不支持抽签与自动对阵"],
            ["赛制", "单打必填", "六选一，见 2.3。默认「单败淘汰」"],
            ["小组数", "小组赛类必填", "2 组 / 4 组 / 8 组，默认 2 组"],
            ["出线人数", "小组赛类、循环赛+淘汰必填", "每组出线 1 / 2 / 3 / 4 人，默认 2 人"],
            ["总决赛重赛", "双败类", "开关，默认开启，见 2.3"],
            ["5–8 名排位", "单败类", "开关，默认关闭，见 2.3"],
            ["赛事等级", "必填", "一级 / 二级 / 三级，决定等级分 K 值与名次分倍数，见 2.4"],
            ["三四名赛", "单败类必填", "并列季军 / 打三四名"],
            ["种子来源", "单打必填", "手工指定 / 按等级分 / 按赛季积分，见 2.5"],
            ["种子数量", "单打必填", "2 / 4 / 8 位，默认 8 位"],
            ["日期、时间", "必填", "比赛开始时间；日期不能早于今天"],
            ["场地", "选填", "40 字以内，例如「体育馆 1 号场」"],
            ["名额", "选填", "整数；不填视为不限。报满后会员无法再报名"],
            ["赛事说明", "选填", "200 字以内，会展示给报名者"],
        ],
        widths=[3.0, 3.4, 9.8],
    )

    heading(doc, "2.3 六种赛制怎么选", 2)
    table(
        doc,
        ["赛制", "建议人数", "特点", "名次怎么来"],
        [
            ["单败淘汰", "4 人以上", "输一场即出局，场次最少、节奏最快", "赛后手动录入"],
            ["循环赛", "3–8 人", "人人交手，最公平，但场次随人数平方增长", "自动按战绩排"],
            ["小组赛+淘汰", "8 人以上", "先分组循环，出线后跨组交叉打单败", "自动预填"],
            ["循环赛+淘汰", "5 人以上", "单组循环取前若干名进单败", "自动预填"],
            ["双败淘汰", "4 人以上", "输两场才出局，设胜者组 / 败者组 / 总决赛", "自动按轮次排"],
            ["小组赛+双败", "8 人以上", "小组循环出线后进入双败阶段", "自动按轮次排"],
        ],
        widths=[3.0, 2.0, 7.4, 3.8],
    )
    para(doc, "各赛制专属选项的含义：", bold=True)
    bullet(doc, "总决赛重赛（双败类）：开启后，胜者组冠军在总决赛先记 1:0；若首场输给败者组冠军，则加赛一场定冠军。这是国际通行的标准双败口径。关闭则总决赛只打一场。")
    bullet(doc, "5–8 名排位（单败类）：开启后，八强战（1/4 决赛）的负者加赛两轮，分出第 5、6、7、8 名。签表不足 8 人时不会启用。")
    bullet(doc, "小组数、出线人数：仅小组赛类赛制可配。小组数超过实际人数时会自动按人数收敛，不会出现空组。")
    callout(doc, "双败阶段至少需要 4 名参赛者。选「小组赛+双败」时，组数 × 出线人数必须 ≥ 4，否则表单会直接报错。", "注意")

    heading(doc, "2.4 赛事等级：同时决定等级分与名次分", 2)
    para(doc, "等级不是装饰。它同时决定两件事：每场比赛对等级分的影响幅度（K 值），以及名次分的倍数。等级越高，一场胜负带来的等级分变化越大，名次分也越高。")
    table(
        doc,
        ["等级", "等级分 K 值（每场）", "名次分倍数", "冠军名次分（基础 20 分 × 倍数）"],
        [
            ["一级赛事", "32", "×4", "80 分"],
            ["二级赛事", "24", "×2", "40 分"],
            ["三级赛事", "16", "×1", "20 分"],
        ],
        widths=[2.8, 4.2, 3.2, 6.0],
    )
    para(doc, "名次基础分档位：第 1 名 20、第 2 名 14、第 3 名 10、第 4 名 7、第 5–8 名 4，未进八强为 0。所有参赛者另加 2 分参与分。双打赛事不计分。")
    callout(doc, "三级赛事的 K 值（16）与日常约球一致；二级、一级逐级放大。日常约球只影响等级分，不产生积分。", "提示")

    heading(doc, "2.5 种子设置", 2)
    table(
        doc,
        ["种子来源", "系统怎么排"],
        [
            ["手工指定", "抽签时由管理员按点选顺序指定 1 号、2 号……（见 3.5）"],
            ["按等级分", "系统取当前单打等级分最高的前 N 位"],
            ["按赛季积分", "系统取赛季积分最高的前 N 位"],
        ],
        widths=[3.4, 12.8],
    )
    para(doc, "实际种子数 = min(种子数量, 有效报名人数)。种子会被分散到不同半区或不同小组，避免强手过早相遇；种子只影响初始位置，不影响比分与计分。")

    heading(doc, "2.6 发布失败怎么办", 2)
    para(doc, "表单会逐项高亮错误。常见提示与处理：")
    table(
        doc,
        ["提示", "原因与处理"],
        [
            ["赛事名称需在 2–30 字之间", "名称过短或过长"],
            ["请选择单打或双打", "项目未选"],
            ["请选择赛事等级", "等级必须显式选择，没有默认值"],
            ["请选择三四名赛方式", "单败类赛制必须选并列季军或打三四名"],
            ["双败淘汰阶段至少需要 4 名出线者", "组数 × 出线人数 < 4，请加大组数或出线人数"],
            ["请选择种子来源 / 种子数量", "单打赛事必须设置种子口径"],
            ["比赛日期不能早于今天", "日期选择器已限制，若仍报错请重选"],
            ["当前账号没有发布赛事的权限", "当前账号不是管理员，或账号未通过审核"],
        ],
        widths=[6.4, 9.8],
    )

    heading(doc, "2.7 发布成功之后", 2)
    bullet(doc, "提示「已发布」并返回赛事列表。")
    bullet(doc, "赛事状态为「报名中」，会员可以开始报名。")
    bullet(doc, "发布者会被记录（发布人、发布时间），但管理权限不看发布者——任何管理员都能接着管理这场赛事。")

    # ---------------- 三、报名与抽签 ----------------
    heading(doc, "三、第二步：收报名，然后抽签", 1)

    heading(doc, "3.1 报名是会员自助的", 2)
    para(doc, "报名、取消报名都由会员在赛事详情页自行完成。本版本没有「审核报名」环节：报名即生效，计入名单。")
    bullet(doc, "会员报名前需满足：赛事处于报名中、账号有效、未离校、名额未满。")
    bullet(doc, "取消报名只在报名中、且尚未抽签时可用。")
    bullet(doc, "已取消的记录会保留但不再计入名单、分组与抽签。")

    heading(doc, "3.2 报名阶段管理员要盯的三件事", 2)
    numbered(doc, "人数够不够：单败至少 2 人，双败至少 4 人；小组赛要够分到各组。")
    numbered(doc, "名额有没有报满：报名人数达到名额上限后，其他人无法再报名。")
    numbered(doc, "名单是否要调整：本版本不支持管理员直接删人，请让本人在抽签前自行取消报名。")

    heading(doc, "3.3 什么时候抽签（关键）", 2)
    callout(doc, "抽签的唯一时机是「报名中」，也就是发布之后、点「开始赛事」之前。一旦开始赛事，抽签入口消失。请务必在开赛前完成抽签。", "关键")
    bullet(doc, "建议在报名人数稳定、临近开赛时抽签。")
    bullet(doc, "抽签会同时锁定名单并截止报名。")
    bullet(doc, "双打赛事不支持抽签，无法自动生成对阵。")
    bullet(doc, "至少需要 2 名有效报名者；双败赛制至少 4 名。")

    heading(doc, "3.4 抽签操作全流程", 2)
    numbered(doc, "打开赛事详情，确认状态是「报名中」。")
    numbered(doc, "在抽签卡片点「开始抽签」（重抽时为「重新抽签」）。")
    numbered(doc, "若种子来源为「手工指定」，会先弹出种子面板（见 3.5）；其余两种来源系统直接算好种子。")
    numbered(doc, "确认对话框：「抽签后名单会锁定，报名随即截止。确定开始抽签吗？」点确定。")
    numbered(doc, "完成后提示「抽签完成」，生成签表或分组，并生成首轮比赛（状态为「待确认」）。")

    heading(doc, "3.5 怎么手工排种子（重点）", 2)
    para(doc, "当种子来源为「手工指定」时，点抽签会弹出面板，标题为「指定种子顺序」。")
    numbered(doc, "面板提示「按顺序点选 N 位种子，先点的排 1 号；再点一次可取消」，并显示「已选 X/N」。")
    numbered(doc, "按你心目中的实力顺序，依次点击参赛者：第 1 个点中的是 1 号种子，第 2 个是 2 号种子，以此类推。")
    numbered(doc, "点错了再点一次即可取消该人；点「清空」可重新开始。")
    numbered(doc, "选够 N 位后点「开始抽签」。数量不足时会提示「还需指定 N 位种子」，无法继续。")
    bullet(doc, "N = min(你在表单里设的种子数量, 有效报名人数)。例如设了 8 位但只有 6 人报名，就只需指定 6 位。")
    bullet(doc, "种子顺序决定初始位置：1、2 号会被分到不同半区或不同小组，在决赛前不会相遇。")
    bullet(doc, "排种子只看实力，不涉及胜负判定；种子选手同样要从第一轮打起。")

    heading(doc, "3.6 抽签结果怎么看", 2)
    table(
        doc,
        ["赛制类型", "生成的内容", "在哪看"],
        [
            ["单败类", "固定签位表，人不够时出现轮空（直接晋级）", "赛事详情 → 签表；顶部显示轮空名单"],
            ["循环 / 小组类", "分组名单 + 每组循环赛程；小组赛另有积分榜", "赛事详情 → 小组积分榜 + 签表"],
            ["双败类", "胜者组 / 败者组 / 总决赛三段对阵", "赛事详情 → 签表（按阶段分区）"],
        ],
        widths=[2.8, 8.0, 5.4],
    )
    para(doc, "小组积分榜包含：名次、昵称、胜、负、净胜局、净胜分，随每场比赛确认实时更新。")

    heading(doc, "3.7 重新抽签", 2)
    bullet(doc, "抽过签之后，按钮变为「重新抽签」，在「报名中」阶段可再次使用。")
    bullet(doc, "前提：还没有任何一场比赛被确认生效。只要有一场「已生效」，就会提示「该赛事已有比赛确认生效，不能再重抽」。")
    bullet(doc, "重抽会作废现有签表与其中所有未确认的比赛，并重新生成；抽签次数会累加记录。")
    bullet(doc, "重抽不会重新开放报名，名单保持锁定。")

    heading(doc, "3.8 报名阶段答疑", 2)
    table(
        doc,
        ["现象", "原因与处理"],
        [
            ["会员说报不上名", "检查：是否已抽签（抽签后锁定）、名额是否已满、账号是否有效、是否已离校"],
            ["看不到「开始抽签」按钮", "确认赛事是「报名中」且项目为单打，且当前账号是管理员"],
            ["提示参赛人数不足", "有效报名少于 2 人，双败少于 4 人，需等更多人报名"],
            ["有人临时不来", "请其本人在抽签前取消报名；抽签后只能靠重抽"],
        ],
        widths=[4.6, 11.6],
    )

    # ---------------- 四、开赛与比赛 ----------------
    heading(doc, "四、第三步：开赛、签到与比分", 1)

    heading(doc, "4.1 开始赛事", 2)
    numbered(doc, "确认已经完成抽签（否则没有对阵可打）。")
    numbered(doc, "赛事详情 → 点「开始赛事」。")
    numbered(doc, "确认对话框：「开始后报名就截止了，确定现在开始这场赛事吗？」")
    numbered(doc, "状态变为「进行中」。此后不能抽签、重抽、报名或取消报名。")
    callout(doc, "单打赛事若尚未抽签，点「开始赛事」不会生效，会提示「请先抽签，再开始赛事」。请先回到抽签卡片完成抽签。双打赛事没有抽签环节，可以直接开始。", "关键")

    heading(doc, "4.2 签到", 2)
    numbered(doc, "赛事状态需为「进行中」。")
    numbered(doc, "赛事详情 → 报名名单 → 找到到场的会员，点其右侧「签到」。")
    numbered(doc, "提示「已签到」。已签过的人会提示「这位会员已经签过到了」。")
    bullet(doc, "签到由管理端代签，会员不能自助签到（保证到场凭证可信）。")
    bullet(doc, "签到不改变签表——对阵在抽签时已经排定。")

    heading(doc, "4.3 录入比分", 2)
    para(doc, "两个入口，效果相同：")
    bullet(doc, "赛事详情 → 签表 → 某场比赛右侧「录分」。")
    bullet(doc, "底部「比赛」页 → 找到该场比赛 → 录分。")
    para(doc, "录入规则：")
    numbered(doc, "对阵双方、分制、局制由抽签锁定，界面上会标明「对阵由抽签排定，不可更改」。")
    numbered(doc, "逐局填写比分。胜者由比分自动判定，不需要也不能手工指定。")
    numbered(doc, "提交后比赛仍为「待确认」，等对手确认后才生效。")
    callout(doc, "录分的权限为「本场参赛者本人」或「干事及以上」。干事与管理员可以给任意一场录分，不受是否参赛限制。", "注意")

    heading(doc, "4.4 确认比分", 2)
    numbered(doc, "只有已经录好比分的场次才会出现「确认」入口；没比分的场次先显示「录分」。")
    numbered(doc, "正式口径：由对手方确认——即参赛双方中，不是录入者的那一方。")
    numbered(doc, "管理员例外：管理员可以确认任意一场，包括自己没参加的场次。")
    numbered(doc, "确认后比赛变为「已生效」，成绩计入等级分与积分，并触发下一轮自动生成。")
    callout(doc, "演示数据源下放宽为「任一参与过该场的人都能确认」，正式环境需对手确认（管理员除外）。以页面提示为准。", "提示")

    heading(doc, "4.5 确认之后：自动晋级与自动加赛", 2)
    bullet(doc, "单败：胜者自动进入下一轮；半决赛结束后，按设置生成三四名赛（打三四名）或两人并列季军（并列季军）。")
    bullet(doc, "5–8 名排位：八强战全部结束后，自动生成第 5–8 名的排位赛。")
    bullet(doc, "小组类：某组循环全部结束后，按战绩排出该组名次；各组都打完且达到出线人数后，自动生成淘汰赛对阵。")
    bullet(doc, "双败：胜者留在胜者组，负者落入败者组；败者组再输即淘汰；胜者组冠军与败者组冠军进入总决赛，按「总决赛重赛」设置决定是否加赛。")
    para(doc, "系统只补生成缺失的场次，绝不覆盖已有比赛；因此可以放心地一场一场确认。")

    heading(doc, "4.6 改判：驳回与撤销", 2)
    para(doc, "改判入口在底部「比赛」页，不在赛事详情页。两种操作都要填写理由，理由是必填项。")
    table(
        doc,
        ["操作", "适用状态", "效果", "谁能做"],
        [
            ["驳回", "待确认", "该场成绩作废，不计等级分", "有确认资格的人"],
            ["撤销", "已生效（含已确认）", "成绩作废，等级分与积分立即回滚", "管理员任意场；其他人仅自己录入的"],
        ],
        widths=[2.2, 3.0, 5.6, 5.4],
    )
    bullet(doc, "驳回理由占位示例：「第二局比分录反了」；撤销理由占位示例：「这局其实没打完」。")
    bullet(doc, "没有「直接修改比分」的功能：要改已生效的比分，需先撤销，再重新录分并确认。")
    bullet(doc, "已撤销的比赛不能再次录分，请确认后再撤销。")

    heading(doc, "4.7 比赛阶段答疑", 2)
    table(
        doc,
        ["现象", "原因与处理"],
        [
            ["点确认提示「还没有比分」", "先录分，再确认"],
            ["点确认提示「你无权确认」", "确认人必须是本场参赛者且站在录入者对面（管理员不受限）"],
            ["看不到下一轮比赛", "上一轮还有比赛未确认；确认后系统自动生成"],
            ["重抽提示不能重抽", "已有比赛确认生效，只能靠撤销后重抽"],
            ["比分录错且已生效", "在比赛页撤销（需理由），再重新录分确认"],
        ],
        widths=[4.6, 11.6],
    )

    # ---------------- 五、结束与结算 ----------------
    heading(doc, "五、第四步：录入名次并结束赛事", 1)

    heading(doc, "5.1 入口与前置条件", 2)
    numbered(doc, "赛事状态需为「进行中」。")
    numbered(doc, "赛事详情 → 点「录入名次并结束」。")
    numbered(doc, "在名次页逐人填写（或微调自动预填的名次）。")
    numbered(doc, "点「提交并结束赛事」，提示「名次已录入，赛事结束」，赛事变为「已结束」。")
    callout(doc, "赛事未开始时打开名次页会提示「赛事开始后才能录入名次」；已结束会提示「这场赛事已经结束，名次不可再改」。", "提示")

    heading(doc, "5.2 名次是自动排还是手录", 2)
    table(
        doc,
        ["赛制", "名次来源", "说明"],
        [
            ["循环赛", "自动", "按积分榜战绩排定"],
            ["小组赛类", "自动预填", "出线者按淘汰成绩、未出线者按小组名次"],
            ["双败淘汰", "自动", "按淘汰轮次排出 1..N（含第 4 名及以后）"],
            ["单败淘汰", "手动", "由管理员逐人录入"],
        ],
        widths=[3.0, 2.6, 10.6],
    )
    para(doc, "自动预填的名次可以直接提交，也可以在提交前小幅调整。尚未抽签或比赛未打完时，会自动提示「名次尚未确定」，此时需先完成比赛。")

    heading(doc, "5.3 名次校验规则", 2)
    bullet(doc, "每人只能有一个名次，且必须是不小于 1 的整数。")
    bullet(doc, "留空的行会被跳过（视为未到场），但至少要给一位参赛者录入名次。")
    bullet(doc, "循环赛 / 小组赛 / 双败（阶梯口径）：一场赛事有且只有一位冠军。")
    bullet(doc, "并列季军：不应出现第 4 名；亚军只能有一位。")
    bullet(doc, "打三四名：第 3 名与第 4 名各一位，且必须成对出现；实际参赛不足 4 人时不再要求成对。")
    bullet(doc, "名次里不能出现没有报名这场赛事的会员。")

    heading(doc, "5.4 提交后发生了什么", 2)
    bullet(doc, "赛事状态变为「已结束」，名次与结束时间落库。")
    bullet(doc, "系统在下一次读取数据时，用回放引擎重算全部等级分与积分——没有单独的「结算」按钮，也无需手动触发。")
    bullet(doc, "名次分 = 名次基础分 × 等级倍数；所有参赛者另加 2 分参与分；双打不计分。")

    heading(doc, "5.5 结束后还能改吗", 2)
    para(doc, "不能。赛事一旦结束，名次进入冻结状态，页面上任何修改都会被拒绝。请在点击「提交并结束赛事」前仔细核对。如确有必要修正，请联系开发者在后台处理。")

    # ---------------- 附录 ----------------
    heading(doc, "六、附录", 1)

    heading(doc, "附录 A：状态速查", 2)
    table(
        doc,
        ["对象", "状态", "含义"],
        [
            ["赛事", "报名中", "可报名、可抽签 / 重抽"],
            ["赛事", "进行中", "可签到、录分、确认、录入名次"],
            ["赛事", "已结束", "名次冻结，计入赛季积分"],
            ["报名", "已取消", "不计入名单"],
            ["报名", "已报名", "计入名单，可代签到"],
            ["报名", "已签到", "到场凭证"],
            ["比赛", "待确认", "已排定；有比分的等待确认"],
            ["比赛", "已生效", "计入等级分与积分，触发下一轮"],
            ["比赛", "已撤销", "成绩作废，分数回滚，不可再录分"],
        ],
        widths=[2.2, 2.6, 11.4],
    )

    heading(doc, "附录 B：赛制与专属选项对照", 2)
    table(
        doc,
        ["赛制", "小组数", "出线人数", "总决赛重赛", "5–8 名排位", "三四名赛"],
        [
            ["单败淘汰", "—", "—", "—", "可选", "必选"],
            ["循环赛", "—", "—", "—", "—", "—"],
            ["小组赛+淘汰", "可选", "可选", "—", "可选", "必选"],
            ["循环赛+淘汰", "—", "可选", "—", "可选", "必选"],
            ["双败淘汰", "—", "—", "可选", "—", "—"],
            ["小组赛+双败", "可选", "可选", "可选", "—", "—"],
        ],
        widths=[2.8, 2.2, 2.2, 2.6, 2.6, 2.2],
    )

    heading(doc, "附录 C：常用报错速查", 2)
    table(
        doc,
        ["报错 / 提示", "含义与处理"],
        [
            ["当前账号没有发布赛事的权限", "账号非管理员，或未通过审核"],
            ["请先抽签，再开始赛事", "单打赛事未抽签就点了开始；先抽签再开始（双打无需抽签）"],
            ["抽签后名单会锁定，报名随即截止", "确认抽签的提示；确定即冻结名单"],
            ["该赛事已有比赛确认生效，不能再重抽", "先撤销已生效比赛才能重抽"],
            ["这场比赛还没有比分，请先录入成绩", "先录分再确认"],
            ["你无权确认这场比赛", "确认人须为本场参赛者且非录入方"],
            ["这位会员已经签过到了", "该会员已完成签到，无需重复"],
            ["赛事开始后才能录入名次", "先把赛事从报名中推进到进行中"],
            ["这场赛事已经结束，名次不可再改", "赛事已结束，名次冻结"],
            ["双败淘汰阶段至少需要 4 名出线者", "组数 × 出线人数 < 4，调整分组参数"],
        ],
        widths=[7.4, 8.8],
    )

    closing = doc.add_paragraph()
    closing.paragraph_format.space_before = Pt(16)
    run = closing.add_run("—— 手册结束。若界面与本手册不符，以小程序实际提示为准。——")
    set_font(run, size=9.5, color=MUTED)

    return doc


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "赛事管理员操作手册.docx"
    doc = build()
    doc.save(out)
    print(f"已生成：{out}")


if __name__ == "__main__":
    main()
