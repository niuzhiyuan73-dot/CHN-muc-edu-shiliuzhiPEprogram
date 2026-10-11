"""
把单打实验的 JSON 结果排版成 Excel 表格。

用法：
    1. node tools/singles-experiment.js <结果.json>
    2. python tools/singles-experiment-to-xlsx.py <结果.json> <输出.xlsx>

依赖 openpyxl。
"""

import json
import sys

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

TITLE_FONT = Font(bold=True, size=14)
HEAD_FONT = Font(bold=True, color="FFFFFF")
HEAD_FILL = PatternFill("solid", fgColor="4472C4")
NOTE_FONT = Font(size=10, color="595959")
SECTION_FONT = Font(bold=True, size=11)
THIN = Side(style="thin", color="BFBFBF")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
CENTER = Alignment(horizontal="center", vertical="center")
WRAP = Alignment(vertical="top", wrap_text=True)


def write_table(ws, start_row, headers, rows, widths=None):
    """从 start_row 起写一张带表头的表，返回下一行的行号。"""
    for col, text in enumerate(headers, start=1):
        cell = ws.cell(row=start_row, column=col, value=text)
        cell.font = HEAD_FONT
        cell.fill = HEAD_FILL
        cell.alignment = CENTER
        cell.border = BORDER

    for offset, row in enumerate(rows, start=1):
        for col, value in enumerate(row, start=1):
            cell = ws.cell(row=start_row + offset, column=col, value=value)
            cell.border = BORDER
            if isinstance(value, (int, float)):
                cell.alignment = CENTER
            else:
                cell.alignment = Alignment(vertical="center")

    if widths:
        for col, width in enumerate(widths, start=1):
            ws.column_dimensions[get_column_letter(col)].width = width

    return start_row + len(rows) + 2


def _experiment_facts(data):
    """
    从实验 JSON 里取出「本次采用的参数」和对应的关键结果。

    文字说明全部引用这些值，避免调参后表格里的结论和下方数据对不上。
    找不到对应扫描行时返回 None，由调用方再兜底。
    """
    cfg = data.get("eloConfig") or {}
    anchor = cfg.get("initialRating", 1450)
    gap = cfg.get("genderInitialGap", 150)
    female = anchor - gap

    def find(rows, key, value):
        return next((row for row in rows if row.get(key) == value), None)

    summary = data["members"]["summary"]
    member_count = summary["memberCount"] or 1
    pool_skill = (
        summary["menMeanSkill"] * summary["menCount"]
        + summary["womenMeanSkill"] * summary["womenCount"]
    ) / member_count

    return {
        "anchor": anchor,
        "gap": gap,
        "female": female,
        "summary": summary,
        "pool_skill": pool_skill,
        # 女会员占全池比例 × 起点差＝加权起点相对男会员锚点的下移量
        "weighted_offset": gap * summary["womenCount"] / member_count,
        "gap_row": find(data["gapSweep"], "gap", gap),
        "same_start": find(data["gapSweep"], "gap", 0),
        "gap_max_row": find(data["gapSweep"], "gap", 200),
        "anchor_row": find(data["anchorSweep"], "anchor", anchor),
        "isolated": find(data["sweep"], "ratio", 0),
        "fully_mixed": data["sweep"][-1],
    }


