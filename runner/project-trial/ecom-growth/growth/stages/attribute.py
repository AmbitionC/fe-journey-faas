"""效果归因：把投放日志变成结论。哪些卖点、哪种写法、对哪类人群有效，以及结论有多可信。

三层：素材表现（带区间）→ 属性归因（卖点、角度、语气）→ 读反馈。
一律分人群做，不看合并后的总数。置信等级用明确的规则判定，不交给模型自由判断。
"""
from __future__ import annotations

import asyncio
import re
import statistics
from collections import Counter, defaultdict

from ..llm import extract_json
from ..stats import interval
from ..types import Creative, Finding, Impression, Segment, SellingPoint, TextModel

MIN_N = 30            # 一个属性取值至少要有这么多曝光才参与比较
MIN_PEOPLE = 3        # 一条反馈层面的结论至少要有这么多人的原话支持
FEEDBACK_SYSTEM = "你在归纳用户对广告素材的第一反应。只根据给出的反馈归纳，不要补充你自己的推测。"
FEEDBACK_PROMPT = """下面是「{segment}」人群对若干版素材的第一反应。每行开头标注了有多少人点击、多少人没点。

<反馈>
{lines}
</反馈>

这类人群已知的顾虑：{concerns}

请归纳，输出 JSON：
{{"click_reasons": [{{"reason": "促使点击的理由", "count": 人数, "quotes": ["原话", "原话"]}}],
  "skip_reasons": [{{"reason": "导致不点的理由", "count": 人数, "quotes": ["原话", "原话"]}}],
  "unaddressed": [{{"concern": "反馈里反复出现、但不在已知顾虑里、当前素材也普遍没有回应的担心", "count": 人数, "quotes": ["原话", "原话", "原话"]}}]}}
每类最多 4 条。原话必须逐字来自上面的反馈（不带开头的人数标注），把表达同一个意思的原话尽量都列上，最多 6 条。只输出 JSON。"""

BAIT_SYSTEM = "你在检查一条广告文案是否有标题党嫌疑：吸引点击，但承诺和商品实际不符。"
BAIT_PROMPT = """这条文案点击率明显偏高，点击后的下单率明显偏低。
文案：{body}
它声称使用的卖点：{points}
看过它的用户的反馈：{quotes}
文案的承诺是否超出了这些卖点，或者有夸大、误导？只回答：是（一句话原因）/ 否"""


def summarize(impressions: list[Impression]) -> dict[int, dict]:
    """按素材汇总（每版素材只投给它对应的人群），给出区间而不只是一个点。"""
    rows: dict[int, dict] = defaultdict(lambda: {"n": 0, "clicks": 0, "orders": 0})
    for i in impressions:
        r = rows[i.creative_id]
        r["n"] += 1
        r["clicks"] += i.clicked
        r["orders"] += i.ordered
    for r in rows.values():
        r["ctr"] = r["clicks"] / r["n"]
        r["ctr_lo"], r["ctr_hi"] = interval(r["clicks"], r["n"])
        r["cvr_after_click"] = r["orders"] / r["clicks"] if r["clicks"] else 0.0
    return dict(rows)


def attribute_effect(impressions: list[Impression], creatives: list[Creative], attr: str, segment_id: int) -> list[dict]:
    """把素材的标签展开，看一个属性取不同值时的表现。attr 取 angle / tone / selling_point。"""
    by_id = {c.id: c for c in creatives if c.segment_id == segment_id}
    rows: dict = defaultdict(lambda: {"n": 0, "clicks": 0, "creatives": set()})
    for i in impressions:
        c = by_id.get(i.creative_id)
        if c is None:
            continue
        for value in (c.selling_point_ids if attr == "selling_point" else [getattr(c, attr)]):
            r = rows[value]
            r["n"] += 1
            r["clicks"] += i.clicked
            r["creatives"].add(c.id)
    out = []
    for value, r in rows.items():
        lo, hi = interval(r["clicks"], r["n"])
        out.append({"value": value, "n": r["n"], "clicks": r["clicks"], "ctr": r["clicks"] / r["n"],
                    "lo": lo, "hi": hi, "creatives": sorted(r["creatives"])})
    return sorted(out, key=lambda r: -r["ctr"])


def bound_with(effects: dict[str, list[dict]], attr: str, creative_ids: list[int]) -> str:
    """这个取值涉及的素材，是否恰好也是另一个属性某个取值的全部素材。是的话两者分不开。"""
    for other, rows in effects.items():
        if other == attr:
            continue
        for r in rows:
            if r["creatives"] == creative_ids and len(rows) > 1:
                return f"{LABEL[other]}「{r['label']}」"
    return ""


