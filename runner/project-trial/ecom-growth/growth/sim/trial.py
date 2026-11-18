"""试投环境（模拟）。输入一版素材和一批模拟用户，输出每个用户的反应。

模型只做阅读理解：判断素材和这个用户的动机、顾虑有多相关（三个维度各 0 到 2 分），顺带写一句第一反应。
点不点、买不买由下面两个显式的概率公式决定，整体水平由基准率控制，不由模型的“热情程度”决定。

这个环境能验证闭环的工程是否正确，不能证明素材对真实用户有效。
试投环境是一个接口（expose）：换成真实投放系统的实现，上下游都不用改。
"""
from __future__ import annotations

import asyncio
import hashlib
import math
import random
from typing import Protocol

from ..llm import extract_json
from .users import scoring_view
from ..types import Creative, Impression, Reaction, Relevance, SimUser, TextModel

SCORE_SYSTEM = ("你在做阅读理解：判断一条广告素材和若干位用户各自的在意点、顾虑有多相关。"
                "按每位用户的设定判断，不要代入你自己对文案好坏的看法。多数素材对多数用户只是“沾边”，不要轻易给 2 分。")
# 素材和打分说明放前面、用户设定放最后：同一版素材配很多用户时，前面的部分能重复命中缓存
SCORE_PROMPT = """素材：
<素材>
{body}
</素材>

对下面每位用户分别判断（每项回答 0、1 或 2）：
1. motive：素材是否提到了这个用户在意的点？（0 没提到，1 沾边，2 正好说中）
2. concern：素材是否回应了这个用户的顾虑（包括设定里写到的每一条担心）？（0 没有，1 部分，2 全部明确回应）
3. aversion：素材中是否有这个用户反感的说法或语气？（0 没有，1 有一点，2 明显）
再用这个用户的口吻写一句话（feedback），说明对这条素材的第一反应。

输出 JSON 数组，每位用户一项：{{"n": 用户序号, "motive": 0, "concern": 0, "aversion": 0, "feedback": "……"}}。只输出 JSON。

{personas}"""


def click_prob(rel: Relevance, user: SimUser, base_ctr: float, coef: dict) -> float:
    lift = coef["motive"] * rel.motive + coef["concern"] * rel.concern - coef["aversion"] * rel.aversion
    logit = math.log(base_ctr / (1 - base_ctr)) + lift + user.noise
    return 1 / (1 + math.exp(-logit))


def order_prob(rel: Relevance, user: SimUser, base_cvr: float) -> float:
    p = base_cvr * (1 + 0.5 * rel.concern) * user.behavior["buy_per_pv_scaled"]
    return min(p * (1 - 0.3 * user.price_sensitivity), 1.0)


class TrialEnv(Protocol):
    async def expose(self, round: int | str, creative: Creative, users: list[SimUser]) -> list[Reaction]: ...


def _clip(v) -> int:
    try:
        return min(max(int(v), 0), 2)
    except (TypeError, ValueError):
        return 0