def sheet_overview(wb, data):
    ws = wb.create_sheet("说明")
    ws.column_dimensions["A"].width = 118

    opts = data["baseOptions"]
    member_count = data["memberCount"]
    facts = _experiment_facts(data)
    s = facts["summary"]
    # 兜底：扫描表缺行时退回用基准摘要，保证文案不崩
    same_start = facts["same_start"] or s
    gap_row = facts["gap_row"] or s
    gap_max = facts["gap_max_row"] or s
    anchor_row = facts["anchor_row"] or s
    isolated = facts["isolated"] or s
    fully_mixed = facts["fully_mixed"] or s
    bias = anchor_row.get("biasMean", s.get("bias"))
    pct = lambda row: f"{row['convergenceMean'] * 100:.0f}%"

    lines = [
        ("中央民族大学石榴籽体育管理 · 单打评分实验记录", TITLE_FONT),
        ("", None),
        ("一、这次实验在问什么", SECTION_FONT),
        (
            "本次改动把男女单打合并成同一个分数池（男女会互相打单打），排行榜再按性别拆成男单榜和女单榜；"
            f"同时男会员的初始分定为 {facts['anchor']}，女会员定为 {facts['female']}（低 {facts['gap']} 分）。"
            "合并之后有两件事必须验证：一是分数还能不能反映真实水平，二是男女真实水平的差距能不能在分数上体现出来。",
            None,
        ),
        (
            f"为什么女会员要低 {facts['gap']} 分起步：ELO 只在「跨性别的比赛」里把分数从一组转移到另一组。"
            "俱乐部里男女对打比例只有约 25%，光靠比赛慢慢收敛，20 周也未必能把差距拉开。"
            f"起点先低 {facts['gap']} 分，等于入场时就把一部分已知差异预先算进去。本表最后一节扫描了「低多少分」最合适。",
            None,
        ),
        ("", None),
        ("二、实验方法", SECTION_FONT),
        (
            f"数据由 {opts['weeks']} 周、每周 {opts['casualPerWeek']} 场约球的模拟数据生成，"
            f"共 {member_count} 名会员。每位会员在系统里藏着一个「真实水平」"
            "（模拟比赛胜负时用），但等级分完全由 ELO 逐场回放算出来，程序并不知道真实水平。"
            "把两者对照，就能看出等级分偏了多少。",
            None,
        ),
        (
            "只统计单打：双打一队里可能同时有男女，性别差异会被稀释，看不出问题。",
            None,
        ),
        (
            "「真实差距」指男队真实水平均值减去女队真实水平均值；「观察差距」指男队等级分均值减去女队等级分均值；"
            "「还原度」＝观察差距 ÷ 真实差距，100% 表示差距被完整还原。",
            None,
        ),
        ("", None),
        ("三、结论", SECTION_FONT),
        (
            f"1. 把性别起点差从 0（男女同起点）调到 {facts['gap']} 分后，整体平均绝对误差从 "
            f"{same_start['maeMean']} 分降到 {gap_row['maeMean']} 分，女队误差从 {same_start['maeWomenMean']} 分"
            f"降到 {gap_row['maeWomenMean']} 分，男女差距的还原度从 {pct(same_start)}"
            f"（观察差距 {same_start['observedGapMean']} 分）提升到 {pct(gap_row)}"
            f"（观察差距 {gap_row['observedGapMean']} 分）。见「性别起点差扫描」。",
            None,
        ),
        (
            "2. 但「还原度」要拆开看。见「混打比例扫描」：男女完全不交手（占比 0）时，观察差距也有 "
            f"{isolated['observedGapMean']} 分（还原 {pct(isolated)}）——这几乎全部来自起点差本身，"
            f"并不代表两组分数真的可比。把混打比例拉满后，观察差距回落到 {fully_mixed['observedGapMean']} 分"
            f"（还原 {pct(fully_mixed)}）：因为男女同池交手后，ELO 会把被人为抬高的起点差，"
            "往「比赛结果真正支持的差距」上拉。也就是说，起点差能先在榜单上把差距摆出来，"
            "但要让两组分数落到同一把尺子上，仍得靠男女对打。",
            None,
        ),
        (
            f"3. 零和池的平均分永远停在「各人起点分的加权平均」上。男 {facts['anchor']} / 女 {facts['female']} 的加权"
            f"起点约 {facts['anchor'] - facts['weighted_offset']:.0f} 分，而全池真实平均约 {facts['pool_skill']:.0f} 分，"
            f"整体偏差约 {bias} 分——起点分已基本对齐俱乐部真实水平。见「初始分扫描」。",
            None,
        ),
        (
            "4. 中途入会者的定级规则（前五场赢过的最强者向下取 50）与他们的真实水平同向；"
            f"一场未胜时改为「不超过本人性别的初始分」，女新人封顶 {facts['female']} 而不是 {facts['anchor']}。"
            "见「新人定级」两张表。",
            None,
        ),
        ("", None),
        ("四、建议（供参考）", SECTION_FONT),
        (
            f"· 本次已把男会员锚点下调到 {facts['anchor']}、性别起点差上调到 {facts['gap']} 分："
            f"锚点为 {facts['anchor']} 时整体偏差最小（约 {bias} 分，接近 0），"
            f"起点差为 {facts['gap']} 分时整体平均绝对误差最低（{gap_row['maeMean']} 分）。",
            None,
        ),
        (
            "· 起点差并不是在「制造」差距，只是把已知差距预先摆到榜单上；真正让两组分数可比，"
            "仍取决于男女对打的场次。当前模拟数据里混打只占约 25%，建议稳定提高。",
            None,
        ),
        (
            f"· 起点差继续加大到 200 分时，还原度 {pct(gap_max)} 已略过头、整体偏差转为负值"
            f"（{gap_max['biasMean']} 分），整体误差回升到 {gap_max['maeMean']} 分，不建议再加大。",
            None,
        ),
        ("", None),
        (f"生成时间：{data['generatedAt']}", NOTE_FONT),
        (
            "混打比例扫描、初始分扫描、性别起点差扫描各重复 10 个随机种子取平均，"
            f"其余表格为基准数据（种子 {opts['seed']}）。",
            NOTE_FONT,
        ),
    ]

    for row, (text, font) in enumerate(lines, start=1):
        cell = ws.cell(row=row, column=1, value=text)
        cell.alignment = WRAP
        if font:
            cell.font = font

    return ws


