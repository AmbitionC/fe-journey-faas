"""素材进化：读归因结论，淘汰差的素材，改写好的素材，为没被回应的顾虑补写新素材。

淘汰用规则判定，不交给模型。改写一次只动一处（卖点、角度、语气之一），否则下一轮变好了也不知道是哪一项的功劳。
这里产出的都是草稿：每一版都要从审核的第一层重新走，通过了才能进下一轮。
"""
from __future__ import annotations

import random

from ..llm import extract_json
from ..stats import prob_greater
from ..types import ANGLES, TONES, Creative, Finding, Segment, SellingPoint, TextModel
from .creative import LIMITS

REWRITE_SYSTEM = "你在根据试投数据改进广告文案。先诊断再改，一次只做一处实质性的改动。"
REWRITE_PROMPT = """你在为「{segment}」人群改进一条广告文案。

当前文案（点击率 {ctr:.1%}，区间 {lo:.1%}–{hi:.1%}）：
{body}
它使用的卖点：{used}　角度：{angle}　语气：{tone}

本轮归因结论（仅列出置信等级为高或中的）：
{findings}

这类人群的反馈原话：
点击的理由：{click_quotes}
没点的理由：{skip_quotes}

此前对这条文案尝试过但没有提升的改法：
{failed}

可用卖点清单：
{available}

请完成：
1. 诊断：这条文案对这类人群还差在哪里？依据是上面的哪条结论或反馈？
2. 改写：给出一版新文案。只做一处实质性的改动：卖点、角度（{angles}）、语气（{tones}）三项里只改一项，另外两项保持不变。
3. 说明改的是哪一项。

约束：只能使用可用卖点清单里的卖点。不超过 {limit} 字。不使用绝对化表述，不涉及清单之外的功效，不与其他产品比较。

输出 JSON：{{"diagnosis": "……", "changed": "selling_points / angle / tone", "selling_point_ids": [编号], "angle": "……", "tone": "……", "body": "新文案"}}
只输出 JSON。"""

GAP_SYSTEM = "你在判断商品现有的卖点里有没有能回应用户某个顾虑的。没有就说没有，不要勉强凑。"
GAP_PROMPT = """用户的顾虑：{concern}
相关反馈原话：{quotes}

可用卖点清单：
{available}

清单里有没有哪一条卖点能直接回应这个顾虑？
输出 JSON：{{"selling_point_id": 编号或 null, "reason": "一句话"}}。只输出 JSON。"""


def to_retire(summary: dict[int, dict], prob_best: dict[int, dict[int, float]], creatives: list[Creative],
              confirmed_bait: set[int] = frozenset(), min_impressions: int = 100, threshold: float = 0.02,
              keep: int = 2) -> list[int]:
    """曝光够多且几乎不可能是最优的才淘汰，两个条件缺一不可；被确认的标题党直接淘汰。
    每类人群至少保留 keep 版，并尽量保住至少两种不同的角度。"""
    out = []
    for seg, probs in prob_best.items():
        alive = [c for c in creatives if c.segment_id == seg and c.status == "approved"]
        candidates = [c for c in alive if c.id in confirmed_bait
                      or (summary.get(c.id, {}).get("n", 0) >= min_impressions and probs.get(c.id, 1.0) < threshold)]
        candidates.sort(key=lambda c: (c.id not in confirmed_bait, probs.get(c.id, 1.0)))
        for c in candidates:
            rest = [x for x in alive if x.id != c.id]
            only_angle_left = len({x.angle for x in rest}) < 2 <= len({x.angle for x in alive})
            if len(rest) < keep or (only_angle_left and c.id not in confirmed_bait):
                continue
            alive = rest
            out.append(c.id)
    return out


def changed_fields(parent: Creative, child: dict) -> list[str]:
    fields = []
    if set(child["selling_point_ids"]) != set(parent.selling_point_ids):
        fields.append("selling_points")
    if child["angle"] != parent.angle:
        fields.append("angle")
    if child["tone"] != parent.tone:
        fields.append("tone")
    return fields


def failed_attempts(parent: Creative, creatives: list[Creative], summary: dict[int, dict], rng: random.Random,
                    min_n: int = 50) -> list[str]:
    """父素材的哪些改写版本投过了、却没有比它好。带给改写模型，避免在同一个方向上重复试错。"""
    p = summary.get(parent.id)
    out = []
    for c in creatives:
        s = summary.get(c.id)
        if c.parent_id != parent.id or not p or not s or s["n"] < min_n:
            continue
        if prob_greater((1 + s["clicks"], 1 + s["n"] - s["clicks"]), (1 + p["clicks"], 1 + p["n"] - p["clicks"]), rng) < 0.5:
            out.append(c.note or c.body)
    return out


