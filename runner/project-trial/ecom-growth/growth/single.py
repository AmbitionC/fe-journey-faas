"""对照实验：同一次活动，用“一个上下文 + 按需加载的 Skill”再跑一遍，和默认的多环节编排比。

默认做法里每个环节各有各的上下文：写文案的看不到审核细则，审核的看不到这版文案是谁、为什么这样写的。
这里换成另一种常见做法：只有一条对话，各环节的提示词变成 Skill，用到时才加载进来，之后一直留在上下文里；
每一步的任务和回复也都接在同一条对话后面。

两边保持一致的部分：环节的代码、主管的决策规则、代码强制的闸口、规则层审核、试投环境和归因的统计。
唯一的差别是上下文怎么组织，所以两边的差距可以归到这一个变量上：
- 花费：一条对话越写越长，每次调用都要把前面的内容重新读一遍；
- 并行：一条对话一次只能做一件事，原来并发的写稿、审核只能排队；
- 独立性：审核的人看得到自己刚写的文案和写作思路，容易顺着自己的思路放行。

扮演用户的模型不属于被比较的对象，两边都走原来的独立调用。
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field

from .lead import Campaign, Config
from .llm import Ledger, Models, StageModel
from .stages import review
from .store import Store

SINGLE_SYSTEM = """你独自负责一次营销活动的全部环节：商品理解、人群分层、写素材、审核、归因、改写、决定下一步。
各环节的做法写成了 Skill，用到时会加载到对话里。每次只完成「现在要做」里的那一件事，按那个 Skill 要求的格式输出。
「之前的步骤」是你自己做过的事，可以参考，不要重复输出。"""

SKILLS = {"lead": "决定活动下一步做什么", "product": "从商品资料里提取卖点", "segment": "划分人群",
          "creative": "写素材", "selfcheck": "写完后自查", "review": "合规审核", "attribute": "归因",
          "evolve": "淘汰和改写素材"}
OUTSIDE = {"sim"}      # 试投环境里扮演用户的模型：不是 Agent 的一部分，不进这条对话


@dataclass
class Thread:
    """那一条越写越长的对话。超过上限时把最早的步骤折叠掉（结果都在数据层里，折叠不丢数据）。"""
    max_chars: int = 60_000
    skills: dict[str, str] = field(default_factory=dict)        # 已加载的 Skill：名字 → 正文
    steps: list[tuple[str, str, str]] = field(default_factory=list)
    folded: int = 0
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def render(self, skill: str, body: str, task: str) -> str:
        if body not in self.skills.values():        # 同一个环节可能有几段提示词，各算一个 Skill
            self.skills[f"{skill}-{sum(k.startswith(skill) for k in self.skills) + 1}"] = body
        name = next(k for k, v in self.skills.items() if v == body)
        while True:
            parts = ["## 已加载的 Skill"] + [f"### {k}\n{v}" for k, v in self.skills.items()]
            if self.folded:
                parts.append(f"## 之前的步骤\n（更早的 {self.folded} 步已折叠，结果在数据层）")
            elif self.steps:
                parts.append("## 之前的步骤")
            parts += [f"【{s}】{t}\n→ {r}" for s, t, r in self.steps]
            parts.append(f"## 现在要做\n用 Skill「{name}」完成：\n{task}")
            text = "\n\n".join(parts)
            if len(text) <= self.max_chars or not self.steps:
                return text
            self.steps.pop(0)
            self.folded += 1


class ThreadStage:
    """把一个环节的调用接到那条对话上。环节代码不用改：它以为自己还在调自己的模型。"""

    def __init__(self, stage: str, base: StageModel, thread: Thread):
        self.stage, self.base, self.thread, self.inner = stage, base, thread, base.inner

    async def ask(self, system: str, user: str, *, data: dict | None = None) -> str:
        async with self.thread.lock:        # 一条对话一次只能做一件事
            prompt = self.thread.render(self.stage, system, user)
            reply = await self.base.ask(SINGLE_SYSTEM + "\n\n可用的 Skill：" + "；".join(f"{k}（{v}）" for k, v in SKILLS.items()),
                                        prompt, data=data)
            self.thread.steps.append((self.stage, user, reply))
            return reply


class SingleModels(Models):
    def __init__(self, *args, max_chars: int = 60_000, **kwargs):
        super().__init__(*args, **kwargs)
        self.thread = Thread(max_chars=max_chars)

    def stage(self, stage: str):
        base = super().stage(stage)
        return base if stage in OUTSIDE else ThreadStage(stage, base, self.thread)


class Meter:
    """按字符数记 Agent 这一侧的用量（不含扮演用户的调用）。用字符而不是 token，离线替身也能量。"""

    def __init__(self):
        self.calls = self.chars_in = self.chars_out = self.peak = 0

    def __call__(self, stage: str, system: str, user: str, reply: str) -> None:
        if stage in OUTSIDE:
            return
        self.calls += 1
        self.chars_in += len(system) + len(user)
        self.chars_out += len(reply)
        self.peak = max(self.peak, len(system) + len(user))


async def recheck(campaign: Campaign, models: Models) -> tuple[int, int]:
    """独立复查：把这次活动里通过审核的素材，交给一个什么上下文都没有的审核员再审一遍。
    返回（复查的版数，被复查拦下的版数）。多环节那一边也做，得到的是审核员自己前后不一致的底数。"""
    store, cfg = campaign.store, campaign.config
    rules, _ = review.load_rules(cfg.rules, store.product().competitors)
    points = store.points(usable_only=True)
    passed = [c for c in store.creatives() if (c.review or {}).get("verdict") == "approved"]
    results = await asyncio.gather(*(review.review(models.stage("review"), c, points, rules, checks=cfg.checks,
                                                   brand_tone=cfg.brand_tone) for c in passed))
    return len(passed), sum(r["verdict"] != "approved" for r in results)


async def run_one(mode: str, product, config: Config, make_models, make_fresh, db: str = ":memory:") -> dict:
    """make_models(cls, on_call) 造这次活动用的模型；make_fresh() 造独立复查用的。"""
    store, meter = Store(db), Meter()
    if store.product() is None:
        store.save_product(product)
    models = make_models(SingleModels if mode == "single" else Models, meter)
    campaign = Campaign(store, models, config)
    t0 = time.monotonic()
    await campaign.run()
    seconds = time.monotonic() - t0
    agent_calls = [c for c in models.ledger.calls if c.stage not in OUTSIDE]
    checked, blocked = await recheck(campaign, make_fresh())
    creatives = store.creatives()
    row = {"mode": mode, "calls": meter.calls, "chars_in": meter.chars_in, "chars_out": meter.chars_out,
           "peak": meter.peak, "tokens_in": sum(c.input_tokens for c in agent_calls),
           "tokens_out": sum(c.output_tokens for c in agent_calls), "seconds": seconds,
           "folded": getattr(getattr(models, "thread", None), "folded", 0),
           "rounds": campaign.state["round"], "stop": campaign.state["stop"],
           "written": len(creatives), "approved": checked, "recheck_blocked": blocked,
           "first_block_rate": campaign.state["block_rates"].get("1", 0.0)}
    store.close()
    return row


def render(rows: list[dict]) -> str:
    names = {"multi": "多环节，各有上下文", "single": "一个上下文 + Skill"}
    tokens = any(r["tokens_in"] for r in rows)
    lines = [("指标", *(names[r["mode"]] for r in rows))]

    def add(label, fn):
        lines.append((label, *(fn(r) for r in rows)))

    add("模型调用次数", lambda r: f"{r['calls']}")
    if tokens:
        add("输入 token", lambda r: f"{r['tokens_in']:,}")
        add("输出 token", lambda r: f"{r['tokens_out']:,}")
    add("输入字符数", lambda r: f"{r['chars_in']:,}")
    add("单次调用最长的输入（字符）", lambda r: f"{r['peak']:,}")
    add("折叠掉的早期步骤", lambda r: f"{r['folded']}")
    add("用时（秒）", lambda r: f"{r['seconds']:.1f}")
    add("写出的素材版数", lambda r: f"{r['written']}")
    add("首次送审被拦的比例", lambda r: f"{r['first_block_rate']:.0%}")
    add("通过审核的版数", lambda r: f"{r['approved']}")
    add("独立复查拦下的版数", lambda r: f"{r['recheck_blocked']}")
    add("跑了几轮", lambda r: f"{r['rounds']}")
    width = [max(sum(2 if ord(ch) > 127 else 1 for ch in row[i]) for row in lines) for i in range(len(lines[0]))]
    pad = lambda s, w: s + " " * (w - sum(2 if ord(ch) > 127 else 1 for ch in s))      # noqa: E731
    return "\n".join("  ".join(pad(cell, width[i]) for i, cell in enumerate(row)) for row in lines)