LABEL = {"angle": "角度", "tone": "语气", "selling_point": "卖点"}


def clickbait(summary: dict[int, dict], creatives: list[Creative], segment_id: int) -> list[int]:
    """点击率高出中位数三成以上、点击后下单率不到人群均值六成的素材。点击数太少的不判。"""
    ids = [c.id for c in creatives if c.segment_id == segment_id and c.id in summary]
    clicks, orders = sum(summary[i]["clicks"] for i in ids), sum(summary[i]["orders"] for i in ids)
    if len(ids) < 3 or not clicks:
        return []
    seg_cvr, median = orders / clicks, statistics.median(summary[i]["ctr"] for i in ids)
    return [i for i in ids if summary[i]["clicks"] >= 20 and summary[i]["ctr"] > median * 1.3
            and summary[i]["cvr_after_click"] < seg_cvr * 0.6]


async def summarize_feedback(model: TextModel, segment: Segment, impressions: list[Impression], limit: int = 60) -> dict:
    """反馈量大，先按原话合并计数再交给模型归纳。"""
    tally: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for i in impressions:
        if i.feedback:
            tally[i.feedback][0 if i.clicked else 1] += 1
    if not tally:
        return {"click_reasons": [], "skip_reasons": [], "unaddressed": []}
    top = sorted(tally.items(), key=lambda kv: -sum(kv[1]))[:limit]
    lines = "\n".join(f"（点击 {c} 人 / 没点 {s} 人）{text}" for text, (c, s) in top)
    reply = await model.ask(FEEDBACK_SYSTEM, FEEDBACK_PROMPT.format(segment=segment.name, lines=lines,
                                                                    concerns="；".join(segment.concerns) or "（无）"),
                            data={"task": "attribute.feedback", "segment": segment, "tally": dict(top)})
    out = extract_json(reply)
    out = out if isinstance(out, dict) else {}
    known = set(tally)
    clean = {}
    for key, name in (("click_reasons", "reason"), ("skip_reasons", "reason"), ("unaddressed", "concern")):
        clean[key] = []
        for item in (out.get(key) or [])[:4]:
            if isinstance(item, dict) and item.get(name):
                quotes = [re.sub(r"^（点击.*?人）", "", str(q)).strip() for q in item.get("quotes") or []]
                quotes = [q for q in dict.fromkeys(quotes) if q in known]          # 原话对不上的不要
                count = sum(sum(tally[q]) for q in quotes) if quotes else 0        # 人数由程序按原话数，不用模型报的
                clean[key].append({name: str(item[name]), "count": count, "quotes": quotes[:6]})
    return clean


