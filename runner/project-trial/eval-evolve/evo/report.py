"""可靠性与成本报告。一个平均通过率说明不了什么：要看每次都成功的比例、波动、和配对比较。"""
from __future__ import annotations

import random
from collections import defaultdict
from statistics import mean

from .types import RunRecord


def by_task(records: list[RunRecord]) -> dict[str, list[bool]]:
    out: dict[str, list[bool]] = defaultdict(list)
    for r in records:
        out[r.task_id].append(r.passed)
    return dict(out)


def reliability(runs: dict[str, list[bool]]) -> dict[str, float]:
    n = len(runs) or 1
    return {
        "pass_any": sum(any(r) for r in runs.values()) / n,   # 至少成功一次
        "pass_all": sum(all(r) for r in runs.values()) / n,   # 每次都成功
        "mean": sum(sum(r) / len(r) for r in runs.values()) / n,
    }


def flaky(runs: dict[str, list[bool]]) -> list[str]:
    return sorted(t for t, r in runs.items() if 0 < sum(r) < len(r))


def paired_bootstrap(a: dict[str, list[bool]], b: dict[str, list[bool]], n_boot: int = 2000, seed: int = 0) -> float:
    """“b 的平均通过率高于 a”在按任务重采样中出现的比例。两边必须是同一批任务。"""
    tasks = sorted(set(a) & set(b))
    if not tasks:
        return 0.0
    rng = random.Random(seed)
    diffs = {t: mean(b[t]) - mean(a[t]) for t in tasks}
    wins = 0
    for _ in range(n_boot):
        wins += sum(diffs[rng.choice(tasks)] for _ in tasks) > 0
    return wins / n_boot


def cost(records: list[RunRecord]) -> dict[str, float]:
    n = len(records) or 1
    return {"avg_input_tokens": sum(r.input_tokens for r in records) / n,
            "avg_output_tokens": sum(r.output_tokens for r in records) / n,
            "avg_seconds": sum(r.seconds for r in records) / n,
            "avg_turns": sum(r.turns for r in records) / n}


def stops(records: list[RunRecord]) -> dict[str, int]:
    out: dict[str, int] = defaultdict(int)
    for r in records:
        out[r.stopped] += 1
    return dict(out)


def compare(base: list[RunRecord], cand: list[RunRecord]) -> dict:
    """同一批任务上两个版本的对比：哪些变好、哪些变差。"""
    a, b = by_task(base), by_task(cand)
    shared = sorted(set(a) & set(b))
    better = [t for t in shared if mean(b[t]) > mean(a[t])]
    worse = [t for t in shared if mean(b[t]) < mean(a[t])]
    return {"tasks": len(shared), "better": better, "worse": worse,
            "base": reliability({t: a[t] for t in shared}), "cand": reliability({t: b[t] for t in shared}),
            "prob_better": paired_bootstrap({t: a[t] for t in shared}, {t: b[t] for t in shared})}


def pct(x: float) -> str:
    return f"{x * 100:.1f}%"


def render(title: str, records: list[RunRecord], base: list[RunRecord] | None = None) -> str:
    runs = by_task(records)
    rel, c = reliability(runs), cost(records)
    attempts = max((len(v) for v in runs.values()), default=0)
    graders = ", ".join(sorted({r.grader for r in records}))
    lines = [f"{title}  评分器 {graders}  {len(runs)} 条任务，每条 {attempts} 次", ""]
    if base is not None:
        cmp = compare(base, records)
        lines += [f"{'':14}{'基线':>8}{'候选':>8}",
                  f"{'至少成功一次':<10}{pct(cmp['base']['pass_any']):>8}{pct(cmp['cand']['pass_any']):>8}",
                  f"{'每次都成功':<11}{pct(cmp['base']['pass_all']):>8}{pct(cmp['cand']['pass_all']):>8}",
                  f"{'平均通过率':<11}{pct(cmp['base']['mean']):>8}{pct(cmp['cand']['mean']):>8}", "",
                  f"变好的任务 {len(cmp['better'])} 条   变差的任务 {len(cmp['worse'])} 条   "
                  f"候选更好的把握 {pct(cmp['prob_better'])}"]
    else:
        lines += [f"至少成功一次  {pct(rel['pass_any'])}", f"每次都成功    {pct(rel['pass_all'])}",
                  f"平均通过率    {pct(rel['mean'])}"]
    lines += [f"不稳定任务 {len(flaky(runs))} 条：{', '.join(flaky(runs)) or '无'}",
              f"平均用量 输入 {c['avg_input_tokens']:.0f} / 输出 {c['avg_output_tokens']:.0f}   "
              f"平均耗时 {c['avg_seconds']:.1f}s   平均轮次 {c['avg_turns']:.1f}",
              "停止原因：" + "  ".join(f"{k} {v}" for k, v in sorted(stops(records).items()))]
    return "\n".join(lines)
