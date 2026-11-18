"""预算分配：每一轮把曝光分给哪些“素材 × 人群”。

汤普森采样：每个选项维护一个 Beta 分布（成功次数、失败次数），每次曝光从各分布里抽一个值，给抽到最大的那个。
数据少的选项分布宽，偶尔抽到大值，于是得到探索；表现差且数据多的选项几乎抽不到最大值，曝光自然减少。
"""
from __future__ import annotations

import random
from collections import Counter
from dataclasses import dataclass

from ..stats import prob_best

PRIORS = {"click": (1.0, 19.0), "order": (1.0, 199.0)}   # 没有数据时认为点击率约 5%、每次曝光下单率约 0.5%
INHERIT = 0.3                                              # 改写出的新素材继承父素材统计的折扣


@dataclass(frozen=True)
class Arm:
    key: int            # 素材编号
    segment_id: int


class ThompsonAllocator:
    def __init__(self, arms: list[Arm], prior: tuple[float, float] = PRIORS["click"],
                 inherited: dict[int, tuple[float, float]] | None = None):
        self.arms = {a.key: a for a in arms}
        self.prior = prior
        self.stats = {a.key: [prior[0] + (inherited or {}).get(a.key, (0, 0))[0],
                              prior[1] + (inherited or {}).get(a.key, (0, 0))[1]] for a in arms}

    def allocate(self, budget: int, rng: random.Random, caps: dict[int, int] | None = None,
                 floor_share: float = 0.03, arm_caps: dict[int, int] | None = None) -> Counter:
        """先给每个选项保底，剩下的用汤普森采样分。caps 是每类人群的曝光上限，arm_caps 是单个选项还能投多少。"""
        counts, used = Counter(), Counter()
        room = lambda k: ((arm_caps is None or counts[k] < arm_caps.get(k, 0))  # noqa: E731
                          and (caps is None or used[self.arms[k].segment_id] < caps.get(self.arms[k].segment_id, 0)))
        floor = max(int(budget * floor_share), 1) if floor_share > 0 else 0
        left = budget
        for k in self.stats:                               # 最低曝光：新素材全靠先验竞争时可能几乎拿不到曝光
            for _ in range(floor):
                if left > 0 and room(k):
                    counts[k] += 1
                    used[self.arms[k].segment_id] += 1
                    left -= 1
        for _ in range(left):
            draws = {k: rng.betavariate(a, b) for k, (a, b) in self.stats.items() if room(k)}
            if not draws:
                break                                      # 所有人群的上限都用完了，剩余预算留着
            best = max(draws, key=draws.get)
            counts[best] += 1
            used[self.arms[best].segment_id] += 1
        return counts

    def update(self, key: int, successes: int, impressions: int) -> None:
        self.stats[key][0] += successes
        self.stats[key][1] += impressions - successes

    def prob_best_by_segment(self, rng: random.Random) -> dict[int, dict[int, float]]:
        """按人群分别算：不同人群的最优素材通常不一样。"""
        out = {}
        for seg in sorted({a.segment_id for a in self.arms.values()}):
            out[seg] = prob_best({k: tuple(v) for k, v in self.stats.items() if self.arms[k].segment_id == seg}, rng)
        return out


def uniform(keys: list, budget: int) -> Counter:
    counts = Counter({k: budget // len(keys) for k in keys})
    for k in keys[:budget % len(keys)]:
        counts[k] += 1
    return counts


def bench(true_rates: list[float], budget: int = 3000, rounds: int = 6, repeats: int = 40, seed: int = 0) -> dict:
    """在一个真实点击率已知的玩具环境里对比三种分配方式。

    累计损失：和“每次都投给真正最优的选项”相比少得到的点击数（期望值）。
    选对的比例：多次独立运行里，最终选出的第一名确实是真实最优的比例。
    这个对比只比较分配策略本身，不依赖模拟用户有多像真人。
    """
    best, keys = max(true_rates), list(range(len(true_rates)))
    per_round = budget // rounds
    out = {}
    for name in ("平均分配", "先试后投", "汤普森采样"):
        regret = correct = 0.0
        for rep in range(repeats):
            rng = random.Random(f"{seed}:{name}:{rep}")
            alloc = ThompsonAllocator([Arm(k, 0) for k in keys])
            shown, clicks = Counter(), Counter()
            for r in range(rounds):
                if name == "平均分配" or (name == "先试后投" and r == 0):
                    plan = uniform(keys, per_round)
                elif name == "先试后投":
                    leader = max(keys, key=lambda k: clicks[k] / max(shown[k], 1))
                    plan = Counter({leader: per_round})
                else:
                    plan = alloc.allocate(per_round, rng, floor_share=0.0)
                for k, n in plan.items():
                    got = sum(rng.random() < true_rates[k] for _ in range(n))
                    shown[k] += n
                    clicks[k] += got
                    alloc.update(k, got, n)
                    regret += n * (best - true_rates[k])
            pick = max(keys, key=lambda k: clicks[k] / max(shown[k], 1))
            correct += true_rates[pick] == best
        out[name] = {"regret": round(regret / repeats, 1), "correct": round(correct / repeats, 3)}
    return out
