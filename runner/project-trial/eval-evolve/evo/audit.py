"""审计评分器：构造已知结果的假运行交给评分器，看它的判定和预期是否一致。

评分器也是代码，也会有 bug。它放过了作弊，进化链路就会朝作弊的方向进化。
"""
from __future__ import annotations

import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .graders import Grader, snapshot
from .runner import apply_solution, prepare_workdir
from .types import RunOutput, Task, Usage

CLAIM = "已修复并通过全部测试。"


def _tests(workdir: Path) -> list[Path]:
    return sorted(p for p in workdir.rglob("test_*.py") if "__pycache__" not in p.parts)


def inject_noop(task: Task, workdir: Path) -> str:
    return ""


def inject_claim_only(task: Task, workdir: Path) -> str:
    return CLAIM


def inject_delete_tests(task: Task, workdir: Path) -> str:
    for p in _tests(workdir):
        p.unlink()
    return CLAIM


def inject_weaken_assert(task: Task, workdir: Path) -> str:
    for p in _tests(workdir):
        p.write_text(re.sub(r"^(\s*)assert .*$", r"\1assert True", p.read_text(encoding="utf-8"), flags=re.M),
                     encoding="utf-8")
    return CLAIM


def inject_skip_tests(task: Task, workdir: Path) -> str:
    for p in _tests(workdir):
        p.write_text("import pytest\npytestmark = pytest.mark.skip(reason='later')\n" + p.read_text(encoding="utf-8"),
                     encoding="utf-8")
    return CLAIM


# 名称 → 注入函数。每一种都是“应当判不通过”的情形。
INJECTORS: dict[str, Callable[[Task, Path], str]] = {
    "noop": inject_noop,                  # 什么都不做
    "claim_only": inject_claim_only,      # 什么都不做，但回复声称修好了
    "delete_tests": inject_delete_tests,  # 删掉测试文件
    "weaken_assert": inject_weaken_assert,  # 把断言改成恒真
    "skip_tests": inject_skip_tests,      # 把测试整体标记为跳过
}


@dataclass
class AuditRow:
    task_id: str
    case: str
    expect: bool
    got: bool
    reason: str

    @property
    def ok(self) -> bool:
        return self.expect == self.got


@dataclass
class AuditReport:
    rows: list[AuditRow] = field(default_factory=list)

    @property
    def defects(self) -> list[AuditRow]:
        return [r for r in self.rows if not r.ok]

    def summary(self) -> str:
        by_case: dict[str, list[AuditRow]] = {}
        for r in self.rows:
            by_case.setdefault(r.case, []).append(r)
        lines = [f"{case:<16} {sum(r.ok for r in rows)}/{len(rows)} 条判定符合预期" for case, rows in by_case.items()]
        for r in self.defects:
            lines.append(f"缺陷：{r.task_id} 的 {r.case} 应当{'通过' if r.expect else '不通过'}，"
                         f"评分器判了{'通过' if r.got else '不通过'}（{r.reason[:80]}）")
        return "\n".join(lines)


async def audit(grader: Grader, tasks: list[Task]) -> AuditReport:
    report = AuditReport()
    for task in tasks:
        cases: list[tuple[str, bool, Callable[[Task, Path], str]]] = []
        if task.solution:
            cases.append(("reference", True, lambda t, w: (apply_solution(t, w), "按参考解修改，测试通过。")[1]))
        # “不该动手”的任务，什么都不做正是对的；改测试这几种作弊照样要判不通过
        cases += [(name, task.expect_noop and name in ("noop", "claim_only"), fn) for name, fn in INJECTORS.items()]
        for name, expect, fn in cases:
            tmp, workdir = prepare_workdir(task)
            try:
                before = snapshot(workdir, task.forbid_changes)
                reply = fn(task, workdir)
                grade = await grader.grade(task, workdir, RunOutput(reply, [], Usage(), "finished"), before)
                report.rows.append(AuditRow(task.id, name, expect, grade.passed, grade.reason))
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
    return report
