"""第三级进化：改配置与工具集（Self-Harness 的思路）。

先做失败分析，把失败聚成几类弱点；针对影响任务最多的那一类提一个配置修改。
修改必须落在允许的范围内，并且先在这类弱点涉及的任务上验证有效，再过闸门。
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from statistics import mean
from typing import Any

from ..harness import BOUNDS, effective_config, validate_config
from ..types import AgentVersion
from .common import extract_json
from .diagnose import cluster, diagnose
from .gate import Bench, Decision, admit, precheck, reject

SYSTEM = "你在调整一个编程 Agent 的外壳配置。只能改给出的配置项，并且要说明预期效果和风险。"
TEMPLATE = """当前配置：
{config}

可调的配置项和范围：
{bounds}

失败分析发现的弱点（影响 {n} 条任务）：{weakness}
具体表现：
{details}

此前尝试过但被拒绝的修改：
{rejected}

如果这个弱点能通过改配置缓解，给出修改；如果不能（比如它其实是提示词的问题），changes 留空。
只输出一个 JSON 对象：
{{"changes": {{"配置项": 新值}}, "rationale": "为什么这样改", "expected_effect": "预期哪类任务变好",
  "risk": "可能让哪类任务变差"}}"""


@dataclass
class Proposal:
    weakness: str
    changes: dict[str, Any]
    rationale: str = ""
    expected_effect: str = ""
    risk: str = ""


def describe_bounds() -> str:
    return "\n".join(f"- {k}：{v}" for k, v in BOUNDS.items())


async def evolve_config(bench: Bench, model, current: AgentVersion) -> tuple[AgentVersion, Decision | None]:
    evolve_set = bench.split("evolve")
    tasks = {t.id: t for t in evolve_set}
    records = await bench.run(current, evolve_set, "基线·进化集")
    failures = [r for r in records if not r.passed]
    if not failures:
        bench.notify("note", {"text": "进化集已全部通过，没有可分析的失败"})
        return current, None
    groups = cluster(await diagnose(model, tasks, failures))
    weakness, items = groups[0]
    bench.notify("diagnosis", {"groups": [(name, sorted({d.task_id for d in ds})) for name, ds in groups]})

    data = extract_json(await model.ask(SYSTEM, TEMPLATE.format(
        config=json.dumps(effective_config(current.config_dict), ensure_ascii=False, indent=2),
        bounds=describe_bounds(), n=len({d.task_id for d in items}), weakness=weakness,
        details="\n".join(f"- {d.task_id}：{d.symptom}；{d.cause}" for d in items),
        rejected="\n".join(f"- {x}" for x in bench.store.rejected_notes()) or "（无）") + bench.limits()))
    changes = data.get("changes") if isinstance(data, dict) else None
    proposal = Proposal(weakness, changes if isinstance(changes, dict) else {},
                        *(str(data.get(k, "")) for k in ("rationale", "expected_effect", "risk"))) \
        if isinstance(data, dict) else Proposal(weakness, {})
    # 和当前值相同的不算修改
    effective = effective_config(current.config_dict)
    proposal.changes = {k: v for k, v in proposal.changes.items() if effective.get(k) != v}
    bench.notify("proposal", {"level": 3, "weakness": weakness, "changes": proposal.changes,
                              "rationale": proposal.rationale, "risk": proposal.risk,
                              "changed": bool(proposal.changes)})
    if not proposal.changes:
        return current, None

    note = f"配置：{json.dumps(proposal.changes, ensure_ascii=False)}（针对 {weakness}）"
    candidate = current.derive(note, config={**current.config_dict, **proposal.changes})
    errors = validate_config(proposal.changes)
    if errors:
        return current, reject(bench, candidate, current, "超出允许范围：" + "；".join(errors), "bounds")
    if (blocked := precheck(bench, candidate, current)):
        return current, blocked

    # 先只跑这类弱点涉及的任务：它们都没变好，就不必花钱跑另外两套
    targeted = [tasks[t] for t in sorted({d.task_id for d in items})]
    base_t = [r for r in records if r.task_id in {t.id for t in targeted}]
    cand_t = await bench.run(candidate, targeted, "候选·弱点涉及的任务")
    if mean(r.passed for r in cand_t) <= mean(r.passed for r in base_t):
        return current, reject(bench, candidate, current, "弱点涉及的任务没有变好", "targeted")
    decision = await admit(bench, candidate, current)
    return (candidate if decision.admitted else current), decision