async def attribute(model: TextModel, round: int, segments: list[Segment], creatives: list[Creative],
                    points: list[SellingPoint], impressions: list[Impression], *, base_ctr: float = 0.05) -> dict:
    """impressions 是截至本轮的全部日志；反馈归纳只读本轮的。"""
    summary = summarize(impressions)
    point_text = {p.id: p.text for p in points}
    this_round = [i for i in impressions if i.round == round]
    feedbacks = await asyncio.gather(*(summarize_feedback(model, s, [i for i in this_round if i.segment_id == s.id])
                                       for s in segments))
    findings: list[Finding] = []
    baits: list[dict] = []
    effects_all = {}
    for seg, fb in zip(segments, feedbacks):
        mine = [c for c in creatives if c.segment_id == seg.id and c.id in summary]
        if not mine:
            continue
        effects = {attr: attribute_effect(impressions, mine, attr, seg.id) for attr in ("angle", "tone", "selling_point")}
        for attr, rows in effects.items():
            for r in rows:
                r["label"] = point_text.get(r["value"], str(r["value"])) if attr == "selling_point" else r["value"]
        effects_all[seg.id] = effects
        total_n = sum(summary[c.id]["n"] for c in mine)

        # 整类人群没有反应：所有素材的区间上限都贴着基准
        if total_n >= 150 and all(summary[c.id]["ctr_hi"] < base_ctr * 2 for c in mine):
            findings.append(Finding(seg.id, "fails", "所有素材点击率均接近基准，建议重新审视这类人群的定义",
                                    {"n": total_n, "creatives": len(mine)}, "high" if total_n >= 300 else "medium"))

        mentioned = " ".join(r["reason"] + "".join(r["quotes"]) for r in fb["click_reasons"])
        for attr, rows in effects.items():
            rows = [r for r in rows if r["n"] >= MIN_N]
            if len(rows) < 2:
                findings.append(Finding(seg.id, "inconclusive", f"{LABEL[attr]}的影响：可比较的取值不足", {}, "low"))
                continue
            best, worst = rows[0], rows[-1]
            support = {"best": best["label"], "worst": worst["label"], "ctr": [best["ctr"], worst["ctr"]],
                       "interval": [[best["lo"], best["hi"]], [worst["lo"], worst["hi"]]],
                       "n": [best["n"], worst["n"]], "creatives": len(set(best["creatives"]) | set(worst["creatives"]))}
            if best["lo"] <= worst["hi"]:
                findings.append(Finding(seg.id, "inconclusive", f"{LABEL[attr]}的影响：区间重叠", support, "low"))
                continue
            bound = bound_with(effects, attr, best["creatives"])
            corroborated = attr == "selling_point" and any(
                k and k in mentioned for k in [best["label"], *next((p.keywords for p in points if p.id == best["value"]), [])])
            n_creatives = len(best["creatives"])
            confidence = ("low" if bound or n_creatives < 2 else
                          "high" if support["creatives"] >= 3 and corroborated else "medium")
            statement = f"{LABEL[attr]}「{best['label']}」优于「{worst['label']}」" + (f"（与{bound}绑定，无法区分）" if bound else "")
            quotes = [q for r in fb["click_reasons"] for q in r["quotes"]][:2] if corroborated else []
            findings.append(Finding(seg.id, "works", statement, support, confidence, quotes))

        if fb["click_reasons"] and fb["click_reasons"][0]["count"] >= MIN_PEOPLE:
            top = fb["click_reasons"][0]
            findings.append(Finding(seg.id, "works", f"「{top['reason']}」是被提到最多的点击理由", {"count": top["count"]},
                                    "medium", top["quotes"]))
        for item in fb["unaddressed"]:
            if item["count"] >= MIN_PEOPLE:
                findings.append(Finding(seg.id, "unaddressed", item["concern"], {"count": item["count"]}, "medium",
                                        item["quotes"]))

        for cid in clickbait(summary, mine, seg.id):
            c = next(x for x in mine if x.id == cid)
            quotes = [i.feedback for i in this_round if i.creative_id == cid and i.feedback][:6]
            reply = await model.ask(BAIT_SYSTEM, BAIT_PROMPT.format(
                body=c.body, points="；".join(point_text.get(i, "") for i in c.selling_point_ids),
                quotes="；".join(dict.fromkeys(quotes)) or "（无）"),
                data={"task": "attribute.bait", "creative": c})
            baits.append({"creative_id": cid, "segment_id": seg.id, "confirmed": reply.strip().startswith("是"),
                          "reason": reply.strip()[:80], "ctr": summary[cid]["ctr"],
                          "cvr_after_click": summary[cid]["cvr_after_click"]})
    return {"summary": summary, "findings": findings, "clickbait": baits, "effects": effects_all,
            "feedback": {s.id: fb for s, fb in zip(segments, feedbacks)}}


KIND = {"works": "有效", "fails": "无效", "unaddressed": "未回应", "inconclusive": "无结论"}
CONF = {"high": "高", "medium": "中", "low": "低"}


def render(round: int, segments: list[Segment], result: dict, sim_name: str) -> str:
    lines = [f"第 {round} 轮归因（模拟环境 {sim_name}）"]
    for seg in segments:
        mine = [f for f in result["findings"] if f.segment_id == seg.id]
        if not mine:
            continue
        lines.append(f"\n{seg.name}")
        for f in sorted(mine, key=lambda f: list(KIND).index(f.kind)):
            extra = ""
            if f.kind == "works" and "ctr" in f.support:
                extra = f"  {f.support['ctr'][0]:.1%} 对 {f.support['ctr'][1]:.1%}，区间不重叠，{f.support['creatives']} 版素材"
            elif f.kind == "unaddressed":
                extra = f"  {f.support.get('count', 0)} 人的反馈提到，当前素材均未涉及"
            conf = "" if f.kind == "inconclusive" else f"（{CONF[f.confidence]}）"
            lines.append(f"  {KIND[f.kind]:<4}{f.statement}{conf}{extra}")
    for b in result["clickbait"]:
        lines.append(f"\n标题党{'' if b['confirmed'] else '嫌疑（未确认）'}：素材 #{b['creative_id']}"
                     f"（点击率 {b['ctr']:.1%}，点击后下单率 {b['cvr_after_click']:.1%}）")
    return "\n".join(lines)
