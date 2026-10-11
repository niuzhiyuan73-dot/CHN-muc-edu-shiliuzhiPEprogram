"""
把「学院赛施工规划」排版成 Word 文档。

用法：
    python tools/college-plan-to-docx.py [输出.docx]

依赖 python-docx。默认输出到仓库根目录的「学院赛施工规划.docx」。
本文件是《学院赛设计方案》的技术落地版：数据模型、云函数接口、权限、
页面、测试与分期施工计划。实现过程中如与代码不一致，请同步更新本文件。
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

    # ---------------- 封面 ----------------
    title = doc.add_paragraph()
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    title.paragraph_format.space_after = Pt(2)
    run = title.add_run("中央民族大学石榴籽体育管理小程序")
    set_font(run, size=13, bold=True, color=MUTED, ea=HEAD_EA)

    subtitle = doc.add_paragraph()
    subtitle.alignment = WD_ALIGN_PARAGRAPH.CENTER
    subtitle.paragraph_format.space_after = Pt(2)
    run = subtitle.add_run("学院赛施工规划")
    set_font(run, size=26, bold=True, color=ACCENT, ea=HEAD_EA)

    tagline = doc.add_paragraph()
    tagline.alignment = WD_ALIGN_PARAGRAPH.CENTER
    tagline.paragraph_format.space_after = Pt(12)
    run = tagline.add_run("技术方案 · 数据模型 · 云函数接口 · 权限 · 页面 · 分期施工")
    set_font(run, size=11, color=MUTED)

    table(
        doc,
        ["项目", "说明"],
        [
            ["文档定位", "《学院赛设计方案》的技术落地版，指导开发与验收"],
            ["决策依据", "设计方案中已确认的 32 项决策（D1–D32）"],
            ["施工方式", "按里程碑 M0–M6 顺序推进，每个里程碑可独立验收"],
            ["前置条件", "尚未上云、无存量数据，可直接改模拟数据，无需迁移"],
        ],
        widths=[3.0, 13.2],
    )

    # ---------------- 一、总体架构 ----------------
    heading(doc, "一、总体架构与技术选型", 1)

    heading(doc, "1.1 三条互不干扰的链路", 2)
    para(doc, "学院赛以「新增一条链路」的方式落地，而不是改造现有链路。三条链路的关系如下：")
    table(
        doc,
        ["链路", "单位", "是否改动", "计分"],
        [
            ["个人赛", "个人", "完全不动", "ELO + 赛事积分"],
            ["日常约球", "个人", "完全不动", "仅 ELO"],
            ["学院赛（新）", "学院", "全新", "单打小场仅 ELO（按一级 K=32），双打不计，无名次分"],
        ],
        widths=[3.0, 2.2, 3.0, 8.0],
    )

    heading(doc, "1.2 分层与镜像约定", 2)
    bullet(doc, "纯逻辑放 miniprogram/utils/；门面与视图模型放 miniprogram/services/；页面只调用服务层。")
    bullet(doc, "所有纯逻辑模块必须登记进 tools/sync-cloud-lib.js 的 MANIFEST，镜像到 cloudfunctions/data/lib/。")
    bullet(doc, "云函数新增的编排逻辑放 cloudfunctions/data/src/core/，不参与镜像。")
    bullet(doc, "每轮改动后执行 npm run sync:cloud 与 npm run check:cloud-sync。")

    heading(doc, "1.3 复用与不复用", 2)
    table(
        doc,
        ["能力", "是否复用现有实现", "说明"],
        [
            ["ELO 计算", "复用", "utils/elo.js、rating.js 原样用于小场"],
            ["局分 / 赛制", "复用", "match-format.js 判定小场胜负"],
            ["签表工具", "复用", "utils/bracket.js 的抽签与种子分散逻辑，槽位改为学院"],
            ["个人报名与 results", "不复用", "学院赛用名单制与学院名次，语义不同"],
            ["个人赛事回放", "有限复用", "小场进回放计 ELO，学院赛不进积分结算"],
        ],
        widths=[3.4, 3.4, 9.4],
    )

    # ---------------- 二、数据模型 ----------------
    heading(doc, "二、数据模型设计", 1)

    heading(doc, "2.1 常量与枚举（miniprogram/utils/constants.js）", 2)
    table(
        doc,
        ["常量", "取值", "用途"],
        [
            ["COLLEGES", "26 所学院全名（不含「其他」）", "注册必选；学院主键即全名"],
            ["LEG_DISCIPLINE", "MS 男单 / WS 女单 / MD 男双 / WD 女双 / XD 混双", "小项项目池，可重复出现"],
            ["TIE_ALGO", "FULL_POINTS 打满比净胜 / FIRST_TO_N 先到 N 场胜", "大场胜负算法，管理员发布时二选一"],
            ["TIE_NET_MODE", "WIN_DIFF 小场胜场差 / POINT_DIFF 累计局分净胜", "「打满比净胜」的净胜口径，管理员发布时二选一"],
            ["MATCH_OUTCOME", "NORMAL 正常打完 / FORFEIT 弃权", "区分正常场次与弃权场次"],
            ["COLLEGE_EVENT_STATUS", "报名中 / 待开赛 / 进行中 / 已结束", "学院赛专用状态机"],
            ["TIE_STATUS", "待排阵 / 待开赛 / 进行中 / 已结束", "大场独立状态（支持大场级开始）"],
        ],
        widths=[3.6, 6.4, 6.2],
    )
    para(doc, "COLLEGES 从 auth.js 迁到 constants.js，让云函数共享库一起拿到；auth.js 的校验改为引用常量。")

    heading(doc, "2.2 users 变更", 2)
    bullet(doc, "沿用现有 college 字段（学院全名）作为唯一学院标识，不新增 collegeCode（D3、D4）。")
    bullet(doc, "role 语义明确：0 会员、1 干事（学院负责人）、2 管理员。干事的管理范围由其 college 决定。")
    bullet(doc, "学院在注册时必选且不可改；设干事时自动取该字段作为范围（D9）。")

    heading(doc, "2.3 新增集合", 2)
    para(doc, "学院赛共新增 4 个集合；小场复用现有 matches 集合，只增加归属字段。")
    table(
        doc,
        ["集合", "存什么", "关键字段"],
        [
            ["college_events", "学院赛本体", "_id、title、format、status、startTime、location、description、legPlan、allowMultiEntry、rosterMin、rosterMax、tieAlgo、tieNetMode、currentRound、seedColleges、results、publisherId、publishTime、startedAt"],
            ["college_entries", "各学院名单", "_id、eventId、college、members[]、status、submittedBy、submitTime、reviewedBy、reviewedAt、reason"],
            ["ties", "大场（学院对学院）", "_id、eventId、round、stage、slot、collegeA、collegeB、legs[]、winner、status、lineupA/lineupB、startedAt、finishedAt"],
            ["lineups", "出场安排（按大场、按学院）", "_id、eventId、tieId、college、entries[{legNo, discipline, players[]}]、submittedBy、submitTime、carriedFrom"],
        ],
        widths=[3.0, 3.4, 9.8],
    )

    heading(doc, "2.4 matches 的扩展字段", 2)
    para(doc, "小场写进现有 matches 集合，以便直接复用 ELO 回放。新增字段如下，个人赛不受影响：")
    table(
        doc,
        ["字段", "含义"],
        [
            ["competition", "固定为 'college'，用于把学院赛小场与个人赛区分开"],
            ["collegeEventId", "所属学院赛"],
            ["tieId", "所属大场"],
            ["legNo", "第几场"],
            ["discipline", "MS / WS / MD / WD / XD"],
            ["collegeA / collegeB", "双方学院（便于权限判定与展示）"],
            ["outcome", "NORMAL / FORFEIT；弃权场次不计 ELO，但仍参与大场汇总与名次积分"],
            ["forfeitBy", "弃权方（个人 userId 或一方学院），用于判定「对手直接晋级」"],
        ],
        widths=[4.2, 12.0],
    )
    callout(doc, "个人赛与日常约球不带 competition 字段，回放默认按个人赛处理，因此新增字段不会影响既有流水。", "说明")
    callout(doc, "弃权同样作用于个人赛：个人赛不写 competition，但写 outcome=FORFEIT 与 forfeitBy；回放识别到弃权即跳过 ELO 结算。", "弃权字段")

    heading(doc, "2.5 主键设计", 2)
    para(doc, "小场不能沿用个人赛的自然键（会撞记录），全部改为「赛事内唯一键」，从根上避免冲突：")
    table(
        doc,
        ["对象", "主键", "说明"],
        [
            ["学院赛", "ce_<md5(发布人|标题|开始时间)>", "与个人赛 eventNaturalKey 同构"],
            ["名单", "cen_<eventId>_<md5(学院)>", "同一赛事同一学院唯一"],
            ["大场", "t_<eventId>_<round>_<stage>_<slot>", "签表位置唯一"],
            ["小场", "l_<eventId>_<tieId>_<legNo>", "赛事内唯一，绕开自然键"],
            ["出场安排", "ln_<tieId>_<md5(学院)>", "一场一院一份（大场级，不是赛事级）"],
        ],
        widths=[2.6, 6.4, 7.2],
    )

    heading(doc, "2.6 一次学院赛的数据流（含两级开赛与轮次推进）", 2)
    numbered(doc, "管理员发布 college_events：小项序列、兼项开关、名单上下限、胜负算法（tieAlgo）与净胜口径（tieNetMode）。")
    numbered(doc, "各学院负责人提交 college_entries（名单，含替补）→ 管理员审核。")
    numbered(doc, "报名截止或学院报满 → 管理员手工指定种子 → 点「抽签」：名单锁定，学院进签表。")
    numbered(doc, "管理员点赛事级「开始」：赛事进入进行中，系统自动生成第一轮各场 ties（大场）。")
    numbered(doc, "对每一场大场：双方干事各提交一次 lineups（本大场各小项参赛者，必须在名单内），可自动沿用上次。")
    numbered(doc, "双方排阵齐 → 管理员点该大场的「开始」→ 逐个小项写 matches 小场并录分确认。")
    numbered(doc, "单打小场确认时即时结算个人 ELO；大场按 tieAlgo / tieNetMode 汇总胜负。")
    numbered(doc, "该轮所有大场打完后，系统自动生成下一轮对阵，回到第 5 步，循环至名次决出。")
    numbered(doc, "全部结束 → 管理员录入 college_events.results（学院名次），赛事结束。")

    # ---------------- 三、权限 ----------------
    heading(doc, "三、权限方案", 1)

    heading(doc, "3.1 新增判定原语", 2)
    para(doc, "在 miniprogram/services/permission.js 增加「本学院」判定，作为所有学院范围权限的基础：")
    bullet(doc, "managesCollege(actor, college)：账号有效，且（role 为管理员，或 role 为干事且 actor.college === college）。")
    bullet(doc, "管理员通行；干事仅本学院；他院一律拒绝。")

    heading(doc, "3.2 现有权限的改造清单", 2)
    table(
        doc,
        ["现有能力", "现状", "改造后"],
        [
            ["代签到", "干事全局可用", "干事仅本学院（个人赛同样收口）"],
            ["录入比分", "干事任意场", "干事仅本学院涉及的场次"],
            ["发布 / 抽签 / 开赛 / 结束", "管理员", "不变"],
            ["确认比分", "对手方 + 管理员", "不变"],
            ["撤销比赛", "管理员任意 / 本人录入", "仅管理员（2026-09-14 修订：撤销改写已生效的账本，录入者一并收回）"],
        ],
        widths=[3.6, 4.2, 8.4],
    )

    heading(doc, "3.3 头像设为干事", 2)
    bullet(doc, "新增 action：setCollegeLeader（仅管理员）。")
    bullet(doc, "校验目标账号在册、college 非空，把 role 置为干事；范围自动取其 college。")
    bullet(doc, "入口：管理员在会员列表 / 个人主页点用户头像，出现「设为干事」。")
    bullet(doc, "降权同样走这个入口，把 role 置回会员。")

    heading(doc, "3.4 学院赛权限总表", 2)
    table(
        doc,
        ["操作", "会员", "干事（本学院）", "管理员"],
        [
            ["发布学院赛", "不可", "不可", "可"],
            ["提交 / 修改本学院名单", "不可", "可", "可"],
            ["审核名单", "不可", "不可", "可"],
            ["抽签 / 手工指定种子", "不可", "不可", "可"],
            ["提交本学院出场安排 / 换替补", "不可", "可", "可"],
            ["点开始比赛", "不可", "不可", "可"],
            ["录入小场比分", "仅本人参赛", "可（本学院）", "可"],
            ["录入学院名次 / 结束赛事", "不可", "不可", "可"],
        ],
        widths=[5.0, 3.0, 3.6, 3.6],
    )

    # ---------------- 四、云函数接口 ----------------
    heading(doc, "四、云函数接口设计（新增到 data）", 1)
    para(doc, "沿用现有 dispatch 机制：action + payload + 云端校验，全部写操作走云函数。")
    table(
        doc,
        ["action", "作用", "权限", "要点"],
        [
            ["publishCollegeEvent", "发布学院赛", "管理员", "校验小项序列非空、人数上下限合法"],
            ["getCollegeEvents / getCollegeEvent", "学院赛列表 / 详情", "登录", "读接口"],
            ["submitCollegeEntry", "提交 / 修改本学院名单", "干事（本学院）/ 管理员", "成员须在册且同学院；人数落在上下限内"],
            ["reviewCollegeEntry", "审核名单", "管理员", "通过 / 退回并记录理由"],
            ["drawCollegeEvent", "抽签 + 手工种子", "管理员", "锁定名单，学院进签表（尚未开赛）"],
            ["startCollegeEvent", "赛事级「开始」", "管理员", "已抽签才放行；生成第一轮大场，赛事进入进行中"],
            ["getTies / getLineups", "读大场与排阵", "登录", "读接口"],
            ["submitLineup", "提交大场出场安排", "干事（本学院）/ 管理员", "参赛者须在赛事开始前已在名单内；支持自动沿用上次；换替补在此完成"],
            ["startTie", "大场级「开始」", "管理员", "双方排阵已提交才放行；之后该大场才可录分"],
            ["submitLegScore", "录入小场比分", "参赛者 / 干事（本学院）/ 管理员", "小场归属校验"],
            ["confirmLegScore", "确认小场比分", "对手方 / 管理员", "确认即结算个人 ELO（弃权场跳过）"],
            ["recordForfeit", "记弃权", "管理员；个人赛本人可自弃", "弃权不计 ELO，对手直接晋级；小组赛记对手胜"],
            ["advanceRound", "生成下一轮对阵", "系统自动 / 管理员触发", "该轮大场全部结束后自动推进"],
            ["finishCollegeEvent", "录入学院名次并结束", "管理员", "只记学院，不产生个人积分；对手因弃权获胜不影响其排名分"],
            ["setCollegeLeader", "设为 / 撤销干事", "管理员", "由目标账号的 college 决定范围"],
        ],
        widths=[3.6, 4.0, 3.4, 5.2],
    )

    # ---------------- 五、计分与回放 ----------------
    heading(doc, "五、计分与回放改造", 1)

    heading(doc, "5.1 个人 ELO（小场）", 2)
    bullet(doc, "小场写进 matches，参与 ELO 回放，赛事等级固定按一级（K=32）。")
    bullet(doc, "单打小场确认后立即结算并让缓存失效，做到「立刻生效」（D32）。")
    bullet(doc, "双打小场（男双 / 女双 / 混双）不计 ELO（D25）。")

    heading(doc, "5.2 赛事积分（分流）", 2)
    callout(doc, "学院赛不产生任何个人赛事积分。回放在结算积分时，凡 competition 为 college 的小场与其学院赛，一律跳过。", "关键")

    heading(doc, "5.3 学院名次", 2)
    bullet(doc, "college_events.results 形如 [{college, placement}]，与个人赛 results 结构隔离。")
    bullet(doc, "名次只用于学院赛展示，不进入个人积分结算（D26）。")

    heading(doc, "5.4 赛季", 2)
    bullet(doc, "学院赛计入赛季的只有个人 ELO。等级分不做赛季重置，跨赛季连续累计（D27）。")
    bullet(doc, "学院赛自身不做赛季归档，不做学院榜（D26）。")

    heading(doc, "5.5 弃权（通用规则，学院赛与个人赛共用）", 2)
    table(
        doc,
        ["环节", "处理"],
        [
            ["入口", "大场：管理员记弃权；个人赛：本人自选弃权（D41）"],
            ["ELO", "回放识别 outcome=FORFEIT 即整场跳过，双方都不产生等级分变化（D41）"],
            ["大场汇总", "弃权小项按对手获胜计入，用于大场胜负（D41）"],
            ["小组赛", "小组内记对手胜、正常累积小组积分，但同样不计 ELO（D42）"],
            ["晋级", "对手直接进入下一轮，无需再打（D41）"],
            ["排名分", "对手因对方弃权获胜后，其来自最终排名的赛事积分照旧计算（D43）"],
            ["防呆", "干事未排人不能提交排阵，未提交排阵的大场不能开始，从源头减少弃权（D40）"],
        ],
        widths=[2.8, 13.4],
    )

    # ---------------- 六、页面 ----------------
    heading(doc, "六、页面与交互改造", 1)
    table(
        doc,
        ["页面", "用途", "主要角色"],
        [
            ["学院赛列表 / 详情", "展示学院赛、大场、小场、学院名次", "全部"],
            ["学院赛发布页", "配置小项序列、兼项、名单上下限、胜负算法与净胜口径", "管理员"],
            ["名单提交页", "勾选本学院队员，提交 / 修改名单（含替补）", "干事"],
            ["名单审核页", "审核各学院名单", "管理员"],
            ["排阵页", "针对某个大场提交出场安排；自动沿用上次；换替补", "干事"],
            ["大场 / 小场页", "查看对阵、点大场「开始」、录分、确认、记弃权", "参赛者 / 干事 / 管理员"],
            ["学院名次录入页", "录入并结束赛事", "管理员"],
            ["头像设干事入口", "在会员列表 / 主页设或撤干事", "管理员"],
        ],
        widths=[4.0, 8.0, 4.2],
    )
    bullet(doc, "沿用现有「会员审核页」的交互范式做名单审核页，降低新页面成本。")
    bullet(doc, "现有赛事列表页需要把学院赛并入展示（数据源合并，UI 复用）。")

    # ---------------- 七、测试与镜像 ----------------
    heading(doc, "七、测试与镜像", 1)
    table(
        doc,
        ["类别", "内容"],
        [
            ["常量测试", "COLLEGES 为 26 所、不含「其他」；注册校验命中名单"],
            ["权限测试", "managesCollege：管理员通行、干事仅本学院、他院与会员拒绝"],
            ["名单测试", "本学院校验、在册校验、人数上下限、同赛事一院一份"],
            ["排阵测试", "自动沿用上次、换替补、同一小项禁止重复出场、兼项开关、未排人不可提交"],
            ["开赛测试", "赛事级开始需已抽签；大场级开始需双方排阵齐"],
            ["大场测试", "两种胜负算法 × 两套净胜口径的汇总正确性"],
            ["计分测试", "单打小场计 ELO 不计积分；双打不计；确认即生效"],
            ["弃权测试", "弃权场不计 ELO；对手晋级；小组赛记对手胜；排名分照旧；未排人不可提交/开赛"],
            ["回放回归", "个人赛与日常约球结果不受新增字段影响"],
            ["镜像校验", "新增纯模块登记进 MANIFEST，check:cloud-sync 通过"],
            ["全量回归", "现有测试全部保持通过"],
        ],
        widths=[3.0, 13.2],
    )

    # ---------------- 八、施工分期 ----------------
    heading(doc, "八、施工分期与任务分解", 1)
    para(doc, "按里程碑顺序推进，后一个里程碑依赖前一个的产出，不给出时间估算，以完成度与依赖为准。")
    para(doc, "截至 2026-09-12，M0–M6 已全部完成并逐项验收：1635 条自动化测试全绿（153 个套件），云函数镜像 27 个文件同步，端到端与弃权路径演练均通过。下表各里程碑标题前的「已完成」标记即为其状态。")

    heading(doc, "【已完成】M0 学院身份与注册（地基）", 2)
    table(
        doc,
        ["任务", "内容", "涉及文件", "验收"],
        [
            ["M0-1", "COLLEGES 改为 26 所并迁到 constants.js，去掉「其他」", "utils/constants.js、services/auth.js", "注册页为 26 所，必选，选不到「其他」"],
            ["M0-2", "同步 auth 校验与登录页引用", "pages/login/*", "不选学院不能提交，报「请选择所属学院」"],
            ["M0-3", "改模拟数据里的学院取值", "services/seed.js", "模拟会员全部落在 26 所名单内"],
            ["M0-4", "补常量与注册测试", "tests/auth.test.js 等", "测试通过，全量回归无红色"],
        ],
        widths=[1.6, 5.6, 4.4, 4.6],
    )

    heading(doc, "【已完成】M1 干事 = 学院负责人", 2)
    table(
        doc,
        ["任务", "内容", "涉及文件", "验收"],
        [
            ["M1-1", "新增 managesCollege 原语", "services/permission.js", "单测覆盖四种组合"],
            ["M1-2", "代签到 / 录分收口到本学院", "services/event.js、mock.js、云核心", "他院干事被拒，本学院放行"],
            ["M1-3", "头像设 / 撤干事 action 与入口", "services/member*.js、云核心、member 页面", "管理员设置后，被设者按本学院获权"],
            ["M1-4", "补权限测试 + 同步镜像 + 回归", "tests/*.test.js、sync:cloud", "全部通过"],
        ],
        widths=[1.6, 5.6, 4.4, 4.6],
    )

    heading(doc, "【已完成】M2 学院赛发布与名单制报名", 2)
    table(
        doc,
        ["任务", "内容", "涉及文件", "验收"],
        [
            ["M2-1", "学院赛常量与数据结构", "utils/constants.js、services/college-event.js", "单测通过"],
            ["M2-2", "发布学院赛页面与接口", "pages/college-event-edit、云核心", "管理员可发布，配置项完整"],
            ["M2-3", "名单提交（干事）", "pages/college-entry、云核心", "本学院提交成功，他院/会员被拒"],
            ["M2-4", "名单审核（管理员）", "pages/college-entry-review", "通过 / 退回可用"],
            ["M2-5", "名单人数上下限、替补口径", "services/college-entry.js", "名单内未上场即替补，人数校验正确"],
            ["M2-6", "补测试 + 镜像 + 回归", "tests/college-entry.test.js", "全部通过"],
        ],
        widths=[1.6, 5.6, 4.4, 4.6],
    )

    heading(doc, "【已完成】M3 抽签、大场与排阵", 2)
    table(
        doc,
        ["任务", "内容", "涉及文件", "验收"],
        [
            ["M3-1", "学院签表 + 手工指定种子", "services/college-draw.js、utils/bracket.js", "抽签锁定名单，学院进签表"],
            ["M3-2", "抽签即锁定名单", "云核心", "抽签后名单不可改"],
            ["M3-3", "赛事级「开始」+ 首轮大场生成", "services/college-tie.js、云核心", "未抽签不能开始；开始时生成第一轮各场大场"],
            ["M3-4", "大场展示与大场级「开始」", "pages/college-event-detail", "大场列表正确；双方排阵齐才能点该大场开始"],
            ["M3-5", "排阵页：提交 + 自动沿用上次 + 换替补", "pages/college-lineup、services/college-lineup.js", "沿用默认值正确；换替补生效；未排人不能提交"],
            ["M3-6", "补测试 + 镜像 + 回归", "tests/college-tie.test.js 等", "全部通过"],
        ],
        widths=[1.6, 5.6, 4.4, 4.6],
    )

    heading(doc, "【已完成】M4 小场录分与大场汇总（含 ELO 立刻生效）", 2)
    table(
        doc,
        ["任务", "内容", "涉及文件", "验收"],
        [
            ["M4-1", "小场写库与归属字段", "services/match-record.js、云核心", "小场键唯一，无撞库"],
            ["M4-2", "录分 / 确认与权限", "pages/college-match、services/match-record.js", "参赛者或本学院干事可录，对手可确认"],
            ["M4-3", "单打小场即时结算 ELO", "回放与缓存失效", "确认后个人 ELO 立刻变化"],
            ["M4-4", "双打小场不计分", "回放分流", "双打小场不改变任何个人分"],
            ["M4-5", "大场汇总（两种算法 × 两套净胜口径）", "services/college-tie.js", "四种组合结果正确"],
            ["M4-6", "下一轮对阵自动生成", "services/college-tie.js、云核心", "本轮全部结束后自动生成下一轮"],
            ["M4-7", "弃权：管理员记弃权（大场）", "云核心、pages/college-match", "弃权场不计 ELO，对手直接晋级"],
            ["M4-8", "补计分测试 + 回归", "tests/college-score.test.js", "全部通过"],
        ],
        widths=[1.6, 5.6, 4.4, 4.6],
    )

    heading(doc, "【已完成】M5 学院名次、个人赛弃权与结束", 2)
    table(
        doc,
        ["任务", "内容", "涉及文件", "验收"],
        [
            ["M5-1", "学院名次录入页", "pages/college-placement", "可录入并结束赛事；对手因弃权获胜不影响其排名分"],
            ["M5-2", "学院赛 results 与个人分隔离", "回放分流", "录入名次不产生个人积分"],
            ["M5-3", "弃权推广到个人赛：本人自选弃权", "services/event.js、回放分流、页面", "个人赛可自弃；弃权不计 ELO；对手晋级；小组赛记对手胜"],
            ["M5-4", "赛事列表并入学院赛", "pages/events", "列表同时展示个人赛与学院赛"],
            ["M5-5", "补测试 + 回归", "tests/college-event.test.js、tests/forfeit.test.js", "全部通过"],
        ],
        widths=[1.6, 5.6, 4.4, 4.6],
    )

    heading(doc, "【已完成】M6 收尾与整体验收", 2)
    table(
        doc,
        ["任务", "内容", "验收"],
        [
            ["M6-1", "全量回归与镜像校验", "测试全绿，check:cloud-sync 通过"],
            ["M6-2", "权限矩阵复核（四种角色 × 学院赛操作）", "无越权路径"],
            ["M6-3", "更新《赛事管理员操作手册》与《云开发控制台操作指南》", "文档与实现一致"],
            ["M6-4", "端到端演练：发布→名单→抽签→开始→首轮大场→排阵→大场开始→录分→下一轮→名次", "完整跑通一场学院赛"],
            ["M6-5", "弃权路径演练：大场未排人不可开赛；开赛后记弃权；个人赛自弃权", "规则闭环，分数不被误算"],
        ],
        widths=[1.6, 8.0, 6.6],
    )

    # ---------------- 九、风险 ----------------
    heading(doc, "九、风险与对策", 1)
    table(
        doc,
        ["风险", "影响", "对策"],
        [
            ["小场主键与个人赛撞库", "记录被覆盖或返回脏数据", "小场统一用赛事内键 l_<eventId>_<tieId>_<legNo>"],
            ["回放引擎遇到学院 id 抛错", "数据读取直接失败", "大场不进回放，只把真实选手的小场喂给回放"],
            ["干事越权（管理他院）", "权限事故", "所有写操作先过 managesCollege，服务端与前端同口径"],
            ["ELO 立刻生效与缓存不一致", "分数显示滞后", "确认后 bump 赛季缓存版本，读数前强制重算"],
            ["沿用排阵与换替补边界", "出场人错误", "沿用只作默认值，提交时按赛事配置重新校验"],
            ["学院名写法不一致", "对阵匹配失败", "学院只取 26 所常量全名，禁止自由输入"],
            ["弃权被误算成正常比分", "ELO 被错误结算", "弃权场写 outcome=FORFEIT，回放先判 outcome 再结算，单测覆盖"],
            ["轮次推进遗漏或重复生成大场", "对阵错乱 / 重复", "以 (eventId, round, slot) 做幂等键，生成前先查重"],
            ["两级开始状态不同步", "大场可被越级开赛", "大场级开始必须校验赛事已开始且双方排阵已提交"],
        ],
        widths=[3.4, 4.0, 8.8],
    )

    # ---------------- 十、验收 ----------------
    heading(doc, "十、里程碑验收清单", 1)
    table(
        doc,
        ["里程碑", "可验收结果", "状态"],
        [
            ["M0", "注册必须从 26 所学院中选一个，无「其他」；模拟数据全部合规", "已完成"],
            ["M1", "干事只能管本学院；管理员可通过头像任命干事并自动授权", "已完成"],
            ["M2", "学院负责人可提交名单，管理员可审核，人数与替补口径正确", "已完成"],
            ["M3", "抽签锁定名单；赛事级开始生成首轮大场；排阵可自动沿用上次并换替补；未排人不能提交", "已完成"],
            ["M4", "大场级开始需双方排阵齐；小场可录分确认；单打 ELO 立刻生效，双打不计分；四种汇总组合正确；胜者晋级下一轮", "已完成"],
            ["M5", "学院名次可录入，赛事结束；个人积分不受影响；弃权在学院赛与个人赛均可用且不计 ELO", "已完成"],
            ["M6", "全量回归通过，文档同步，端到端与弃权路径演练成功", "已完成"],
        ],
        widths=[2.0, 12.6, 1.6],
    )

    # ---------------- 十一、遗留问题（已闭环） ----------------
    heading(doc, "十一、遗留问题（已闭环）", 1)
    para(doc, "原先的三个遗留问题已全部拍板，相应改动已并入上表与《学院赛设计方案》2.8 / 6.8。")
    table(
        doc,
        ["编号", "问题", "结论"],
        [
            ["S1", "「打满比净胜」的净胜按什么算", "两套口径（小场胜场差 / 累计局分净胜）都实现，管理员发布时二选一（TIE_NET_MODE）"],
            ["S2", "「开始比赛」的粒度", "两级：赛事级统一「开始」并生成首轮；之后每个大场各自「开始」"],
            ["S3", "未到场 / 未排人如何判弃权", "未排人不可提交与开赛；开赛后由管理员记弃权；个人赛本人可自弃；弃权不计 ELO、对手晋级、小组赛记对手胜、排名分照旧"],
        ],
        widths=[1.4, 4.6, 10.2],
    )

    closing = doc.add_paragraph()
    closing.paragraph_format.space_before = Pt(16)
    run = closing.add_run("—— 施工结束。M0–M6 已按顺序全部完成并逐项验收：1635 条自动化测试全绿（153 个套件）、云函数镜像 27 个文件同步、端到端与弃权路径演练通过；后续实现改动请同步回本文件。——")
    set_font(run, size=9.5, color=MUTED)

    return doc


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "学院赛施工规划.docx"
    doc = build()
    doc.save(out)
    print(f"已生成：{out}")


if __name__ == "__main__":
    main()
