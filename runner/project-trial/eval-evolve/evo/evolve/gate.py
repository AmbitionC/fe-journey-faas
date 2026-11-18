"""准入闸门：候选版本在验收集上更好、并且在回归集上不退步，才合入。四级进化共用这一道门。"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from statistics import mean
from typing import Callable

from ..graders import Grader
from ..report import by_task, compare
from ..runner import evaluate
from ..store import Store
from ..tasks import by_split
from ..types import AgentUnderTest, AgentVersion, RunRecord, Task

Notify = Callable[[str, dict], None]


@dataclass
class Bench:
    """一次进化用到的全部部件。提案器只许碰 evolve 集，闸门才碰另外两套。"""
    agent: AgentUnderTest
    grader: Grader
    tasks: list[Task]
    store: Store
    attempts: int = 1
    concurrency: int = 4
    notify: Notify = lambda kind, data: None
    max_cost_ratio: float = 1.5      # 候选的平均用量最多是基线的多少倍
    run_timeout: float = 600         # 单次运行的时间上限（秒）
    _cache: dict = field(default_factory=dict)

    def split(self, name: str) -> list[Task]:
        return by_split(self.tasks, name)

    def task(self, task_id: str) -> Task:
        return next(t for t in self.tasks if t.id == task_id)

    async def run(self, version: AgentVersion, tasks: list[Task], label: str) -> list[RunRecord]:
        """同一个版本在同一批任务上只跑一次，结果复用。"""
        key = (version.id, tuple(sorted(t.id for t in tasks)), self.attempts)
        if key not in self._cache:
            self.notify("eval_start", {"version": version.id, "label": label, "tasks": [t.id for t in tasks]})
            records = await evaluate(
                self.agent, self.grader, version, tasks, attempts=self.attempts, concurrency=self.concurrency,
                store=self.store, timeout=self.run_timeout,
                on_start=lambda t, a: self.notify("run_start", {"version": version.id, "label": label, "task": t.id,
                                                                "attempt": a}),
                on_record=lambda r: self.notify("run_end", {"version": version.id, "label": label, "record": r}))
            self._cache[key] = records
            self.notify("eval_end", {"version": version.id, "label": label, "records": records})
        return self._cache[key]


@dataclass
class Decision:
    admitted: bool
    reason: str
    accept: dict = field(default_factory=dict)
    regressed: list[str] = field(default_factory=list)


def tokens(records: list[RunRecord]) -> float:
    return mean(r.input_tokens + r.output_tokens for r in records) if records else 0.0


async def admit(bench: Bench, candidate: AgentVersion, baseline: AgentVersion) -> Decision:
    """先跑回归集（便宜，且一票否决），再跑验收集。"""
    bench.store.save_version(candidate, "candidate")
    if candidate.id == baseline.id:
        decision = Decision(False, "候选与基线内容相同")
        bench.store.save_version(candidate, "rejected", decision.reason)
        return decision

    regress = bench.split("regress")
    base_r, cand_r = await asyncio.gather(bench.run(baseline, regress, "基线·回归集"),
                                          bench.run(candidate, regress, "候选·回归集"))
    a, b = by_task(base_r), by_task(cand_r)
    regressed = sorted(t for t in a if mean(b.get(t, [False])) < mean(a[t]))
    if regressed:
        decision = Decision(False, f"回归集退步：{', '.join(regressed)}", regressed=regressed)
    else:
        accept = bench.split("accept")
        base_a, cand_a = await asyncio.gather(bench.run(baseline, accept, "基线·验收集"),
                                              bench.run(candidate, accept, "候选·验收集"))
        cmp = compare(base_a, cand_a)
        if cmp["cand"]["mean"] <= cmp["base"]["mean"]:
            decision = Decision(False, f"验收集没有变好（{cmp['base']['mean']:.0%} → {cmp['cand']['mean']:.0%}）", cmp)
        elif tokens(base_a) and tokens(cand_a) > tokens(base_a) * bench.max_cost_ratio:
            decision = Decision(False, f"验收集变好了，但平均用量是基线的 {tokens(cand_a) / tokens(base_a):.1f} 倍，"
                                       f"超过上限 {bench.max_cost_ratio} 倍", cmp)
        else:
            decision = Decision(True, f"验收集 {cmp['base']['mean']:.0%} → {cmp['cand']['mean']:.0%}，回归集无退步", cmp)
    bench.store.save_version(candidate, "merged" if decision.admitted else "rejected", decision.reason)
    bench.notify("gate", {"candidate": candidate.id, "baseline": baseline.id, "admitted": decision.admitted,
                          "reason": decision.reason})
    return decision
