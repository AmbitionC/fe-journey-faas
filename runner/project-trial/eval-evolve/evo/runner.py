"""运行器：用指定版本逐条运行任务，每条任务一份全新的仓库副本，每条运行多次。"""
from __future__ import annotations

import asyncio
import shutil
import tempfile
import time
from pathlib import Path
from typing import Callable

from .graders import Grader, snapshot
from .store import Store
from .types import AgentUnderTest, AgentVersion, RunOutput, RunRecord, Task, Usage

IGNORE = shutil.ignore_patterns("__pycache__", ".pytest_cache", ".git")
Progress = Callable[[RunRecord], None]


def prepare_workdir(task: Task) -> tuple[Path, Path]:
    tmp = Path(tempfile.mkdtemp(prefix=f"evo-{task.id}-"))
    workdir = tmp / "repo"
    shutil.copytree(task.repo, workdir, ignore=IGNORE)
    return tmp, workdir


def apply_solution(task: Task, workdir: Path) -> None:
    """把参考解覆盖到仓库上。审计评分器时用。"""
    if task.solution:
        shutil.copytree(task.solution, workdir, dirs_exist_ok=True, ignore=IGNORE)


async def run_once(agent: AgentUnderTest, grader: Grader, version: AgentVersion, task: Task, attempt: int,
                   timeout: float = 600) -> RunRecord:
    tmp, workdir = prepare_workdir(task)
    try:
        before = snapshot(workdir, task.forbid_changes)
        started = time.monotonic()
        try:
            output = await asyncio.wait_for(agent.run(task.prompt, workdir, version, task.allow), timeout=timeout)
        except asyncio.TimeoutError:
            output = RunOutput("", [], Usage(), "timeout")
        except Exception as e:  # 被测对象自己出错也是一种结果，要记下来而不是让整批评测中断
            output = RunOutput("", [], Usage(), "model_error")
            output.final_reply = f"{type(e).__name__}: {e}"
        seconds = round(time.monotonic() - started, 2)
        grade = await grader.grade(task, workdir, output, before)
        return RunRecord(version.id, task.id, task.split, attempt, grade.passed, grade.reason,
                         f"{grader.name}@{grader.version}", output.usage.input, output.usage.output, seconds,
                         output.stopped, output.turns, output.final_reply, output.trajectory)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


async def evaluate(agent: AgentUnderTest, grader: Grader, version: AgentVersion, tasks: list[Task], *,
                   attempts: int = 1, concurrency: int = 4, store: Store | None = None,
                   on_record: Progress | None = None, on_start: Callable[[Task, int], None] | None = None,
                   timeout: float = 600) -> list[RunRecord]:
    """返回 len(tasks) × attempts 条记录。并发受 concurrency 限制。"""
    sem = asyncio.Semaphore(concurrency)

    async def one(task: Task, attempt: int) -> RunRecord:
        async with sem:
            if on_start:
                on_start(task, attempt)
            record = await run_once(agent, grader, version, task, attempt, timeout)
        if store:
            store.add_run(record)
        if on_record:
            on_record(record)
        return record

    return list(await asyncio.gather(*(one(t, a) for t in tasks for a in range(attempts))))
