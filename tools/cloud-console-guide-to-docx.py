"""
把「云开发控制台操作指南」排版成 Word 文档。

用法：
    python tools/cloud-console-guide-to-docx.py [输出.docx]

依赖 python-docx。默认输出到仓库根目录的「云开发控制台操作指南.docx」。
内容与小程序当前实现、cloudfunctions/README.md 严格对应；改集合结构、
云函数 action 或权限门槛时，请一并更新本文件。
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
ENV_ID = "cloud1-d7g9o5ift32b465d7"


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


def code(doc, text):
    paragraph = doc.add_paragraph()
    paragraph.paragraph_format.left_indent = Cm(0.75)
    paragraph.paragraph_format.space_after = Pt(4)
    run = paragraph.add_run(text)
    run.font.name = "Consolas"
    run.font.size = Pt(10)
    run.font.color.rgb = RGBColor(0x1F, 0x4E, 0x79)
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
    run = title.add_run("中央民族大学石榴籽体育管理小程序")
    set_font(run, size=13, bold=True, color=MUTED, ea=HEAD_EA)

    subtitle = doc.add_paragraph()
    subtitle.alignment = WD_ALIGN_PARAGRAPH.CENTER
    subtitle.paragraph_format.space_after = Pt(2)
    run = subtitle.add_run("云开发控制台操作指南")
    set_font(run, size=26, bold=True, color=ACCENT, ea=HEAD_EA)

    tagline = doc.add_paragraph()
    tagline.alignment = WD_ALIGN_PARAGRAPH.CENTER
    tagline.paragraph_format.space_after = Pt(12)
    run = tagline.add_run("建集合 / 审核会员 / 调整角色 / 赛季更新 / 数据救急 / 更新云函数")
    set_font(run, size=11, color=MUTED)

    table(
        doc,
        ["项目", "说明"],
        [
            ["适用对象", "管理员（需要进入微信云开发控制台的人）"],
            ["云环境 ID", ENV_ID],
            ["云函数", "data（本环境唯一云函数，承载全部读写接口）"],
            ["最容易忘", "改完代码务必重新「上传并部署」cloudfunctions/data；忘了就会报「未知的操作：xxx」（详见第九节）"],
            ["核心原则", "小程序端不直接读写数据库；一切写操作都经云函数 data 完成，控制台只用于初始化、审核、提权、赛季更新与救急"],
            ["集合规模", "个人赛与公共 10 个 + 学院赛 4 个（college_events / college_entries / ties / lineups），共 14 个；学院赛与个人赛互不共用集合"],
        ],
        widths=[3.0, 13.2],
    )
    callout(doc, "本指南里的每一步都对应仓库里真实存在的集合与接口。若控制台界面与你看到的不完全一致，以微信开发者工具当前版本为准。", "说明")
    callout(
        doc,
        "改完代码（尤其是新增了接口、或改了 miniprogram/ 下的共享逻辑）之后，务必回微信开发者工具右键 cloudfunctions/data →「上传并部署：云端安装依赖」。"
        "云函数不会随小程序编译自动更新——只改代码、忘了部署，线上跑的还是旧包：新增的接口会报「未知的操作：xxx」，改过的规则也不会生效。"
        "本项目全部接口都挤在这一个 data 函数里，它不更新，新功能一律不生效。养成习惯：每次动完代码，先问自己一句「data 部署了吗」。判断依据是控制台 → 云函数 → data 的「更新时间」，没重新部署它就不会变。",
        "最容易忘的一步",
    )

    # ---------------- 一、控制台入门 ----------------
    heading(doc, "一、云开发控制台入门", 1)

    heading(doc, "1.1 从哪里打开", 2)
    numbered(doc, "用管理员微信登录「微信开发者工具」，打开本项目。")
    numbered(doc, "点顶部工具栏的「云开发」按钮，进入云开发控制台；首次可能需要开通并实名。")
    numbered(doc, "左上角确认当前环境是 " + ENV_ID + "。可点环境名切换，或到「设置 → 环境设置」查看环境 ID。")
    bullet(doc, "小程序管理后台（mp.weixin.qq.com）里没有云开发控制台，必须从开发者工具进入。")
    bullet(doc, "日常只用到四块：数据库、云函数、存储、设置。")

    heading(doc, "1.2 必须先理解的权限模型", 2)
    para(doc, "这套小程序的设计是「数据库对小程序端完全关闭，读写全部走云函数」。原因有二：一是分数、权限、赛果都涉及规则校验，放在云函数里才不会被人绕过；二是集合权限设成最严之后，会员端拿到数据库地址也读不到任何东西。")
    table(
        doc,
        ["层面", "谁能访问", "说明"],
        [
            ["小程序端", "不直接读写数据库", "页面只调用云函数 data，不持有集合权限"],
            ["云函数 data", "全量读写", "以管理员身份运行，不受集合安全规则限制"],
            ["云控制台", "全量读写", "管理员人工操作；绕过一切业务校验，改前请三思"],
        ],
        widths=[3.0, 4.0, 9.2],
    )
    callout(doc, "控制台改动是「没有护栏」的。小程序里的每一步都有权限与校验，控制台直接改库没有。能走小程序就优先走小程序，控制台只用于小程序做不到或救急的场景。", "注意")

    # ---------------- 二、集合总览 ----------------
    heading(doc, "二、数据库集合总览", 1)
    para(doc, "环境里一共有 14 个业务集合：个人赛与公共集合 10 个、学院赛 4 个。名称必须与下表完全一致（区分大小写与下划线）。")
    para(doc, "个人赛与公共集合：", bold=True)
    table(
        doc,
        ["集合名", "存什么", "必建", "关键字段"],
        [
            ["users", "会员档案与入会申请（同一集合，用 status 区分）。账号全局一份，不按协会拆分", "是", "openId、nickName、realName、gender('M'/'F')、role(0/2)、status(0/1/2/3)、initialEloByAssoc（按协会的初始分小表，如 {pkb:1500}）、joinDate、college"],
            ["memberships", "协会角色表：某人于某协会的学院负责人 / 协会负责人。无行 = 普通会员（多协会改造新增）", "是", "_id('mb_'+md5(userId|协会))、userId、association、role('staff'学院负责人/'leader'协会负责人)、updatedAt"],
            ["matches", "比赛流水，等级分的唯一来源（含学院赛小场）", "是", "_id、association、matchType、pool、teamA、teamB、scoreA、scoreB、winner、status(0/1/2)、matchTime、eventId、competition、collegeEventId、tieId、outcome、forfeitBy"],
            ["events", "个人赛事", "是", "_id、association、title、matchType、format、level、groupCount、advancePerGroup、status(0/1/2)、results、draw"],
            ["event_signups", "赛事报名与签到", "是", "_id、association、eventId、userId、status(0已取消/1已报名/2已签到)、signTime、checkInTime"],
            ["announcements", "公告", "是", "_id、association、title、content、category、pinned、status('published'/'archived')、publishTime"],
            ["live_scores", "实时比分的过程态，一场一条（_id='ls_'+比赛id）；定稿后转写进 matches（实时比分功能新增）", "是", "_id、association、matchId、…（只存逐球计分的中间态，定稿后落正规比分）"],
            ["seasons", "赛季锚点，按协会各一条 _id='current_<协会>' 的记录（如 current_pkb）", "是", "_id、association、anchorTime、resetTime、seasonNumber、version、algoVersion"],
            ["rankings", "排行榜快照，按协会各一条 _id='current_<协会>' 的记录（纯缓存，删了会自动重算）", "是", "_id、association、key、algoVersion、savedAt、data（整份数据集）"],
            ["audit_logs", "写操作留痕（预留，当前不写入）", "可选", "association 等"],
        ],
        widths=[2.6, 5.0, 1.6, 7.0],
    )
    para(doc, "学院赛集合（独立成体系，不与个人赛共用）：", bold=True)
    table(
        doc,
        ["集合名", "存什么", "必建", "关键字段"],
        [
            ["college_events", "学院团体赛，与 events 平行", "是", "_id、title、legPlan（小项序列）、allowMultiEntry、rosterMin/Max、tieAlgo、tieNetMode、status(0报名中/1待开赛/2进行中/3已结束)、draw、results"],
            ["college_entries", "各学院参赛名单，键为「赛事 + 学院」", "是", "_id、eventId、college、members（队员编号数组）、status(0待审核/1已通过/2已退回)、submittedBy、reviewedBy、reason"],
            ["ties", "大场：两院之间的一轮对抗", "是", "_id、eventId、round、stage、slot、collegeA、collegeB、legs（小项结果数组）、winner、status(0待排阵/1待开赛/2进行中/3已结束)、lineupA/lineupB"],
            ["lineups", "大场排阵，键为「大场 + 学院」", "是", "_id、eventId、tieId、college、entries（[{legNo, discipline, players}]）、submittedBy、submitTime、carriedFrom"],
        ],
        widths=[2.6, 5.0, 1.6, 7.0],
    )
    heading(doc, "2.1 多协会：内容按协会分区（本次改造新增）", 2)
    para(doc, "小程序已从「一个匹克球俱乐部」扩成「多个体育协会」共用同一环境（首批：pkb 匹克球、tt 乒乓、bd 羽球）。协会清单写在代码注册表 miniprogram/utils/associations.js 里，环境里没有也不需要有 associations 集合。改造后按协会分区的做法如下：")
    table(
        doc,
        ["方面", "改造前", "改造后"],
        [
            ["账号", "每个账号属于一个俱乐部", "账号全局一份（users 不按协会拆），一人可同时属于多个协会"],
            ["内容归属", "文档不带协会字段", "所有内容文档带 association 字段（pkb/tt/bd），读时按它过滤、写时由云函数盖章"],
            ["角色", "角色全在 users.role（0/1/2）", "两级：全局角色在 users.role（0/2）；协会角色在 memberships（staff/leader），按协会各记一行"],
            ["赛季 / 榜单单例", "seasons、rankings 各一条 _id='current'", "按协会各一条 _id='current_<协会>'（current_pkb / current_tt / current_bd）"],
            ["自然键", "_id 不含协会", "生成 _id 时并入 association；旧文档 _id 不变"],
        ],
        widths=[2.6, 5.6, 8.0],
    )
    para(doc, "带 association 字段的集合：matches、events、event_signups、announcements、college_events、college_entries、ties、lineups、live_scores、audit_logs。users 是全局账号，不带 association。", muted=True)
    callout(
        doc,
        "接入既有线上数据时，按「加字段、不重排主键」三步迁移：①新建 memberships 集合；②把 matches / events / event_signups / "
        "announcements / college_events / college_entries / ties / lineups / live_scores / audit_logs 里缺 association 的文档批量补成 'pkb'；"
        "③把 seasons、rankings 各那条 _id='current' 重命名为 'current_pkb'。旧文档在补字段之前会被当成 pkb 读出（代码对「缺字段」按 pkb 处理），"
        "所以务必补全，否则新协会的数据会与旧数据混在一起。",
        "迁移要点",
    )

    callout(doc, "event_signups 必须建。cloudfunctions/README.md 里曾写「报名集合不必建」，那是旧版本的说法；现在的报名与签到都会写这个集合，缺了它报名会直接报错。", "关键")
    callout(doc, "学院赛的 4 个集合同样必须建。college_events 与 college_entries 缺一不可，ties 与 lineups 在「开始赛事」后就会写入；少建任何一个，学院赛都会在对应步骤直接报错。", "关键")
    para(doc, "rankings 也必须建。它存的是「重放结果的落库缓存」——云函数冷启动时先读它，省掉全表读与两遍重放。它是纯缓存：键由赛季版本号 + 算法版本 + 锚点拼成，任何写操作让版本号 +1，旧快照即作废；读不到或读坏了都会退回现场重算，所以删掉它只会让下一次读变慢，不会算错分数。")
    para(doc, "等级分仍以比赛流水为唯一事实来源：分数不落在 users 里，而是从 users + matches + events 重放算出。rankings 里那份是重放结果的缓存副本，不是权威数据，任何时候都可以整条删掉。学院赛名次也不参与个人分重放——它只写在 college_events.results 里。")

    # ---------------- 三、首次部署 ----------------
    heading(doc, "三、首次部署：集合、索引、安全规则、第一个管理员", 1)

    heading(doc, "3.1 新建集合", 2)
    numbered(doc, "数据库 → 集合管理 → 「＋ 新建集合」。")
    numbered(doc, "按第 2 节的表格逐个建个人赛与公共集合：users、memberships、matches、events、event_signups、announcements、live_scores、seasons、rankings。可选建 audit_logs。")
    numbered(doc, "再逐个建学院赛集合：college_events、college_entries、ties、lineups。")
    numbered(doc, "集合名一个字都不能差，建错名字等于没建。memberships 是多协会改造新增的协会角色表，缺了它学院负责人 / 协会负责人的任免会报错。")
    numbered(doc, "seasons 建好后，可按协会手工各新增一条 _id 形如 current_pkb / current_tt / current_bd 的文档（字段见第 6 节）；不建也能跑，系统会按默认第一赛季处理。")

    heading(doc, "3.2 建索引", 2)
    para(doc, "索引不是必须，但数据一多，没有索引的查询会明显变慢。在集合的「索引管理」里添加：")
    table(
        doc,
        ["集合", "索引字段", "是否唯一", "用途"],
        [
            ["users", "openId（升序）", "唯一", "一个微信号只能有一条账号，防重复入会"],
            ["matches", "status + matchTime", "否", "按时间拉取已生效比赛"],
            ["matches", "eventId", "否", "按赛事查比赛"],
            ["event_signups", "eventId + userId", "否", "查某场赛事某人是否报名"],
            ["announcements", "status", "否", "只取已发布公告"],
            ["events", "status", "否", "按状态筛选赛事"],
            ["college_entries", "eventId", "否", "按学院赛查名单"],
            ["ties", "eventId + round", "否", "按赛事与轮次查大场"],
            ["lineups", "eventId + tieId", "否", "按赛事或大场查排阵"],
        ],
        widths=[2.8, 4.2, 1.8, 7.4],
    )
    callout(doc, "users.openId 的唯一索引是最重要的一条。没有它，同一个微信号可能被写入多条账号，登录态与权限都会错乱。", "关键")

    heading(doc, "3.3 安全规则", 2)
    numbered(doc, "选中集合 → 「权限设置」→ 自定义安全规则。")
    numbered(doc, "把每个集合都设为「所有用户不可读写」：{\"read\": false, \"write\": false}。")
    numbered(doc, "云函数以管理员身份运行，不受这条规则影响，因此小程序功能不受任何影响。")

    heading(doc, "3.4 部署云函数 data", 2)
    numbered(doc, "左侧「云函数」列表，确认有 data 这个函数。")
    numbered(doc, "在代码目录里右键 cloudfunctions/data → 「上传并部署：云端安装依赖」。")
    numbered(doc, "首次部署会安装依赖，稍等片刻；成功后状态变为「部署成功」。")

    heading(doc, "3.5 创建第一个管理员（关键）", 2)
    para(doc, "系统里没有「内置管理员」，第一个管理员只能手工指定。推荐走小程序注册再提权：")
    numbered(doc, "用本人的微信打开小程序，走一遍「登录 / 注册」，提交入会申请。")
    numbered(doc, "到控制台 → 数据库 → users，找到刚提交的文档（status 为 0）。")
    numbered(doc, "把 role 改为 2，status 改为 1，保存。")
    numbered(doc, "重新打开小程序，即成为管理员，可以发布赛事、审核会员。")
    para(doc, "也可以直接手工新增一条 users 文档，但下面这些字段一个都不能少：")
    table(
        doc,
        ["字段", "值", "说明"],
        [
            ["_id", "u_admin（或任意唯一串）", "用户主键；云端自动生成的形如 u_<md5>"],
            ["openId", "该微信的 OpenID", "必须真实，否则登录时认不出身份"],
            ["nickName", "昵称", "展示用"],
            ["realName", "真实姓名", "展示用"],
            ["gender", "'M' 或 'F'", "缺失会让该会员从单打榜单中消失"],
            ["studentId / college / phone", "学号 / 学院 / 手机", "身份信息"],
            ["role", "2", "2=管理员，0=会员（1 已废弃；学院负责人改记 memberships）"],
            ["status", "1", "1=在册；0=待审核，2=禁用，3=离校"],
            ["joinDate", "加入日期", "展示用"],
        ],
        widths=[3.6, 4.4, 8.2],
    )
    callout(doc, "gender 字段最容易被漏掉。少了它，该会员不会出现在任何一张单打排行榜上，而且不会有任何报错提示，很难排查。", "注意")

    # ---------------- 四、会员审核 ----------------
    heading(doc, "四、日常操作一：会员审核", 1)
    para(doc, "小程序「我的 → 会员审核」页面就是干这个的，日常请优先用它。控制台适合小程序进不去或需要批量处理时。")
    table(
        doc,
        ["要做的事", "集合", "怎么改"],
        [
            ["通过一条申请", "users", "找到 status=0 的文档，把 status 改成 1，保存"],
            ["指定初始等级分", "users", "加 / 改 initialEloByAssoc 里对应协会的那一项，取 0–3000 的整数，如 { pkb: 1500 }（该协会不填则按前五场自动定级）。初始分**按协会分开存**：一个人可以在匹克球协会有指定分、在乒乓协会走自动定级。该会员在某个协会一旦打过比赛（含日常约球），那个协会的初始分即锁死，改不生效——它是回放的起评分，只在还没出场时才有意义"],
            ["驳回一条申请", "users", "把 status 改成 2（禁用），并加 reason 字段写清理由"],
        ],
        widths=[3.4, 2.4, 10.4],
    )
    bullet(doc, "判定依据：status 0=待审核、1=在册、2=禁用、3=离校；只有 1 才算正式会员。")
    bullet(doc, "控制台手工通过不会写 action 字段，但状态与数据一致，不影响分数重放。")
    bullet(doc, "改完让当事人重开小程序，登录态会重新拉取。")
    callout(doc, "不要为了「通过」而删除再新建文档。删除会换掉 _id，该会员此前的比赛记录会对不上人。", "注意")
    callout(doc, "初始等级分也能在小程序里改：打开该会员的个人主页，**还没出场**的会员会出现「调整初始等级分」入口"
                 "（对应云函数 setMemberInitialElo，带「清除」按钮可回到自动定级）。管理员跨协会都能改，协会负责人只在本协会可改；"
                 "一旦该会员在本协会打过比赛（含日常约球），入口即消失。这条与上面控制台手工改 initialEloByAssoc 等效。", "提示")

    # ---------------- 五、角色调整 ----------------
    heading(doc, "五、日常操作二：调整角色（全局管理员 / 协会负责人 / 学院负责人）", 1)
    para(doc, "多协会改造后，角色分两层，控制台里要改的地方不同：")
    bullet(doc, "全局角色：写在 users.role，只有两档——0=会员、2=管理员（全局管理员，可管所有协会）。旧版「干事」用的 1 已废弃。")
    bullet(doc, "协会角色：写在 memberships 集合，一人可因协会而异——staff=学院负责人、leader=协会负责人（在本协会内等同管理员）。无行即普通会员。")
    para(doc, "「有效角色」由两者合成：users.role=2 即为管理员；否则看本协会的 memberships 行——leader → 管理员、staff → 学院负责人、无行 → 会员。权限判定同时要求账号是在册状态（status=1）。")
    table(
        doc,
        ["想给的权限", "改哪里", "改成什么"],
        [
            ["全局管理员（管理所有协会）", "users", "role=2（并确保 status=1）"],
            ["协会负责人（只管本协会，权限同管理员）", "memberships", "新增一行：userId + association + role='leader'"],
            ["学院负责人（只管本协会、本院名单与排阵）", "memberships", "新增一行：userId + association + role='staff'"],
            ["退回普通会员", "memberships / users", "删掉该协会的 memberships 行；全局角色改回 users.role=0"],
        ],
        widths=[5.4, 3.2, 7.6],
    )
    para(doc, "memberships 一行的写法（_id 必须等于 mb_ + md5(userId|协会Id)，算错就读不到）：", bold=True)
    code(doc, "{ _id: 'mb_<md5(userId|协会Id)>', userId: 'u_xxx', association: 'pkb', role: 'staff', updatedAt: <时间> }")
    numbered(doc, "全局管理员：数据库 → users，按昵称或 realName 搜到目标会员，把 role 改成 2，确认 status=1，保存；降权改回 0。")
    numbered(doc, "协会角色（学院负责人 / 协会负责人）：数据库 → memberships，按上表新建或删除该行记录；association 写协会 id（pkb / tt / bd）。")
    numbered(doc, "要当学院负责人的，另需把该会员 users.college 填成 26 所学院之一的全名，否则他在学院赛里提交不了任何名单或排阵。")
    numbered(doc, "让对方重开小程序，权限立即生效，无需重新登录或换绑。")
    callout(doc, "role 改高了但 status 不是 1（比如还是待审核），权限照样不通过——这是最常见的「我明明设成管理员了怎么还不能发布」的原因。", "注意")
    callout(doc, "两种情况都能在小程序里做，他人主页上并排有两个入口，由页面的协会切换决定操作哪个协会："
                 "①「任免学院负责人」（对应 setCollegeLeader）——本协会的协会负责人或全局管理员都能做；"
                 "②「任免协会负责人」（对应 setAssociationLeader）——**仅全局管理员**可见（协会负责人的有效角色也是管理员，"
                 "故用账号的全局身份区分），避免协会负责人反手把自己人提成协会负责人。两个入口在控制台手工加 / 删 memberships 行的效果一致。", "提示")

    # ---------------- 六、赛季更新 ----------------
    heading(doc, "六、日常操作三：赛季更新（只能在控制台做）", 1)
    callout(doc, "小程序里已经没有任何赛季管理入口。赛季更新是「管理员在云控制台手动执行一次云函数」的动作，没有定时任务，也不会自动发生。", "关键")

    heading(doc, "6.1 赛季更新会做什么", 2)
    para(doc, "赛季更新是「切一个分界时刻」：不删数据、不清比赛，只记下这一刻，并把赛季号加一。分界之前结束的赛事积分不再计入本赛季，赛季积分榜从零开始。历史比赛与历史名次全部保留，可以随时回看。")
    para(doc, "等级分（ELO）不参与赛季更新，跨赛季连续累计——一个人上赛季末是多少分，新赛季第一天还是多少分，不会因为一次赛季更新而改变。")

    heading(doc, "6.2 操作步骤", 2)
    numbered(doc, "云开发控制台 → 云函数 → 选择 data。")
    numbered(doc, "切到「云端测试」标签页。")
    numbered(doc, "测试参数填下面这段 JSON（payload 为空对象）：")
    code(doc, '{"action": "resetSeason", "payload": {}}')
    numbered(doc, "点「调用」。调试身份必须是 role=2 且 status=1 的账号，否则返回「只有管理员可以开始新赛季」。")
    numbered(doc, "返回 {ok:true, season:{...}} 即成功，seasonNumber 会比原来 +1。")
    callout(doc, "这一步没有「撤销」。调用一次就多一个赛季（版本号 +1），无法回退。请在赛季确实结束时、全组知会之后再做。", "关键")

    heading(doc, "6.3 什么会变、什么不会变", 2)
    table(
        doc,
        ["项目", "赛季更新后会怎样"],
        [
            ["赛季积分", "清零重来。分界之前结束的赛事不计入本赛季，积分榜从零开始。"],
            ["等级分（ELO）", "完全不变。跨赛季连续累计，新赛季第一天还是上赛季末的分数。"],
            ["进步榜起点分", "不变。只在会员首次入池时写一次，不随赛季刷新。"],
            ["历史比赛 / 名次", "全部保留，随时可回看。"],
        ],
        widths=[4.0, 12.2],
    )
    para(doc, "赛事归属按「结束时刻」判：一场赛事可能计划开赛时间在分界之前、管理员却在分界之后才录入名次收尾，这种按实际收尾时间算进新赛季，不会凭空消失。", muted=True)

    heading(doc, "6.4 seasons 集合里发生了什么", 2)
    table(
        doc,
        ["字段", "变化", "含义"],
        [
            ["seasonNumber", "+1", "赛季号，小程序里显示为「第 N 赛季」"],
            ["version", "+1", "内部版本号；也是让云函数缓存失效的开关"],
            ["resetTime", "= 调用时刻", "赛季分界线，赛事积分以此切分"],
            ["anchorTime", "不变", "赛季体系的起始锚点"],
        ],
        widths=[3.4, 5.6, 7.2],
    )
    para(doc, "对应的就是 seasons 集合里本协会那一条 _id='current_<协会>' 的文档（如 current_pkb）。想核对结果，直接看它即可。多协会下每个协会各有一条，赛季互相独立。")

    heading(doc, "6.5 验证", 2)
    bullet(doc, "小程序赛事页或排行榜会显示新的「第 N 赛季」。")
    bullet(doc, "赛季积分榜上的人应当全部归零，等着新赛季重新挣分。")
    bullet(doc, "同一位会员的等级分与赛季更新前**完全一致**——若变了，说明改动出了问题。")
    bullet(doc, "若页面仍是旧赛季，退出重进一次小程序；仍不对则检查 users 里该账号 status 是否为 1。")

    heading(doc, "6.6 高级：手工调整赛季参数", 2)
    para(doc, "只有在确实需要时才做。直接编辑 seasons 里本协会那条（_id='current_<协会>'，如 current_pkb）的 anchorTime，或手工把 resetTime / seasonNumber 改成别的值。")
    callout(doc, "手工改完必须把 version 加 1，否则云函数还会用缓存里的旧结果，改了等于没改。", "注意")

    # ---------------- 七、数据救急 ----------------
    heading(doc, "七、日常操作四：数据救急（直接改库）", 1)
    para(doc, "这一节是「小程序里改不动、又必须马上修」时的兜底手段。直接改库没有业务校验，改前请先导出备份。")

    heading(doc, "7.1 先记住缓存这件事", 2)
    para(doc, "等级分、积分、排行榜都是由云函数从原始数据现场算出来的，结果会按本赛季版本的 version 缓存两处：云函数容器内存里一份，rankings 里本协会那条（_id='current_<协会>'）一份。也就是说：你改完 matches / users / events，小程序可能还是旧数字。")
    numbered(doc, "改完数据后，到 seasons 里本协会那条（_id='current_<协会>'，如 current_pkb）把 version 加 1 并保存。")
    numbered(doc, "下一次读取就会重算，并把新的快照写回 rankings 里本协会那条（_id='current_<协会>'），小程序刷新即可看到新结果。")
    para(doc, "如果不放心，也可以顺手把 rankings 里该协会那条整条删掉强制重算——它是纯缓存，删了不影响任何数据。", muted=True)

    heading(doc, "7.2 改一个比分", 2)
    numbered(doc, "优先方案：在小程序「比赛」页把该场撤销（要填理由），再重新录分、确认。这样分数会正确回滚与叠加。")
    numbered(doc, "确需在控制台改：数据库 → matches，找到该场文档。")
    numbered(doc, "改 scoreA / scoreB 与 winner（'A' 或 'B'）；要作废则把 status 改成 2（已撤销），要恢复成生效则改回 1。")
    numbered(doc, "把 seasons 里本协会那条（_id='current_<协会>'）的 version 加 1。")
    callout(doc, "matches._id 是自然键（由比赛内容算出）。同样的比赛重复导入会覆盖同一条，不会产生两条。", "提示")

    heading(doc, "7.3 改赛事名次", 2)
    numbered(doc, "数据库 → events，找到该赛事文档。")
    numbered(doc, "编辑 results 数组（每项形如 {userId, placement}），placement 是不小于 1 的整数。")
    numbered(doc, "把 seasons 里本协会那条（_id='current_<协会>'）的 version 加 1，分数与积分会按新名次重算。")

    heading(doc, "7.4 清理测试数据", 2)
    bullet(doc, "删除赛事时，记得一并清理 event_signups 里该 eventId 的报名记录，以及 matches 里该 eventId 的比赛；只删赛事会留下孤儿数据。")
    bullet(doc, "删除学院赛时，要连带清理 college_entries、ties、lineups 里该 eventId 的全部记录，以及 matches 里 collegeEventId 为该赛事的学院赛小场；漏掉任何一处都会留下孤儿数据。")
    bullet(doc, "删除会员有风险：历史比赛会指向一个不存在的 userId，榜单会缺人。测试账号可以在上线前统一清，正式数据不要删。")
    callout(doc, "任何批量删除前，先在该集合点「导出」，把整份数据下载下来留底。", "注意")

    heading(doc, "7.5 学院赛数据救急", 2)
    para(doc, "学院赛的结构比个人赛多几层，改库前先弄清各集合的对应关系：")
    table(
        doc,
        ["想改的东西", "去哪个集合", "改哪个字段"],
        [
            ["赛事信息 / 小项序列", "college_events", "title、legPlan、tieAlgo 等；改小项序列会让已有大场的小项对不上，慎改"],
            ["学院名单", "college_entries", "members（队员编号数组）、status（0待审核/1已通过/2已退回）"],
            ["名单锁定（放开重交）", "college_events", "把 status 从 1（待开赛）改回 0（报名中）可重新开放名单，但需自行处理已生成的抽签结果"],
            ["大场对阵与结果", "ties", "collegeA/collegeB、legs[]、winner、status"],
            ["大场排阵", "lineups", "entries（[{legNo, discipline, players}]）"],
            ["学院名次", "college_events", "results（[{college, placement}]）"],
        ],
        widths=[3.6, 3.4, 9.2],
    )
    bullet(doc, "ties._id 是大场的确定性键（赛事 + 轮次 + 阶段 + 签位），不要手工新增或改 _id。")
    bullet(doc, "学院赛小场写在 matches 集合，用 competition='college' 与个人赛区分；改小场比分会触发大场汇总重算。")
    bullet(doc, "学院名次不计个人分，因此改 college_events.results 不需要动 seasons.version；但若改了学院赛小场的比分，需要把 version 加 1 让 ELO 重算。")
    bullet(doc, "弃权的小场（outcome='forfeit'）与双打小场都不计 ELO，改这些场次不会影响任何人的等级分。")

    heading(doc, "7.6 防刷分：同一对会员一个赛季最多 15 场", 2)
    para(doc, "日常约球没有门槛，两个人一周互录二十场，赢的那个的等级分就被同一份对阵反复推高。所以：一对会员在一个赛季里，最多 15 场日常约球计入等级分。")
    bullet(doc, "录分时就被拦下，不是事后静默不计分：打满之后两人再录，小程序会直接报「本赛季 X 与 Y 已经打了 15 场，达到上限」。录分页选对手的名单里，每个人后面也标着本赛季已经和他打了多少场，打满的标红。")
    bullet(doc, "只有日常约球受这条限制：带 eventId（赛事）或 collegeEventId + tieId（学院赛小场）的比赛一律不受限、也不占日常名额。")
    bullet(doc, "双打按跨队无序对算：一队两人对对手两人算四组对，任一组满额整场就录不进去。同队的搭档之间不算一对。")
    bullet(doc, "待确认的场次也占名额，被驳回或撤销（REVOKED）之后名额才还回来。赛季分界点（seasons 里本协会那条的 resetTime）之前的场次属于上一个赛季，不占本赛季名额。")
    bullet(doc, "上限写在代码里（miniprogram/utils/constants.js 的 RATED_PAIR_LIMIT），库里没有「已超限」这种标记可供直接改。要临时放开某两人，只能改常量并重新上传云函数。")
    heading(doc, "7.7 有比赛在 matches 里查得到，却不进成绩公示", 2)
    para(doc, "导入历史成绩、在控制台直接改库、或者这条规则上线之前录下的场次，都绕过了提交时的闸门。它们会被算出来「超限」：比赛留在 matches 集合里，但不进成绩公示、也查不到分数变化。")
    bullet(doc, "这不是数据丢了，是算出来的，没有存在库里的「已超限」标记。")
    bullet(doc, "同一路数的还有弃权（outcome = forfeit）与待确认（status = 0）的比赛：记录在案，但不计分。")
    callout(doc, "要放宽或收紧这条规则，得改 RATED_PAIR_LIMIT 并重新上传云函数，同时把 season.js 的 ALGO_VERSION 加 1 —— 否则容器里缓存的旧分数不会重算，改了等于没改。", "注意")

    # ---------------- 八、导入历史成绩 ----------------
    heading(doc, "八、日常操作五：导入历史成绩", 1)
    numbered(doc, "用仓库里的 tools/import-matches.py 把历史 Excel 转成 matches 集合需要的 JSON。")
    numbered(doc, "控制台 → 数据库 → matches → 「导入」。")
    numbered(doc, "选择生成的 JSON 文件，冲突处理选「覆盖」，执行导入。")
    numbered(doc, "导入完成后把 seasons 里对应协会那条（_id='current_<协会>'）的 version 加 1，让分数重算。")
    bullet(doc, "导入的记录 status 应为 1（已生效），否则不计分。")
    bullet(doc, "务必先建好 users，并保证每条比赛里的 userId 都能对上人。")
    callout(doc, "导入前先导出 matches 现有数据备份。导错格式再覆盖回去，比重新录几个月的成绩便宜得多。", "注意")

    # ---------------- 九、更新云函数 ----------------
    heading(doc, "九、更新云函数（改了代码之后必做，最容易忘）", 1)
    para(doc, "云函数 data 依赖一份从 miniprogram/ 镜像过去的共享库（权限、赛制、抽签、计分都在里面）。改了共享库却只在小程序端生效、没重新上传云函数，是线上「行为和代码对不上」的头号原因。")
    numbered(doc, "在仓库根目录执行 npm run sync:cloud，把共享库镜像到 cloudfunctions/data/lib/。")
    numbered(doc, "执行 npm run check:cloud-sync，确认镜像与源文件一致。")
    numbered(doc, "回微信开发者工具，右键 cloudfunctions/data → 「上传并部署：云端安装依赖」。")
    numbered(doc, "等状态变为「部署成功」，再在小程序里验证。")
    callout(doc, "云函数里的写操作会做权限与规则校验；只改小程序端的展示层，不会削弱云端校验，但会造成界面与云端判断不一致。两边一起更新最稳妥。", "提示")

    # ---------------- 十、故障排查 ----------------
    heading(doc, "十、常见故障排查", 1)
    table(
        doc,
        ["现象", "原因", "处理"],
        [
            ["小程序显示「本地模拟数据」", "miniprogram/config.js 的 CLOUD_ENV_ID 为空，或基础库低于 2.2.3", "填入环境 ID " + ENV_ID + "，并把调试基础库调到 2.2.3 以上"],
            ["调用云函数报「未知的操作：xxx」", "云函数没部署，或部署的是旧版本（例：前端已在调 getCollegeEvents，云端还没有这个 action）", "重新「上传并部署：云端安装依赖」，并确认传到 " + ENV_ID + "（见第九节）"],
            ["提示「当前账号没有…权限」", "role 不够，或 status 不是 1", "控制台改 users 的 role / status，让对方重开小程序"],
            ["排行榜少了某个人", "users 缺 gender 字段", "补上 'M' 或 'F'（或 '男'/'女'）"],
            ["改了数据库但分数没变", "云函数结果被缓存", "seasons 里本协会那条的 version 加 1，或等容器回收"],
            ["报名 / 签到直接报错", "event_signups 集合没建", "按第 3.1 节新建该集合"],
            ["学院赛某一步直接报错", "college_events / college_entries / ties / lineups 有集合没建", "按第 3.1 节补齐 4 个学院赛集合"],
            ["学院负责人交不了本院名单 / 排阵", "该账号的 college 为空或不是学院全名", "在 users 里把 college 改成 26 所学院之一的全名"],
            ["学院赛找不到某个学院", "该学院名单不是「已通过」状态", "在 college_entries 里把 status 改成 1（已通过），或让管理员在小程序里通过"],
            ["大场点「开始」不生效", "双方排阵未齐", "确认 ties 里 lineupA/lineupB 都为 true；缺的一方补交排阵"],
            ["开始新赛季被拒绝", "调试身份的 OpenID 不是管理员", "改用 role=2 且 status=1 的账号登录开发者工具再调用"],
            ["赛季显示不对", "seasons 里本协会那条的 seasonNumber 或 version 异常", "直接编辑该文档（_id='current_<协会>'），并把 version 加 1"],
            ["任免学院负责人 / 协会负责人报错", "memberships 集合没建，或该行 _id 算错", "按第 3.1、第 5 节新建 memberships 并核对 _id"],
            ["设了初始分但分数没变", "该会员在本协会已打过比赛（初始分锁死），或该项写错了协会", "确认 initialEloByAssoc 里写了正确的协会键；已出场的会员初始分改不动，属正常，回放会忽略它"],
            ["某协会看不到任何数据", "内容文档缺 association 字段，被当成 pkb", "给该协会的文档补上正确的 association 字段"],
        ],
        widths=[4.4, 4.8, 7.0],
    )

    # ---------------- 附录 ----------------
    heading(doc, "附录 A：状态枚举速查", 1)
    table(
        doc,
        ["对象", "字段", "取值"],
        [
            ["账号角色", "users.role", "0=会员，2=管理员（全局）；1 已废弃，学院负责人改记 memberships"],
            ["协会角色", "memberships.role", "staff=学院负责人，leader=协会负责人；无行=普通会员（按协会各异）"],
            ["内容归属协会", "内容文档.association", "pkb=匹克球，tt=乒乓，bd=羽球；写时由云函数盖章，缺字段按 pkb 读"],
            ["账号状态", "users.status", "0=待审核，1=在册，2=禁用，3=离校"],
            ["个人赛事", "events.status", "0=报名中，1=进行中，2=已结束"],
            ["比赛", "matches.status", "0=待确认，1=已生效，2=已撤销"],
            ["比赛归属", "matches.competition", "personal=个人赛，college=学院赛小场"],
            ["比赛结果性质", "matches.outcome", "normal=正常，forfeit=弃权（不计 ELO）"],
            ["报名", "event_signups.status", "0=已取消，1=已报名，2=已签到"],
            ["公告", "announcements.status", "published=已发布，archived=已下架"],
            ["比赛项目", "matches.matchType", "1=单打，3=双打（双打不计分；单打与双打都要先抽签才能开赛）"],
            ["学院赛", "college_events.status", "0=报名中，1=待开赛，2=进行中，3=已结束"],
            ["学院名单", "college_entries.status", "0=待审核，1=已通过，2=已退回"],
            ["大场", "ties.status", "0=待排阵，1=待开赛，2=进行中，3=已结束"],
            ["小项结果", "ties.legs[].outcome", "normal=正常，forfeit=弃权（对手获胜、不计 ELO）"],
        ],
        widths=[3.2, 4.0, 9.0],
    )

    heading(doc, "附录 B：常用云函数接口与权限", 1)
    table(
        doc,
        ["action", "作用", "谁可以用"],
        [
            ["registerMember", "提交入会申请", "无需账号"],
            ["approveMember / rejectMember", "审核会员（可通过时按协会指定初始分，写进 initialEloByAssoc）", "仅管理员"],
            ["setCollegeLeader", "任免本协会的学院负责人（写 memberships 一行）", "本协会的协会负责人或全局管理员"],
            ["setAssociationLeader", "任免本协会的协会负责人（写 memberships 一行）", "仅全局管理员"],
            ["setMemberInitialElo", "调整 / 清除某会员在本协会的初始等级分（写 initialEloByAssoc；已出场则拒绝）", "管理员；协会负责人限本协会"],
            ["publishEvent", "发布赛事", "管理员"],
            ["drawEvent", "抽签 / 重新抽签", "管理员"],
            ["startEvent", "开始赛事（单打、双打都需先抽签）", "管理员"],
            ["signUpEvent / cancelSignupEvent", "报名 / 取消报名", "本人"],
            ["checkInEvent", "代会员签到", "学院负责人及以上"],
            ["submitMatch", "录入比赛成绩（个人赛与学院赛小场共用）", "登录；给抽签场次补分需参赛者或学院负责人及以上"],
            ["confirmMatch / rejectMatch", "确认 / 驳回比分", "对手方或管理员"],
            ["revokeMatch", "撤销已生效比赛", "仅管理员（撤销改写已生效的账本，录入者本人也不行）"],
            ["forfeitMatch", "个人赛本人弃权（对手晋级，不计 ELO）", "本场参赛者本人；管理员可替任意一方"],
            ["finishEvent", "录入名次并结束赛事（唯一结算入口）", "管理员"],
            ["publishAnnouncement / archiveAnnouncement", "发布 / 下架公告", "仅管理员"],
            ["resetSeason", "开始新赛季（清赛季积分、不动等级分）", "管理员"],
            ["getCollegeEvents / getCollegeEvent", "读取学院赛列表 / 详情", "登录"],
            ["getCollegeEntries / getCollegeTies / getCollegeLineups", "读取学院名单 / 大场 / 排阵", "登录"],
            ["publishCollegeEvent", "发布学院赛", "管理员"],
            ["submitCollegeEntry", "提交本学院名单", "学院负责人（限本学院）或管理员"],
            ["reviewCollegeEntry", "审核学院名单（通过 / 退回）", "管理员"],
            ["drawCollegeEvent", "学院赛抽签 / 重抽", "管理员"],
            ["startCollegeEvent", "开始学院赛，生成首轮大场", "管理员"],
            ["submitLineup", "提交大场排阵", "学院负责人（限本学院）或管理员"],
            ["startTie", "开始大场，生成小场（双方排阵须齐）", "管理员"],
            ["recordForfeit", "记录学院赛小场弃权", "管理员"],
            ["finishCollegeEvent", "录入学院名次并结束学院赛", "管理员"],
        ],
        widths=[4.6, 7.2, 4.4],
    )

    heading(doc, "附录 C：控制台操作对照表", 1)
    table(
        doc,
        ["想做的事", "去哪个集合", "改哪个字段"],
        [
            ["通过入会申请", "users", "status：0 → 1"],
            ["驳回入会申请", "users", "status：0 → 2，加 reason"],
            ["设为全局管理员", "users", "role → 2（并确保 status=1）"],
            ["降回会员", "users", "role → 0"],
            ["设为学院负责人", "memberships", "新增一行：userId + association + role='staff'"],
            ["设为协会负责人", "memberships", "新增一行：userId + association + role='leader'（仅全局管理员有权任命）"],
            ["撤销协会角色", "memberships", "删除该 userId + association 的行"],
            ["调整 / 清除初始等级分", "users", "改 initialEloByAssoc 里对应协会那一项（0–3000）；清掉该项即回到自动定级。该协会已打过比赛的会员不可改"],
            ["旧版干事迁到协会角色", "memberships + users", "users.role=1 的人：memberships 加一行 staff；users.role 改 0"],
            ["开启新赛季", "（云函数 data）", "调用 resetSeason"],
            ["手工调赛季号", "seasons", "seasonNumber、version +1"],
            ["让分数立即重算", "seasons", "version +1"],
            ["作废一场比赛", "matches", "status → 2"],
            ["改赛事名次", "events", "results"],
            ["通过学院名单", "college_entries", "status：0 → 1"],
            ["退回学院名单", "college_entries", "status：0 → 2，加 reason"],
            ["改学院名单队员", "college_entries", "members"],
            ["改大场对阵 / 结果", "ties", "collegeA/collegeB、legs[]、winner、status"],
            ["改大场排阵", "lineups", "entries"],
            ["改学院名次", "college_events", "results"],
        ],
        widths=[4.6, 3.6, 8.0],
    )

    closing = doc.add_paragraph()
    closing.paragraph_format.space_before = Pt(16)
    run = closing.add_run("—— 指南结束。所有控制台操作都没有业务校验，动手前请先备份。——")
    set_font(run, size=9.5, color=MUTED)

    return doc


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "云开发控制台操作指南.docx"
    doc = build()
    doc.save(out)
    print(f"已生成：{out}")


if __name__ == "__main__":
    main()
