"""第一级进化：反思式改写系统提示词（GEPA 的思路）。

候选池里保留“至少在一条任务上是最优”的候选，而不是只留平均分最高的那个：
不同候选可能各自学会了不同的东西，下一轮从它们里面抽父代。
"""
from __future__ import annotations

import random
from collections import Counter
from dataclasses import dataclass
from statistics import mean

from ..report import by_task
from ..types import AgentVersion, RunRecord, Task
from .common import example_block, extract_block
from .gate import Bench, Decision, admit

SYSTEM = "你在改进一个编程 Agent 的系统提示词。"
TEMPLATE = """当前提示词：
<prompt>
{prompt}
</prompt>

评分标准（Agent 自己看不到这段话）：任务给的检查命令退出码为 0，并且任务声明不许改的文件
（通常是测试目录，新增文件也算改动）保持原样，才算通过。除此之外没有别的得分途径。

下面是它在几条任务上的表现。每条包含任务、结果、评分理由和轨迹摘要：

{examples}

此前尝试过但没有带来提升的修改：
{rejected}

请完成两步：
1. 诊断：这些失败有没有共同原因？原因可能是提示词没有说清楚某件事，也可能是提示词里现有的某条规定
   本身就让 Agent 没法通过评分。现有的规定不是不能动的前提：对照轨迹看 Agent 是在照着哪一条做才失败的。
   如果失败与提示词无关（例如工具本身有缺陷），直接说明，不要强行修改。
2. 改写：给出修改后的完整提示词。只针对诊断出的问题修改，保留其余内容；
   导致失败的规定要删掉或改掉，而不是在它外面再套一层补救说明。
   写成通用的指导，不要提及具体任务里的文件名或数值。提示词里的 {{cwd}} 占位符必须原样保留。

按下面的格式输出：
<diagnosis>一两句话的诊断</diagnosis>
<prompt>修改后的完整提示词；如果判断不该改，这里原样抄回当前提示词</prompt>"""


@dataclass
class Candidate:
    version: AgentVersion
    scores: dict[str, float]          # 任务编号 → 平均通过率（只在进化集上）
    diagnosis: str = ""


def scores_of(records: list[RunRecord]) -> dict[str, float]:
    return {t: mean(v) for t, v in by_task(records).items()}


def select_parent(pool: list[Candidate], rng: random.Random) -> Candidate:
    """按“在多少条任务上是最优”加权抽一个父代。"""
    wins: Counter = Counter()
    for task in {t for c in pool for t in c.scores}:
        best = max(c.scores.get(task, 0.0) for c in pool)
        for i, c in enumerate(pool):
            if c.scores.get(task, 0.0) == best:
                wins[i] += 1
    frontier = [i for i in range(len(pool)) if wins[i] > 0] or list(range(len(pool)))
    return pool[rng.choices(frontier, weights=[wins[i] or 1 for i in frontier])[0]]


async def reflect(bench_model, parent: AgentVersion, tasks: dict[str, Task], records: list[RunRecord],
                  rejected: list[str]) -> tuple[str, str]:
    """返回（诊断，新提示词）。新提示词为空或与原来相同表示“不该改”。"""
    failures = [r for r in records if not r.passed]
    shown = failures[:4] + [r for r in records if r.passed][:1]   # 带一条成功的做对照
    text = await bench_model.ask(SYSTEM, TEMPLATE.format(
        prompt=parent.system_prompt,
        examples="\n\n".join(example_block(tasks[r.task_id].prompt, r) for r in shown),
        rejected="\n".join(f"- {x}" for x in rejected) or "（无）"))
    new_prompt = extract_block(text, "prompt").strip()
    if new_prompt and "{cwd}" in parent.system_prompt and "{cwd}" not in new_prompt:
        # 模型常把结尾带占位符的那一行漏掉：把原提示词里的那一行补回去，而不是整份作废
        line = next(l for l in parent.system_prompt.splitlines() if "{cwd}" in l)
        new_prompt += f"\n\n{line}"
    if new_prompt == parent.system_prompt.strip():
        new_prompt = ""            # 原样抄回，等于不改
    elif new_prompt:
        new_prompt += "\n"
    return extract_block(text, "diagnosis").strip(), new_prompt


async def evolve_prompt(bench: Bench, model, current: AgentVersion, rounds: int = 2, batch_size: int = 4,
                        seed: int = 0) -> tuple[AgentVersion, Decision | None]:
    rng = random.Random(seed)
    evolve_set = bench.split("evolve")
    tasks = {t.id: t for t in evolve_set}
    pool = [Candidate(current, scores_of(await bench.run(current, evolve_set, "基线·进化集")))]
    rejected = bench.store.rejected_notes()

    for round_no in range(1, rounds + 1):
        parent = select_parent(pool, rng)
        # 小批量里优先放父代没做对的任务：全是做对的题，反思不出东西
        failing = [t for t in evolve_set if parent.scores.get(t.id, 0) < 1]
        if not failing:
            bench.notify("note", {"text": f"第 {round_no} 轮：进化集已全部通过，没有可反思的失败"})
            break
        rest = [t for t in evolve_set if t not in failing]
        rng.shuffle(failing), rng.shuffle(rest)
        batch = (failing + rest)[:batch_size]
        parent_runs = await bench.run(parent.version, batch, f"第 {round_no} 轮·父代小批量")
        diagnosis, new_prompt = await reflect(model, parent.version, tasks, parent_runs, rejected)
        bench.notify("proposal", {"level": 1, "round": round_no, "diagnosis": diagnosis,
                                  "changed": bool(new_prompt) and new_prompt != parent.version.system_prompt})
        if not new_prompt or new_prompt == parent.version.system_prompt:
            rejected.append(f"第 {round_no} 轮：反思认为不该改提示词（{diagnosis[:60]}）")
            continue
        child = parent.version.derive(f"改写提示词：{diagnosis[:80]}", system_prompt=new_prompt)
        child_runs = await bench.run(child, batch, f"第 {round_no} 轮·子代小批量")
        if mean(r.passed for r in child_runs) <= mean(r.passed for r in parent_runs):
            rejected.append(f"{child.note}（小批量上没有比父代好）")
            bench.store.save_version(child, "rejected", "小批量上没有比父代好")
            continue
        pool.append(Candidate(child, scores_of(await bench.run(child, evolve_set, f"第 {round_no} 轮·子代进化集")),
                              diagnosis))

    best = max(pool, key=lambda c: (mean(c.scores.values()) if c.scores else 0.0, c is not pool[0]))
    if best.version.id == current.id:
        return current, None
    # 候选池里的版本可能隔了几代，合入时父版本统一记成当前版本
    candidate = current.derive(best.version.note, system_prompt=best.version.system_prompt)
    decision = await admit(bench, candidate, current)
    return (candidate if decision.admitted else current), decision
