"""四级提案器共用的小工具：从模型回复里取 JSON、把一次运行压成给模型看的摘要。"""
from __future__ import annotations

import json
import re

from ..types import RunRecord


def extract_json(text: str):
    """模型常把 JSON 包在代码块或说明文字里：先找代码块，再找第一段配平的括号。"""
    for block in re.findall(r"```(?:json)?\s*(.*?)```", text, flags=re.S):
        try:
            return json.loads(block)
        except json.JSONDecodeError:
            continue
    # 哪种括号先出现就先按哪种找：数组里包着对象时，要取到的是外层的数组
    pairs = sorted((("{", "}"), ("[", "]")), key=lambda p: text.find(p[0]) if p[0] in text else len(text))
    for opener, closer in pairs:
        start = text.find(opener)
        while start != -1:
            depth, in_str, escape = 0, False, False
            for i in range(start, len(text)):
                ch = text[i]
                if in_str:
                    escape = ch == "\\" and not escape
                    if ch == '"' and not escape:
                        in_str = False
                    continue
                if ch == '"':
                    in_str = True
                elif ch == opener:
                    depth += 1
                elif ch == closer:
                    depth -= 1
                    if depth == 0:
                        try:
                            return json.loads(text[start:i + 1])
                        except json.JSONDecodeError:
                            break
            start = text.find(opener, start + 1)
    return None


def extract_block(text: str, tag: str) -> str:
    """取 <tag>…</tag> 之间的内容；没有就返回空串。"""
    m = re.search(rf"<{tag}>\s*(.*?)\s*</{tag}>", text, flags=re.S)
    return m.group(1) if m else ""


def trace_summary(record: RunRecord, max_steps: int = 14, width: int = 160) -> str:
    """把轨迹压成“第几步调了什么、结果开头是什么”。提案器看的是这个，而不是几万字的原始轨迹。"""
    steps, results = [], {}
    for m in record.trajectory:
        if m.get("role") == "tool":
            results[m.get("tool_call_id")] = (m.get("content") or "").strip().replace("\n", " ⏎ ")[:width]
    n = 0
    for m in record.trajectory:
        if m.get("role") != "assistant":
            continue
        for call in m.get("tool_calls") or []:
            n += 1
            fn = call.get("function", {})
            args = (fn.get("arguments") or "").replace("\n", " ")[:width]
            steps.append(f"  {n}. {fn.get('name')}({args}) → {results.get(call.get('id'), '')}")
    if len(steps) > max_steps:
        steps = steps[: max_steps // 2] + [f"  ……（省略 {len(steps) - max_steps} 步）"] + steps[-max_steps // 2:]
    return "\n".join(steps) or "  （没有调用任何工具）"


def example_block(task_prompt: str, record: RunRecord) -> str:
    return (f"任务 {record.task_id}：{task_prompt}\n"
            f"结果：{'通过' if record.passed else '未通过'}（停止原因 {record.stopped}，{record.turns} 轮）\n"
            f"评分理由：{record.reason[:500]}\n轨迹摘要：\n{trace_summary(record)}\n"
            f"最终回复：{record.final_reply[:300] or '（空）'}")