class SimEnv:
    def __init__(self, model: TextModel, config: dict, cache=None, ledger=None, batch: int = 8):
        self.model, self.config, self.cache, self.ledger, self.batch = model, config, cache, ledger, batch
        self.memo: dict[str, Relevance] = {}

    @staticmethod
    def key(body: str, persona: str) -> str:
        """缓存键用内容的哈希而不是素材编号：内容相同的改写版本也能命中。"""
        return hashlib.sha1(f"{body}\n---\n{persona}".encode()).hexdigest()

    def _lookup(self, key: str) -> Relevance | None:
        if key in self.memo:
            return self.memo[key]
        hit = self.cache.cache_get(key) if self.cache else None
        if hit:
            self.memo[key] = Relevance(**hit)
        return self.memo.get(key)

    async def relevance(self, creative: Creative, users: list[SimUser]) -> dict[int, Relevance]:
        """同一对“素材内容和人物描述”只打一次分。没打过的按批问模型。"""
        personas: dict[str, str] = {}
        for u in users:
            k = self.key(creative.body, scoring_view(u))
            if self._lookup(k) is None:
                personas.setdefault(k, scoring_view(u))
            elif self.ledger:
                self.ledger.hit("sim")
        todo = list(personas.items())

        async def score(chunk: list[tuple[str, str]]) -> None:
            text = "\n\n".join(f"【用户 {i + 1}】\n{persona}" for i, (_, persona) in enumerate(chunk))
            reply = await self.model.ask(SCORE_SYSTEM, SCORE_PROMPT.format(body=creative.body, personas=text),
                                         data={"task": "sim.score", "creative": creative, "personas": [p for _, p in chunk]})
            rows = {int(r["n"]): r for r in (extract_json(reply) or [])
                    if isinstance(r, dict) and str(r.get("n", "")).isdigit()}
            for i, (k, _) in enumerate(chunk):
                r = rows.get(i + 1, {})      # 模型漏了哪位用户，就按“不相关”记，不重问
                rel = Relevance(_clip(r.get("motive")), _clip(r.get("concern")), _clip(r.get("aversion")),
                                str(r.get("feedback", ""))[:80])
                self.memo[k] = rel
                if self.cache:
                    self.cache.cache_put(k, rel.__dict__)

        await asyncio.gather(*(score(todo[i:i + self.batch]) for i in range(0, len(todo), self.batch)))
        return {u.id: self.memo[self.key(creative.body, scoring_view(u))] for u in users}

    def probs(self, rel: Relevance, user: SimUser) -> tuple[float, float]:
        return (click_prob(rel, user, self.config["base_ctr"], self.config["coef"]),
                order_prob(rel, user, self.config["base_cvr"]))

    async def expose(self, round, creative: Creative, users: list[SimUser]) -> list[Reaction]:
        rels = await self.relevance(creative, users)
        out = []
        for u in users:
            # 每一对（轮次、素材、用户）有自己固定的随机数：新加一版素材不会改变别的素材的结果
            rng = random.Random(f"{self.config['seed']}:{round}:{creative.id}:{u.id}")
            p_click, p_order = self.probs(rels[u.id], u)
            clicked = rng.random() < p_click
            out.append(Reaction(clicked, clicked and rng.random() < p_order, rels[u.id].feedback))
        return out

    async def true_rate(self, creative: Creative, users: list[SimUser], objective: str = "click") -> float:
        """模拟环境比真实环境多一个优势：每个选项的真实点击率是算得出来的。用来检验分配策略和环境本身。"""
        rels = await self.relevance(creative, users)
        ps = [self.probs(rels[u.id], u) for u in users]
        return sum(p[0] * (p[1] if objective == "order" else 1) for p in ps) / max(len(ps), 1)


def pick_users(users: list[SimUser], segment_id: int, creative_id: int, round, k: int, seen: set[int],
               seed: int, bystander_share: float) -> list[SimUser]:
    """给一个“素材 × 人群”选 k 个还没看过它的用户。定向不是完美的：按比例混入不属于任何目标人群的路人。
    留出用户从不参与试投。选择是确定性的，重跑得到同一批人。"""
    target = [u for u in users if u.segment_id == segment_id and not u.holdout]
    others = [u for u in users if u.segment_id is None and not u.holdout]
    rng = random.Random(f"{seed}:pick:{round}:{creative_id}")
    rng.shuffle(others)
    mixed = target + others[:round_half(len(target) * bystander_share / max(1 - bystander_share, 1e-9))]
    rng.shuffle(mixed)
    return [u for u in mixed if u.id not in seen][:k]


def round_half(x: float) -> int:
    return int(x + 0.5)


def to_impressions(round: int, creative: Creative, users: list[SimUser], reactions: list[Reaction]) -> list[Impression]:
    return [Impression(round, creative.id, creative.segment_id, u.id, r.clicked, r.ordered, r.feedback)
            for u, r in zip(users, reactions)]
