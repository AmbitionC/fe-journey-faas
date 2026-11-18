"""失败分析：逐条把失败归因到具体环节，再把相似的归因聚成几类弱点。"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass

from ..types import RunRecord, Task, TextModel
from .common import example_block, extract_json

COMPONENTS = ("prompt", "loop", "context", "tool", "unknown")

SYSTEM = "你在分析一个编程 Agent 的失败运行。只根据给出的轨迹和评分理由判断，证据不足时如实说 unknown。"
TEMPLATE = """{example}

请判断这次失败出在哪个环节，只输出一个 JSON 对象：
{{"symptom": "看到了什么现象（一句话）",
  "cause": "推断的直接原因（一句话）",
  "component": "prompt | loop | context | tool | unknown",
  "weakness": "用 3~8 个字概括这类问题，例如：没有验证就收尾"}}

component 的含义：prompt=系统提示词没说清该怎么做；loop=轮次预算不够或提前停止；
context=关键信息被截断或没看到；tool=工具本身的行为或说明有问题。"""


@dataclass
class Diagnosis:
    task_id: str
    symptom: str
    cause: str
    component: str
    weakness: str


def heuristic(record: RunRecord) -> Diagnosis:
    """模型没给出可用的归因时，用停止原因兜底。"""
    if record.stopped == "max_turns":
        return Diagnosis(record.task_id, "跑到轮次上限", "预算不够或在同一处打转", "loop", "轮次用尽")
    if record.stopped in ("timeout", "model_error"):
        return Diagnosis(record.task_id, f"停止原因 {record.stopped}", "运行环境或模型接口问题", "unknown", "运行中断")
    return Diagnosis(record.task_id, "正常结束但未通过", record.reason[:80], "unknown", "未归因")


async def diagnose(model: TextModel, tasks: dict[str, Task], failures: list[RunRecord]) -> list[Diagnosis]:
    out = []
    for r in failures:
        data = extract_json(await model.ask(SYSTEM, TEMPLATE.format(example=example_block(tasks[r.task_id].prompt, r))))
        if isinstance(data, dict) and data.get("component") in COMPONENTS and data.get("weakness"):
            out.append(Diagnosis(r.task_id, str(data.get("symptom", "")), str(data.get("cause", "")),
                                 data["component"], str(data["weakness"])[:20]))
        else:
            out.append(heuristic(r))
    return out


def cluster(diagnoses: list[Diagnosis]) -> list[tuple[str, list[Diagnosis]]]:
    """按（环节，弱点）聚类，影响任务数多的排前面。"""
    groups: dict[tuple[str, str], list[Diagnosis]] = defaultdict(list)
    for d in diagnoses:
        groups[(d.component, d.weakness)].append(d)
    ranked = sorted(groups.items(), key=lambda kv: (-len({d.task_id for d in kv[1]}), kv[0]))
    return [(f"{component}：{weakness}", items) for (component, weakness), items in ranked]