def sheet_members(wb, data):
    ws = wb.create_sheet("单打逐人明细")
    ws.cell(row=1, column=1, value="单打逐人明细（按等级分降序）").font = TITLE_FONT

    headers = ["名次", "会员编号", "姓名", "性别", "真实水平", "起始分",
               "当前等级分", "误差", "绝对误差", "单打场次", "胜", "负", "胜率"]
    rows = []
    for index, row in enumerate(data["members"]["rows"], start=1):
        games = row["matchCount"]
        rows.append([
            index,
            row["_id"],
            row["nickName"],
            "男" if row["gender"] == "M" else "女",
            row["trueSkill"],
            row["startElo"],
            row["elo"],
            row["error"],
            row["absError"],
            games,
            row["wins"],
            row["losses"],
            round(row["wins"] / games, 3) if games else None,
        ])

    write_table(ws, 3, headers, rows,
                widths=[6, 10, 10, 6, 10, 8, 11, 8, 9, 9, 6, 6, 8])
    summarize_block(ws, 3 + len(rows) + 1, data["members"]["summary"])


def summarize_block(ws, row, summary):
    """在表格下方补一段分组汇总。"""
    ws.cell(row=row, column=1, value="分组汇总").font = SECTION_FONT
    pairs = [
        ("男队等级分均值", summary["menMeanElo"]),
        ("女队等级分均值", summary["womenMeanElo"]),
        ("男队真实水平均值", summary["menMeanSkill"]),
        ("女队真实水平均值", summary["womenMeanSkill"]),
        ("真实差距", summary["trueGap"]),
        ("观察差距（等级分）", summary["observedGap"]),
        ("还原度", summary["convergence"]),
        ("平均绝对误差（全体）", summary["mae"]),
        ("平均绝对误差（男）", summary["maeMen"]),
        ("平均绝对误差（女）", summary["maeWomen"]),
        ("系统偏差（正数＝分数虚高）", summary["bias"]),
        ("相关系数", summary["pearson"]),
        ("分数高于男队中位数的女生人数", summary["womenAboveMedianMan"]),
    ]
    for offset, (label, value) in enumerate(pairs, start=1):
        ws.cell(row=row + offset, column=1, value=label)
        ws.cell(row=row + offset, column=2, value=value)


def sheet_checkpoints(wb, data):
    ws = wb.create_sheet("性别差距收敛过程")
    ws.cell(row=1, column=1, value="性别差距随赛季推进的收敛过程").font = TITLE_FONT

    headers = ["周次", "累计单打场次", "男队真实均值", "女队真实均值", "真实差距",
               "男队等级分均值", "女队等级分均值", "观察差距", "还原度",
               "平均绝对误差", "相关系数"]
    rows = [
        [
            c["week"], c["matchCount"], c["menMeanSkill"], c["womenMeanSkill"], c["trueGap"],
            c["menMeanElo"], c["womenMeanElo"], c["observedGap"], c["convergence"],
            c["mae"], c["pearson"],
        ]
        for c in data["checkpoints"]
    ]

    write_table(ws, 3, headers, rows,
                widths=[7, 13, 13, 13, 10, 14, 14, 10, 9, 13, 10])
    ws.cell(
        row=3 + len(rows) + 1,
        column=1,
        value="注：早期周次只统计已打过 3 场以上的会员，因此男/女真实均值本身也在变化。",
    ).font = NOTE_FONT


