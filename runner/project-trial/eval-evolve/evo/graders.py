"""评分器：代码判定、模型裁判、人工抽检队列。评分器带版本号，改过之后旧分数和新分数不能直接比。"""
from __future__ import annotations

import asyncio
import hashlib
import json
import subprocess
from pathlib import Path
from typing import Awaitable, Callable, Protocol

from .types import Grade, RunOutput, Task, TextModel

SKIP = ("__pycache__", ".pytest_cache", ".git")


class Grader(Protocol):
    name: str
    version: str
    async def grade(self, task: Task, workdir: Path, output: RunOutput, before: dict[str, str]) -> Grade: ...


def snapshot(root: Path, prefixes: list[str]) -> dict[str, str]:
    """记录受保护路径下每个文件的内容哈希，运行后再比一次。"""
    out: dict[str, str] = {}
    for prefix in prefixes:
        base = root / prefix
        files = [base] if base.is_file() else sorted(p for p in base.rglob("*") if p.is_file()) if base.is_dir() else []
        for f in files:
            if not any(part in SKIP for part in f.parts):
                out[str(f.relative_to(root))] = hashlib.sha256(f.read_bytes()).hexdigest()
    return out


# 检查命令在哪里执行：(工作目录, 命令, 超时秒数) -> (退出码；超时为 None, 输出)
Check = Callable[[Path, str, int], Awaitable[tuple[int | None, str]]]


async def local_check(workdir: Path, command: str, timeout: int) -> tuple[int | None, str]:
    def run() -> tuple[int | None, str]:
        try:
            proc = subprocess.run(command, shell=True, cwd=workdir, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            return None, ""
        return proc.returncode, proc.stdout + proc.stderr

    return await asyncio.to_thread(run)      # 放到线程里：几条任务并发评测时，评分不互相堵着


class CommandGrader:
    """检查命令退出码为 0，并且不许改的文件确实没被改，才算通过。

    第二个条件必不可少：否则删掉失败的用例也能让检查命令变绿。
    """
    name, version = "command", "2"

    def __init__(self, timeout: int = 120, check: Check = local_check):
        """check 默认在本机执行；在线试用时换成“发到隔离沙箱里执行”。"""
        self.timeout, self.check = timeout, check

    async def grade(self, task: Task, workdir: Path, output: RunOutput, before: dict[str, str]) -> Grade:
        after = snapshot(workdir, task.forbid_changes)
        if after != before:
            changed = sorted((set(before) ^ set(after)) | {k for k in before if k in after and after[k] != before[k]})
            return Grade(False, f"改动了不允许修改的文件：{', '.join(changed[:5])}", evidence={"changed": changed})
        code, output = await self.check(workdir, task.check, self.timeout)
        if code is None:
            return Grade(False, "检查命令超时")
        tail = output.strip()[-600:]
        if code != 0:
            # 理由要具体到哪条断言失败：失败分析和提案器只能看到这段文字
            return Grade(False, f"检查命令退出码 {code}。输出末尾：\n{tail}", evidence={"tail": tail})
        return Grade(True, "检查命令通过，受保护文件未改动", evidence={"tail": tail})


JUDGE_SYSTEM = "你是评分员。只根据给出的细则判断，不要考虑细则之外的优缺点。"
JUDGE_TEMPLATE = """任务：{task}
细则：{rubric}
待评内容：{reply}

先用一两句话写出依据，再在最后一行只输出：通过 或 不通过
如果待评内容不足以判断，最后一行输出：无法判断"""


def parse_verdict(text: str) -> bool | None:
    last = next((line.strip() for line in reversed(text.strip().splitlines()) if line.strip()), "")
    if "无法判断" in last:
        return None
    if "不通过" in last:
        return False
    if "通过" in last:
        return True
    return None


class JudgeGrader:
    """模型裁判：只评代码判定不了的部分（比如最终回复有没有说清原因）。无法判断时不算通过。"""
    name = "judge"

    def __init__(self, model: TextModel, version: str = "1"):
        self.model, self.version = model, version

    async def grade(self, task: Task, workdir: Path, output: RunOutput, before: dict[str, str]) -> Grade:
        if not task.rubric:
            return Grade(True, "这条任务没有需要裁判的细则")
        text = await self.model.ask(JUDGE_SYSTEM, JUDGE_TEMPLATE.format(
            task=task.prompt, rubric=task.rubric, reply=output.final_reply[:4000] or "（空）"))
        verdict = parse_verdict(text)
        if verdict is None:
            return Grade(False, f"裁判无法判断：{text.strip()[-200:]}", evidence={"undecided": True})
        return Grade(verdict, f"裁判{'通过' if verdict else '不通过'}：{text.strip()[:300]}")


class AllOf:
    """几个评分器都通过才算通过；理由取第一个不通过的。"""

    def __init__(self, *graders: Grader):
        self.graders = graders
        self.name = "+".join(g.name for g in graders)
        self.version = "+".join(f"{g.name}@{g.version}" for g in graders)

    async def grade(self, task: Task, workdir: Path, output: RunOutput, before: dict[str, str]) -> Grade:
        reasons = []
        for g in self.graders:
            grade = await g.grade(task, workdir, output, before)
            if not grade.passed:
                return grade
            reasons.append(grade.reason)
        return Grade(True, "；".join(reasons))


class SpotCheckQueue:
    """人工抽检：每隔 every 条把一次判定写进待看队列，人标注后用 agreement() 看裁判和人是否一致。"""

    def __init__(self, path: Path, every: int = 10):
        self.path, self.every, self.count = path, every, 0

    def offer(self, task_id: str, reply: str, grade: Grade) -> bool:
        self.count += 1
        if self.count % self.every:
            return False
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps({"task_id": task_id, "reply": reply[:2000], "grader_passed": grade.passed,
                                "grader_reason": grade.reason, "human_passed": None}, ensure_ascii=False) + "\n")
        return True

    def agreement(self) -> tuple[int, int]:
        """返回（人和评分器一致的条数，已标注的条数）。"""
        if not self.path.exists():
            return 0, 0
        rows = [json.loads(line) for line in self.path.read_text(encoding="utf-8").splitlines() if line.strip()]
        labeled = [r for r in rows if r.get("human_passed") is not None]
        return sum(r["human_passed"] == r["grader_passed"] for r in labeled), len(labeled)
