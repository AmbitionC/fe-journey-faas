"""连续跑多代：上一代合入的版本就是下一代的起点，被拦下的候选也留在版本树上。

单跑一轮（cli 的 evolve --level）回答的是“这一级能不能改好它”；这里回答的是“放着让它自己一代一代改，
能走多远、在哪儿停”。每一代做三件事：选一级、把那一级跑一轮、记一笔。

选哪一级：这一级的修改合入了，下一代接着用它（它还改得动）；没改出能合入的东西，就换下一级。
连着轮完一圈都没有合入，说明在这套题上已经改不动了，停下来。
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from statistics import mean

from ..types import AgentVersion
from .budget import budget_at, diff
from .code import evolve_code
from .config import evolve_config
from .gate import Bench
from .playbook import evolve_playbook
from .prompt import evolve_prompt

LEVELS = {"prompt": evolve_prompt, "playbook": evolve_playbook, "config": evolve_config, "code": evolve_code}
ROTATION = ("prompt", "config", "playbook", "code")      # 先改便宜的、容易回退的


@dataclass
class Generation:
    no: int
    level: str
    base: str                 # 这一代从哪个版本出发
    candidate: str = ""       # 提出的候选；没提出来为空
    outcome: str = ""         # admitted | rejected | no_change
    rule: str = ""            # 被闸门的哪条规则拦下
    reason: str = ""
    score: float = 0.0        # 这一代结束后，当前版本在验收集上的通过率
    budget: int | None = None
    edit: int = 0             # 候选相对出发版本改了多少行


async def evolve_generations(bench: Bench, model, start: AgentVersion, generations: int = 5,
                             levels: tuple[str, ...] = ROTATION, budget: int | None = 20, decay: float = 0.7
                             ) -> tuple[AgentVersion, list[Generation]]:
    """返回（最后的当前版本，每一代的记录）。budget 是第一代的编辑预算，None 为不限。"""
    current, history, misses, turn = start, [], 0, 0
    accept = bench.split("accept")
    # 画分数曲线要有起点的分数。只有这里和闸门会碰验收集，提案器看不到；结果有缓存，闸门不会再跑一遍
    score = mean(r.passed for r in await bench.run(start, accept, "起点·验收集"))
    first = bench.store.last_generation() + 1
    bench.notify("generations_start", {"version": start.id, "score": score, "generations": generations})

    for no in range(first, first + generations):
        level = levels[turn % len(levels)]
        bench.budget = None if budget is None else budget_at(no - first + 1, budget, decay)
        bench.notify("generation_start", {"no": no, "level": level, "base": current.id, "budget": bench.budget})
        after, decision = await LEVELS[level](bench, model, current)
        gen = Generation(no, level, current.id, score=score, budget=bench.budget)
        if decision is None:
            gen.outcome, gen.reason = "no_change", "这一级没有提出需要过闸门的修改"
        else:
            gen.candidate, gen.rule, gen.reason = decision.candidate, decision.rule, decision.reason
            gen.outcome = "admitted" if decision.admitted else "rejected"
            candidate = bench.store.get_version(decision.candidate)
            gen.edit = diff(current, candidate)[0] if candidate else 0
        if gen.outcome == "admitted":
            gen.score = score = decision.accept["cand"]["mean"]
            current, misses = after, 0
        else:
            misses, turn = misses + 1, turn + 1
        history.append(gen)
        bench.store.add_generation(asdict(gen))
        bench.notify("generation_end", asdict(gen))
        if misses >= max(2, len(levels)):
            bench.notify("note", {"text": f"连续 {misses} 代没有合入，在这套题上已经改不动了，停止。"})
            break
    bench.budget = None
    return current, history