def sheet_sweep(wb, data):
    ws = wb.create_sheet("混打比例扫描")
    ws.cell(row=1, column=1, value="单打里「男女对打」占比对分数可比性的影响").font = TITLE_FONT

    headers = ["男女对打占比", "重复次数", "观察差距均值", "观察差距标准差", "还原度",
               "真实差距", "整体平均绝对误差", "男队误差", "女队误差", "相关系数",
               "高于男队中位数的女生数"]
    rows = [
        [
            row["ratio"], row["runCount"], row["observedGapMean"], row["observedGapStd"],
            row["convergenceMean"], row["trueGap"], row["maeMean"], row["maeMenMean"],
            row["maeWomenMean"], row["pearsonMean"], row["womenAboveMedianManMean"],
        ]
        for row in data["sweep"]
    ]

    facts = _experiment_facts(data)
    isolated = facts["isolated"]
    fully_mixed = facts["fully_mixed"]
    write_table(ws, 3, headers, rows,
                widths=[13, 10, 13, 14, 9, 10, 16, 10, 10, 10, 20])
    ws.cell(
        row=3 + len(rows) + 1,
        column=1,
        value=(
            f"注：全部跑在「男 {facts['anchor']} / 女 {facts['female']}」的起点下。占比为 0 时，男女两组之间"
            f"没有任何分数往来，观察差距（{isolated['observedGapMean']} 分，还原 "
            f"{isolated['convergenceMean'] * 100:.0f}%）几乎完全来自起点差本身，并不是分数真的可比；"
            f"占比越高，比赛才越能把被人为抬高的起点差拉回到结果支持的差距上"
            f"（占比拉满时回落到 {fully_mixed['observedGapMean']} 分，还原 "
            f"{fully_mixed['convergenceMean'] * 100:.0f}%）。"
        ),
    ).font = NOTE_FONT


def sheet_anchor(wb, data):
    facts = _experiment_facts(data)
    ws = wb.create_sheet("初始分扫描")
    ws.cell(
        row=1,
        column=1,
        value=f"男会员起点分取值对系统性偏差的影响（女会员低 {facts['gap']} 分）",
    ).font = TITLE_FONT

    headers = ["男会员起点分", "重复次数", "整体偏差（正＝虚高）", "男队偏差", "女队偏差",
               "整体平均绝对误差", "男队误差", "女队误差", "观察差距", "还原度", "相关系数"]
    rows = [
        [
            row["anchor"], row["runCount"], row["biasMean"], row["biasMenMean"],
            row["biasWomenMean"], row["maeMean"], row["maeMenMean"], row["maeWomenMean"],
            row["observedGapMean"], row["convergenceMean"], row["pearsonMean"],
        ]
        for row in data["anchorSweep"]
    ]

    write_table(ws, 3, headers, rows,
                widths=[9, 10, 18, 10, 10, 16, 10, 10, 10, 9, 10])
    anchor_row = facts["anchor_row"] or {}
    ws.cell(
        row=3 + len(rows) + 1,
        column=1,
        value=(
            "注：零和池的总分守恒，池平均分永远等于「各人起点分的加权平均」。"
            f"本列数值是男会员的起点，女会员固定比它低 {facts['gap']} 分；"
            f"因此加权起点＝本列数值 − {facts['weighted_offset']:.1f}。"
            f"本俱乐部全池真实平均约 {facts['pool_skill']:.0f} 分，"
            f"男会员起点取 {facts['anchor']}（女 {facts['female']}）时整体偏差最小"
            f"（约 {anchor_row.get('biasMean', 0)} 分）。"
        ),
    ).font = NOTE_FONT


