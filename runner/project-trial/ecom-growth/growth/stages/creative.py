"""素材生成：先定方案矩阵（每个方案指定卖点、角度、语气），再按方案分别写正文，写完自检。

标签在生成之前就确定，不是生成之后再让模型去分析：它们是后面归因的抓手。
"""
from __future__ import annotations

import asyncio
import itertools
import json

from ..llm import extract_json
from ..stats import similarity
from ..types import ANGLES, TONES, Creative, Segment, SellingPoint, TextModel

LIMITS = {"short_copy": 40, "title": 30}
PLAN_SYSTEM = "你是广告策划。只做方案，不写正文。"
PLAN_PROMPT = """为下面的人群设计 {n} 个差异明显的素材方案。

人群：{name}
使用场景：{scenario}
他们担心：{concerns}
可用卖点：
{points}
{feedback}
每个方案指定：用哪一两个卖点（编号）、切入角度（{angles} 之一）、语气（{tones} 之一）。
任意两个方案在卖点、角度、语气三项里至少有两项不同；角度尽量不要重复。

输出 JSON 数组，每项 {{"selling_point_ids": [编号], "angle": "...", "tone": "..."}}。只输出 JSON。"""

WRITE_SYSTEM = "你是电商文案。严格按给定方案写，只输出文案正文，不要解释。"
# 稳定的部分（卖点、人群）放前面，每次变化的方案放后面，便于命中前缀缓存
WRITE_PROMPT = """为下面的人群写一条{format_name}。

人群：{name}
使用场景：{scenario}
他们担心：{concerns}
对这类人避免强调：{avoid}
这类人说话的方式可以参考这些评价原话：{quotes}

本条文案的方案：
- 只使用这些卖点：{points}
- 切入角度：{angle}
- 语气：{tone}

要求：
1. {length_rule}
2. 只陈述上面给出的卖点，不要添加任何其他功效、数据或承诺。
3. 不使用“最”“第一”“唯一”“100%”这类绝对化表述。
4. 不要与其他品牌或产品做比较。
5. 用这类人平时说话的方式写。
{feedback}
只输出文案正文。"""
FORMATS = {
    "short_copy": ("短文案", "不超过 40 个字，一到两句话。"),
    "title": ("商品标题", "不超过 30 个字，结构是：品类词 + 核心卖点 + 规格。"),
    "video_script": ("短视频脚本", '15 到 30 秒。输出 JSON：{"duration_s": 秒数, "shots": [{"t": "0-3", "visual": "画面", "voice": "口播"}]}，3 到 5 个分镜。'),
}

CHECK_SYSTEM = "你在检查广告文案有没有超出给定卖点。只判断这一件事。"
CHECK_PROMPT = """下面的文案中，有没有出现给定卖点之外的功效、数据或承诺？
给定卖点：{points}
文案：{body}
只回答：没有 / 有（并指出是哪一句）"""


def plans_distinct(plans: list[dict]) -> bool:
    """任意两个方案在卖点、角度、语气三项里至少有两项不同。"""
    for a, b in itertools.combinations(plans, 2):
        diff = (set(a["selling_point_ids"]) != set(b["selling_point_ids"])) + (a["angle"] != b["angle"]) + (a["tone"] != b["tone"])
        if diff < 2:
            return False
    return True


def clean_plans(raw, ok_ids: set[int]) -> list[dict]:
    out = []
    for p in raw or []:
        if not isinstance(p, dict):
            continue
        ids = [int(str(i).lstrip("#")) for i in p.get("selling_point_ids") or [] if str(i).lstrip("#").isdigit()]
        ids = [i for i in dict.fromkeys(ids) if i in ok_ids][:2]      # 卖点白名单：清单之外的编号直接去掉
        if ids and p.get("angle") in ANGLES and p.get("tone") in TONES:
            out.append({"selling_point_ids": ids, "angle": p["angle"], "tone": p["tone"]})
    return out


def fallback_plans(segment: Segment, points: list[SellingPoint], n: int) -> list[dict]:
    """模型两次都给不出合格的方案矩阵时，由程序排一个：动机卖点优先，角度和语气轮换。"""
    ids = [i for i in segment.motives if any(p.id == i for p in points)] + [p.id for p in points if p.id not in segment.motives]
    plans = []
    for k in range(n):
        plans.append({"selling_point_ids": [ids[k % len(ids)]], "angle": ANGLES[k % len(ANGLES)], "tone": TONES[k % len(TONES)]})
    return plans


