"""人群分层：结合卖点和评价，定义几类目标人群。

模型提出人群，程序检查三件事：核心动机引用的卖点必须在可用清单里；各类人群的核心动机不能相同；
每一类都要能在评价里找到对应的原话（找不到原话的人群视为凭空造的，丢弃）。
"""
from __future__ import annotations

from ..llm import extract_json
from ..types import Segment, SellingPoint, TextModel
from ..stats import similarity
from .product import normalize

SYSTEM = "你是用户研究员，基于商品卖点和用户评价划分目标人群。不要提出评价里找不到任何对应声音的人群。"
PROMPT = """商品卖点清单：
{points}

评价里反复提到的缺点：
{cons}

用户评价（节选）：
<用户评价>
{reviews}
</用户评价>

请提出 3 到 5 类最值得触达的目标人群。输出 JSON 数组，每项：
{{"name": "人群名称", "scenario": "在什么情况下会用到这个商品，一句话",
  "motives": [最在意的一两个卖点的编号], "concerns": ["什么会让他们不买，尽量用评价里的原话"],
  "avoid": ["对这类人应该避免强调什么"], "review_quotes": ["逐字摘录 1 到 3 条能说明这类人存在的评价"],
  "size_share": 估计占比（0 到 1）}}

要求：各类人群的核心动机不能相同；每一类都要能在评价里找到对应的声音。只输出 JSON。"""


def match_quote(quote: str, reviews: list[str]) -> str:
    """把模型给的原话对回一条真实的评价：逐字包含，或者只差几个字。对不上返回空串。
    存下来的是评价原文，不是模型的转述。"""
    q = normalize(quote)
    if not q:
        return ""
    for r in reviews:
        n = normalize(r)
        if q in n or (len(n) >= 6 and n in q):
            return r
    best = max(reviews, key=lambda r: similarity(quote, r), default="")
    return best if best and similarity(quote, best) >= 0.7 else ""


async def segment_audience(model: TextModel, points: list[SellingPoint], cons: list[dict], reviews: list[str],
                           first_id: int = 1, sample: int = 80) -> dict:
    """模型第一次给的人群全被程序否掉时，带着原因再问一次。"""
    usable = [p for p in points if p.usable]
    note, out = "", {"segments": [], "dropped": []}
    for _ in range(2):
        reply = await model.ask(SYSTEM, PROMPT.format(
            points="\n".join(f"#{p.id} [{p.category}] {p.text}（评价提及 {p.review_support} 次）" for p in usable),
            cons="\n".join(f"- {c['theme']}（{c['count']} 次）" for c in cons) or "（无）",
            reviews="\n".join(reviews[:sample])) + note,
            data={"task": "segment", "points": usable, "cons": cons, "reviews": reviews})
        out = check_segments(extract_json(reply), usable, reviews, first_id)
        if len(out["segments"]) >= 2:
            break
        note = ("\n\n上一次提出的人群大多没有通过检查：" + "；".join(f"{d['name']}（{d['reason']}）" for d in out["dropped"])
                + "。请重新提出，核心动机只能引用上面清单里的卖点编号，原话必须逐字摘自上面的评价。")
    return out


def check_segments(raw, usable: list[SellingPoint], reviews: list[str], first_id: int = 1) -> dict:
    ok_ids = {p.id for p in usable}
    segments, dropped, seen_motives = [], [], set()
    for item in raw or []:
        if not isinstance(item, dict) or not item.get("name"):
            continue
        motives = [int(str(m).lstrip("#")) for m in item.get("motives") or [] if str(m).lstrip("#").isdigit() and int(str(m).lstrip("#")) in ok_ids]
        quotes = list(dict.fromkeys(q for q in (match_quote(str(x), reviews) for x in item.get("review_quotes") or []) if q))
        reason = ("核心动机没有引用可用卖点" if not motives else "评价里找不到对应的原话" if not quotes
                  else "核心动机和别的人群相同" if tuple(sorted(motives)) in seen_motives else "")
        if reason:
            dropped.append({"name": item["name"], "reason": reason})
            continue
        seen_motives.add(tuple(sorted(motives)))
        try:
            share = float(item.get("size_share") or 0.25)
        except (TypeError, ValueError):
            share = 0.25
        segments.append(Segment(id=first_id + len(segments), name=str(item["name"]), scenario=str(item.get("scenario", "")),
                                motives=motives[:2], concerns=[str(c) for c in item.get("concerns") or []][:3],
                                avoid=[str(a) for a in item.get("avoid") or []][:3], review_quotes=quotes[:3],
                                size_share=share))
    total = sum(s.size_share for s in segments) or 1.0
    for s in segments[:5]:
        s.size_share = round(s.size_share / total, 3)
    return {"segments": segments[:5], "dropped": dropped}