def sheet_gap(wb, data):
    facts = _experiment_facts(data)
    ws = wb.create_sheet("性别起点差扫描")
    ws.cell(row=1, column=1, value="女会员起点比男会员低多少分，对还原度的影响").font = TITLE_FONT

    headers = ["女比男低（分）", "重复次数", "观察差距均值", "观察差距标准差", "还原度",
               "真实差距", "整体平均绝对误差", "男队误差", "女队误差",
               "整体偏差（正＝虚高）", "女队偏差", "相关系数", "高于男队中位数的女生数"]
    rows = [
        [
            row["gap"], row["runCount"], row["observedGapMean"], row["observedGapStd"],
            row["convergenceMean"], row["trueGap"], row["maeMean"], row["maeMenMean"],
            row["maeWomenMean"], row["biasMean"], row["biasWomenMean"],
            row["pearsonMean"], row["womenAboveMedianManMean"],
        ]
        for row in data["gapSweep"]
    ]

    write_table(ws, 3, headers, rows,
                widths=[14, 10, 13, 14, 9, 10, 17, 10, 10, 18, 10, 10, 20])
    gap_row = facts["gap_row"] or {}
    gap_max = facts["gap_max_row"] or {}
    ws.cell(
        row=3 + len(rows) + 1,
        column=1,
        value=(
            f"注：男会员起点固定为 {facts['anchor']}，女会员起点＝{facts['anchor']} − 本列数值。"
            f"「低 {facts['gap']} 分」（女 {facts['female']}）即当前采用的方案，"
            f"整体平均绝对误差最低（{gap_row.get('maeMean', 0)} 分）、还原度 "
            f"{gap_row.get('convergenceMean', 0) * 100:.0f}%。"
            f"继续加大到 200 分时还原度达到 {gap_max.get('convergenceMean', 0) * 100:.0f}%（略过头），"
            f"整体偏差转为 {gap_max.get('biasMean', 0)} 分、误差回升。"
        ),
    ).font = NOTE_FONT


def sheet_placements(wb, data):
    ws = wb.create_sheet("新人定级")
    ws.cell(row=1, column=1, value="中途入会者的定级结果").font = TITLE_FONT

    headers = ["会员编号", "姓名", "性别", "真实水平", "单打定级分", "双打定级分",
               "定级涉及池数", "前五场胜场", "前五场场次", "单打最终分", "单打场次", "最终误差"]
    rows = [
        [
            p["_id"], p["nickName"], "男" if p["gender"] == "M" else "女", p["trueSkill"],
            p["singlesPlacement"], p["doublesPlacement"], p["entries"],
            p["firstFiveWins"], p["firstFiveCount"], p["singlesFinalElo"],
            p["singlesMatchCount"], p["finalError"],
        ]
        for p in data["placements"]
    ]

    next_row = write_table(ws, 3, headers, rows,
                           widths=[10, 10, 6, 10, 11, 11, 13, 11, 11, 11, 9, 9])
    ws.cell(
        row=next_row - 1,
        column=1,
        value="注：定级分取「前五场中赢过的最强者」向下取到 50 的整数倍；一场未胜时取最弱者，且不超过初始分。",
    ).font = NOTE_FONT


def sheet_placement_evidence(wb, data):
    ws = wb.create_sheet("新人定级依据")
    ws.cell(row=1, column=1, value="新人的前五场对手（定级依据）").font = TITLE_FONT

    headers = ["会员编号", "姓名", "第几场", "场次编号", "所属池", "对手赛前均分",
               "本人赛前分", "本人是否获胜"]
    rows = []
    for person in data["placements"]:
        for index, opp in enumerate(person["opponents"], start=1):
            rows.append([
                person["_id"], person["nickName"], index, opp["matchId"],
                "单打" if opp["pool"] == "singles" else "双打",
                opp["opponentAverage"], opp["eloBefore"], "胜" if opp["won"] else "负",
            ])

    write_table(ws, 3, headers, rows,
                widths=[10, 10, 8, 12, 8, 13, 11, 12])
    ws.cell(
        row=3 + len(rows) + 1,
        column=1,
        value="注：对手赛前均分取对方队伍在这场比赛开打之前的平均等级分，避免用「未来」的数据定过去的级。",
    ).font = NOTE_FONT


def main():
    if len(sys.argv) < 3:
        raise SystemExit("用法：python tools/singles-experiment-to-xlsx.py <结果.json> <输出.xlsx>")

    json_path, xlsx_path = sys.argv[1], sys.argv[2]
    with open(json_path, "r", encoding="utf-8") as fh:
        data = json.load(fh)

    wb = Workbook()
    wb.remove(wb.active)  # 去掉默认空表

    sheet_overview(wb, data)
    sheet_members(wb, data)
    sheet_checkpoints(wb, data)
    sheet_sweep(wb, data)
    sheet_anchor(wb, data)
    sheet_gap(wb, data)
    sheet_placements(wb, data)
    sheet_placement_evidence(wb, data)

    wb.save(xlsx_path)
    print(f"已写出 {xlsx_path}")


if __name__ == "__main__":
    main()
