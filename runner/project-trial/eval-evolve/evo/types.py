"""平台里流转的几种数据。版本不可变：任何修改都生成新版本，评测结果才能对应到确切的内容。"""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field, replace
from typing import Any, Protocol
from pathlib import Path

SPLITS = ("evolve", "accept", "regress")


@dataclass(frozen=True)
class PlaybookItem:
    id: str            # 稳定编号，如 "verify-003"
    section: str       # 定位 / 修改 / 验证 / 沟通
    content: str
    helpful: int = 0
    harmful: int = 0
    created_in: str = ""


@dataclass(frozen=True)
class AgentVersion:
    """被测 Agent 的一次快照。四个内容字段正好对应四级进化的作用对象。"""
    system_prompt: str                                   # 第一级
    playbook: tuple[PlaybookItem, ...] = ()              # 第二级
    config: tuple[tuple[str, Any], ...] = ()             # 第三级，扁平的 路径→值
    code: str = ""                                       # 第四级，外壳钩子模块的源码
    parent: str | None = None
    note: str = ""

    @property
    def id(self) -> str:
        body = json.dumps([self.system_prompt, [asdict(i) for i in self.playbook], sorted(self.config), self.code],
                          ensure_ascii=False, sort_keys=True, default=str)
        return hashlib.sha256(body.encode()).hexdigest()[:10]

    @property
    def config_dict(self) -> dict[str, Any]:
        return dict(self.config)

    def derive(self, note: str, **changes: Any) -> "AgentVersion":
        if "config" in changes and isinstance(changes["config"], dict):
            changes["config"] = tuple(sorted(changes["config"].items()))
        if "playbook" in changes:
            changes["playbook"] = tuple(changes["playbook"])
        return replace(self, parent=self.id, note=note, **changes)

    def to_json(self) -> dict:
        return {"id": self.id, "parent": self.parent, "note": self.note, "system_prompt": self.system_prompt,
                "playbook": [asdict(i) for i in self.playbook], "config": self.config_dict, "code": self.code}

    @classmethod
    def from_json(cls, d: dict) -> "AgentVersion":
        return cls(system_prompt=d["system_prompt"], playbook=tuple(PlaybookItem(**i) for i in d.get("playbook", [])),
                   config=tuple(sorted(d.get("config", {}).items())), code=d.get("code", ""),
                   parent=d.get("parent"), note=d.get("note", ""))


@dataclass
class Task:
    id: str
    split: str                     # evolve | accept | regress
    prompt: str
    repo: Path                     # 任务的初始仓库
    check: str                     # 判定用的命令，退出码 0 为通过
    forbid_changes: list[str] = field(default_factory=list)
    allow: list[str] = field(default_factory=list)
    solution: Path | None = None   # 参考解：覆盖到仓库上的文件目录
    source: str = "synthetic"      # real_failure | upstream_fix | synthetic
    difficulty: str = "single_file"
    similar_group: str = ""
    rubric: str = ""               # 给模型裁判的细则；为空则不用裁判


@dataclass
class Usage:
    input: int = 0
    output: int = 0


@dataclass
class RunOutput:
    final_reply: str
    trajectory: list[dict]
    usage: Usage
    stopped: str                   # finished | max_turns | timeout | model_error | interrupted
    turns: int = 0


@dataclass
class Grade:
    passed: bool
    reason: str = ""
    score: float | None = None
    evidence: dict = field(default_factory=dict)


@dataclass
class RunRecord:
    version_id: str
    task_id: str
    split: str
    attempt: int
    passed: bool
    reason: str
    grader: str
    input_tokens: int
    output_tokens: int
    seconds: float
    stopped: str
    turns: int = 0
    final_reply: str = ""
    trajectory: list[dict] = field(default_factory=list)


class AgentUnderTest(Protocol):
    """平台对被测对象只有这一个接口要求。"""
    async def run(self, task_prompt: str, workdir: Path, version: AgentVersion, allow: list[str]) -> RunOutput: ...


class TextModel(Protocol):
    """失败分析、提案器、模型裁判用的文本接口：给一段系统提示和一段输入，返回文本。"""
    async def ask(self, system: str, user: str) -> str: ...