async def rewrite(model: TextModel, segment: Segment, parent: Creative, perf: dict, findings: list[Finding],
                  feedback: dict, failed: list[str], points: list[SellingPoint], round: int) -> tuple[Creative | None, str]:
    """返回（新草稿或 None, 诊断或放弃原因）。"""
    by_id = {p.id: p for p in points}
    strong = [f for f in findings if f.segment_id == segment.id and f.confidence in ("high", "medium")
              and f.kind in ("works", "unaddressed", "fails")]      # 低置信和无结论的不给改写模型看
    quotes = lambda key: "；".join(q for r in feedback.get(key, []) for q in r["quotes"][:1]) or "（无）"  # noqa: E731
    note = ""
    for _ in range(2):
        reply = await model.ask(REWRITE_SYSTEM, REWRITE_PROMPT.format(
            segment=segment.name, ctr=perf["ctr"], lo=perf["ctr_lo"], hi=perf["ctr_hi"], body=parent.body,
            used="、".join(f"#{i} {by_id[i].text}" for i in parent.selling_point_ids if i in by_id),
            angle=parent.angle, tone=parent.tone,
            findings="\n".join(f"- {f.statement}" for f in strong) or "（本轮没有置信等级够高的结论）",
            click_quotes=quotes("click_reasons"), skip_quotes=quotes("skip_reasons"),
            failed="\n".join(f"- {x}" for x in failed) or "（无）",
            available="\n".join(f"#{p.id} {p.text}" for p in points), angles=" / ".join(ANGLES), tones=" / ".join(TONES),
            limit=LIMITS.get(parent.format, 40)) + note,
            data={"task": "evolve.rewrite", "segment": segment, "parent": parent, "findings": strong,
                  "failed": failed, "points": points, "retry": bool(note)})
        out = extract_json(reply)
        if not isinstance(out, dict) or not out.get("body"):
            note = "\n\n上一次没有按要求输出 JSON，请重新输出。"
            continue
        ids = [int(str(i).lstrip("#")) for i in out.get("selling_point_ids") or [] if str(i).lstrip("#").isdigit()]
        child = {"selling_point_ids": [i for i in dict.fromkeys(ids) if i in by_id][:2] or list(parent.selling_point_ids),
                 "angle": out.get("angle") if out.get("angle") in ANGLES else parent.angle,
                 "tone": out.get("tone") if out.get("tone") in TONES else parent.tone}
        fields = changed_fields(parent, child)
        if len(fields) != 1:       # 标签由程序核对，不信模型自报的 changed
            note = (f"\n\n上一次的改写同时动了 {len(fields)} 项（{'、'.join(fields) or '一项都没改'}）。"
                    "卖点、角度、语气三项里只能改一项，请重新输出。")
            continue
        label = {"selling_points": "卖点", "angle": "角度", "tone": "语气"}[fields[0]]
        before, after = {"selling_points": ("、".join(by_id[i].text for i in parent.selling_point_ids if i in by_id),
                                            "、".join(by_id[i].text for i in child["selling_point_ids"])),
                         "angle": (parent.angle, child["angle"]), "tone": (parent.tone, child["tone"])}[fields[0]]
        diagnosis = str(out.get("diagnosis", ""))[:200]
        return Creative(id=0, segment_id=segment.id, body=str(out["body"]).strip().splitlines()[0], format=parent.format,
                        parent_id=parent.id, round=round, note=f"改{label}：{before} → {after}。依据：{diagnosis}",
                        **child), diagnosis
    return None, "两次都没有给出只改一处的改写，放弃"


async def find_answer(model: TextModel, finding: Finding, points: list[SellingPoint]) -> SellingPoint | None:
    """“未回应”的顾虑：卖点清单里有能回应它的吗？没有就返回 None，由系统向人提问，而不是让模型编一句。"""
    reply = await model.ask(GAP_SYSTEM, GAP_PROMPT.format(
        concern=finding.statement, quotes="；".join(finding.quotes) or "（无）",
        available="\n".join(f"#{p.id} {p.text}（依据：{p.evidence}）" for p in points)),
        data={"task": "evolve.gap", "concern": finding.statement, "points": points})
    out = extract_json(reply)
    pid = out.get("selling_point_id") if isinstance(out, dict) else None
    return next((p for p in points if str(p.id) == str(pid).lstrip("#")), None)