async def plan_matrix(model: TextModel, segment: Segment, points: list[SellingPoint], n: int) -> list[dict]:
    feedback = ""
    for _ in range(2):
        reply = await model.ask(PLAN_SYSTEM, PLAN_PROMPT.format(
            n=n, name=segment.name, scenario=segment.scenario, concerns="；".join(segment.concerns),
            points="\n".join(f"#{p.id} [{p.category}] {p.text}" + ("（这类人的核心动机）" if p.id in segment.motives else "")
                             for p in points),
            angles=" / ".join(ANGLES), tones=" / ".join(TONES), feedback=feedback),
            data={"task": "creative.plan", "segment": segment, "points": points, "n": n})
        plans = clean_plans(extract_json(reply), {p.id for p in points})[:n]
        if len(plans) == n and plans_distinct(plans):
            return plans
        feedback = "\n上一次给出的方案数量不对或彼此差异不足，请拉开差异后重出。\n"
    return fallback_plans(segment, points, n)


async def write_body(model: TextModel, segment: Segment, plan: dict, points: list[SellingPoint],
                     format: str = "short_copy", feedback: str = "") -> str:
    used = [p for p in points if p.id in plan["selling_point_ids"]]
    name, rule = FORMATS[format]
    reply = await model.ask(WRITE_SYSTEM, WRITE_PROMPT.format(
        format_name=name, name=segment.name, scenario=segment.scenario, concerns="；".join(segment.concerns),
        avoid="；".join(segment.avoid) or "（无）", quotes="；".join(segment.review_quotes),
        points="；".join(f"{p.text}（依据：{p.evidence}）" for p in used), angle=plan["angle"], tone=plan["tone"],
        length_rule=rule, feedback=f"\n上一版没有通过检查，原因如下，请避开：\n{feedback}\n" if feedback else ""),
        data={"task": "creative.write", "segment": segment, "plan": plan, "points": used, "format": format,
              "feedback": feedback})
    body = reply.strip().strip("「」\"“”").strip()
    if format == "video_script":
        script = extract_json(body)
        return json.dumps(script, ensure_ascii=False) if isinstance(script, dict) and script.get("shots") else ""
    return body.splitlines()[0].strip() if body else ""


async def self_check(model: TextModel, body: str, used: list[SellingPoint]) -> str:
    """送审之前先做一次便宜的自检。返回空串表示没问题，否则是模型指出的那一句。"""
    reply = (await model.ask(CHECK_SYSTEM, CHECK_PROMPT.format(points="；".join(p.text for p in used), body=body),
                             data={"task": "creative.selfcheck", "body": body, "points": used})).strip()
    return "" if reply.startswith("没有") or not reply.startswith("有") else reply


async def generate(model: TextModel, checker: TextModel, segment: Segment, points: list[SellingPoint], *, n: int = 4,
                   round: int = 1, format: str = "short_copy", existing: list[str] = (), plans: list[dict] | None = None,
                   max_similarity: float = 0.8) -> dict:
    """为一类人群生成 n 版草稿。一版失败不影响其他版；和已有素材过于接近的丢弃。"""
    plans = plans or await plan_matrix(model, segment, points, n)

    async def one(plan: dict) -> Creative | str:
        used = [p for p in points if p.id in plan["selling_point_ids"]]
        feedback = ""
        for _ in range(2):
            try:
                body = await write_body(model, segment, plan, points, format, feedback)
            except Exception as e:  # 单版失败隔离
                return f"生成失败：{type(e).__name__}: {e}"
            if not body:
                feedback = "没有按要求的格式输出"
                continue
            problem = await self_check(checker, body, used)
            if not problem:
                return Creative(id=0, segment_id=segment.id, selling_point_ids=plan["selling_point_ids"],
                                angle=plan["angle"], tone=plan["tone"], body=body, format=format, round=round)
            feedback = f"自检发现超出给定卖点：{problem}"
        return f"两次自检未过：{feedback}"

    results = await asyncio.gather(*(one(p) for p in plans))
    kept, skipped, seen = [], [], list(existing)
    for r in results:
        if isinstance(r, str):
            skipped.append(r)
        elif any(similarity(r.body, old) > max_similarity for old in seen):
            skipped.append(f"与已有素材过于接近，丢弃：{r.body}")
        else:
            kept.append(r)
            seen.append(r.body)
    return {"creatives": kept, "skipped": skipped, "plans": plans}
