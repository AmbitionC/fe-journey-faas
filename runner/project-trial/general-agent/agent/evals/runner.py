"""最小评测：任务集、运行器、确定性评分、结果表。

    python -m agent.evals.runner tasks/ --repeat 3 --out results.json

每条任务是一个 YAML 风格的 JSON 文件（为了不引入依赖，这里用 JSON）：
{"id": "cart-rounding", "repo": "fixtures/shop", "prompt": "……",
 "check": "python -m pytest tests/test_cart.py -q", "forbid_changes": ["tests/"],
 "allow": ["python -m pytest*"], "max_turns": 30, "timeout": 600}
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import shutil
import subprocess
import tempfile
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

from ..build import build_coding_agent
from ..kernel.permission import Rule
from ..model import ModelClient, OpenAICompatModel

WRITE_TOOLS = ("write_file", "edit_file")


@dataclass
class Task:
    id: str
    repo: str
    prompt: str
    check: str
    forbid_changes: list[str] = field(default_factory=list)
    allow: list[str] = field(default_factory=list)
    setup: str = ""
    max_turns: int = 30
    timeout: int = 600

    @classmethod
    def load(cls, path: Path) -> "Task":
        data = json.loads(path.read_text(encoding="utf-8"))
        data["repo"] = str((path.parent / data["repo"]).resolve())
        return cls(**data)


@dataclass
class Result:
    task_id: str
    passed: bool
    reason: str
    turns: int
    input_tokens: int
    output_tokens: int
    seconds: float
    stopped: str
    session_file: str


def snapshot(root: Path, prefixes: list[str]) -> dict[str, str]:
    out = {}
    for prefix in prefixes:
        base = root / prefix
        files = [base] if base.is_file() else sorted(p for p in base.rglob("*") if p.is_file()) if base.is_dir() else []
        for f in files:
            if "__pycache__" not in f.parts and ".pytest_cache" not in f.parts:
                out[str(f.relative_to(root))] = hashlib.sha256(f.read_bytes()).hexdigest()
    return out


def grade(task: Task, workdir: Path, before: dict[str, str]) -> tuple[bool, str]:
    """check 命令退出码为 0，并且 forbid_changes 里的路径没有被改动，才算通过。

    第二个条件必不可少，否则 Agent 可以通过删掉失败的用例来“修好”测试。
    """
    after = snapshot(workdir, task.forbid_changes)
    if after != before:
        changed = sorted(set(before) ^ set(after) | {k for k in before if after.get(k) != before[k]})
        return False, f"改动了不允许修改的文件：{', '.join(changed[:5])}"
    try:
        proc = subprocess.run(task.check, shell=True, cwd=workdir, capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired:
        return False, "检查命令超时"
    if proc.returncode != 0:
        return False, f"检查命令退出码 {proc.returncode}：{(proc.stdout + proc.stderr).strip()[-200:]}"
    return True, "通过"


async def run_task(task: Task, model: ModelClient, sessions_dir: Path, run_index: int = 0) -> Result:
    tmp = Path(tempfile.mkdtemp(prefix=f"eval-{task.id}-"))
    workdir = tmp / "repo"
    shutil.copytree(task.repo, workdir, ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache", ".git"))
    try:
        if task.setup:
            subprocess.run(task.setup, shell=True, cwd=workdir, check=True, capture_output=True, timeout=300)
        before = snapshot(workdir, task.forbid_changes)
        sessions_dir.mkdir(parents=True, exist_ok=True)
        session_file = sessions_dir / f"{task.id}-{run_index}.jsonl"
        # 无界面模式：需要询问的一律视为拒绝，放行规则必须显式写在任务里
        rules = [Rule("run_command", p, "allow") for p in task.allow] + [Rule(t, "*", "allow") for t in WRITE_TOOLS]
        agent = build_coding_agent(model, workdir, rules=rules, headless=True, session_file=session_file,
                                   max_turns=task.max_turns, home=tmp)
        started = time.monotonic()
        try:
            outcome = await asyncio.wait_for(agent.run(task.prompt), timeout=task.timeout)
            stopped, turns, usage = outcome.stopped, outcome.turns, outcome.usage
        except asyncio.TimeoutError:
            stopped, turns, usage = "timeout", 0, None
        seconds = time.monotonic() - started
        passed, reason = grade(task, workdir, before)
        return Result(task.id, passed, reason, turns, usage.input if usage else 0, usage.output if usage else 0,
                      round(seconds, 1), stopped, str(session_file))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)  # 每条任务一份全新副本，跑完即弃


def summarize(results: list[Result]) -> dict:
    by_task: dict[str, list[Result]] = {}
    for r in results:
        by_task.setdefault(r.task_id, []).append(r)
    n = len(results) or 1
    stops: dict[str, int] = {}
    for r in results:
        stops[r.stopped] = stops.get(r.stopped, 0) + 1
    return {
        "tasks": len(by_task), "runs": len(results),
        "pass_rate": round(sum(r.passed for r in results) / n, 3),
        "pass_any": round(sum(any(r.passed for r in rs) for rs in by_task.values()) / (len(by_task) or 1), 3),
        "pass_all": round(sum(all(r.passed for r in rs) for rs in by_task.values()) / (len(by_task) or 1), 3),
        "avg_turns": round(sum(r.turns for r in results) / n, 1),
        "avg_input_tokens": round(sum(r.input_tokens for r in results) / n),
        "avg_output_tokens": round(sum(r.output_tokens for r in results) / n),
        "avg_seconds": round(sum(r.seconds for r in results) / n, 1),
        "stopped": stops,
        "flaky": sorted(t for t, rs in by_task.items() if 0 < sum(r.passed for r in rs) < len(rs)),
        "per_task": {t: f"{sum(r.passed for r in rs)}/{len(rs)}" for t, rs in sorted(by_task.items())},
    }


async def run_suite(tasks: list[Task], model: ModelClient, sessions_dir: Path, repeat: int = 1,
                    parallel: int = 2) -> list[Result]:
    sem = asyncio.Semaphore(parallel)

    async def one(task: Task, i: int) -> Result:
        async with sem:
            return await run_task(task, model, sessions_dir, i)

    return list(await asyncio.gather(*(one(t, i) for t in tasks for i in range(repeat))))


def main() -> None:
    p = argparse.ArgumentParser(description="运行编程任务评测")
    p.add_argument("tasks_dir")
    p.add_argument("--repeat", type=int, default=3)
    p.add_argument("--parallel", type=int, default=2)
    p.add_argument("--out", default="eval-results.json")
    args = p.parse_args()
    tasks = [Task.load(f) for f in sorted(Path(args.tasks_dir).glob("*.json"))]
    out = Path(args.out)
    results = asyncio.run(run_suite(tasks, OpenAICompatModel(), out.parent / "eval-sessions", args.repeat, args.parallel))
    summary = summarize(results)
    out.write_text(json.dumps({"summary": summary, "results": [asdict(r) for r in results]},
                              ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
