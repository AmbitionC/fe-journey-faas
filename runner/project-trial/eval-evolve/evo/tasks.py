"""任务集：每条任务一个目录（task.json + repo/ + solution/），分成互不重叠的三套。"""
from __future__ import annotations

import json
import random
from collections import defaultdict
from pathlib import Path

from .types import SPLITS, Task


def load_task(folder: Path) -> Task:
    d = json.loads((folder / "task.json").read_text(encoding="utf-8"))
    if d.get("split") not in SPLITS:
        raise ValueError(f"{folder.name}: split 必须是 {SPLITS} 之一")
    solution = folder / "solution"
    return Task(id=d["id"], split=d["split"], prompt=d["prompt"], repo=folder / "repo", check=d["check"],
                forbid_changes=d.get("forbid_changes", []), allow=d.get("allow", []),
                solution=solution if solution.is_dir() else None, source=d.get("source", "synthetic"),
                difficulty=d.get("difficulty", "single_file"), similar_group=d.get("similar_group", d["id"]),
                rubric=d.get("rubric", ""), expect_noop=bool(d.get("expect_noop", False)))


def load_tasks(root: Path) -> list[Task]:
    tasks = [load_task(p) for p in sorted(root.iterdir()) if (p / "task.json").is_file()]
    check_splits(tasks)
    return tasks


def check_splits(tasks: list[Task]) -> None:
    """同一个相似组不能跨集合：否则进化时见过的题换个皮出现在验收集里，验收就失去了意义。"""
    ids = [t.id for t in tasks]
    if len(ids) != len(set(ids)):
        raise ValueError("任务编号重复")
    where: dict[str, set[str]] = defaultdict(set)
    for t in tasks:
        where[t.similar_group].add(t.split)
    leaked = sorted(g for g, s in where.items() if len(s) > 1)
    if leaked:
        raise ValueError(f"相似组跨了集合：{', '.join(leaked)}")


def by_split(tasks: list[Task], split: str) -> list[Task]:
    return [t for t in tasks if t.split == split]


def assign_splits(tasks: list[Task], seed: int, stable_ids: set[str]) -> dict[str, list[Task]]:
    """给一批还没分配的任务划分三套。

    回归集只从“当前版本每次都能通过”的任务组里抽，约占四分之一；
    其余按来源和难度分层，再按 2:1 分给进化集和验收集。相似任务整组进同一套。
    """
    groups: dict[str, list[Task]] = defaultdict(list)
    for t in tasks:
        groups[t.similar_group].append(t)
    names = sorted(groups)
    rng = random.Random(seed)
    out: dict[str, list[Task]] = {s: [] for s in SPLITS}

    stable = [g for g in names if all(t.id in stable_ids for t in groups[g])]
    rng.shuffle(stable)
    regress = set(stable[: len(names) // 4])
    for g in sorted(regress):
        out["regress"].extend(groups[g])

    strata: dict[tuple[str, str], list[str]] = defaultdict(list)
    for g in names:
        if g not in regress:
            first = groups[g][0]
            strata[(first.source, first.difficulty)].append(g)
    for key in sorted(strata):
        members = strata[key]
        rng.shuffle(members)
        for i, g in enumerate(members):
            out[("evolve", "evolve", "accept")[i % 3]].extend(groups[g])
    return out
