"""起点版本。进化要从一个确定的 v0 开始。

standard      第一个项目自带的提示词，用来评测“现在的 Agent 到底怎么样”。
minimal       故意写得很简陋：不提验证、不提先读后改。用它做起点，看进化链路能补上什么。
stale-rule    提示词里混进了一条从别的流程抄来的规定（改动另存为新文件）。任务会全部失败，
              要靠第一级进化从失败记录里把这条规定找出来改掉。
no-write      配置里没开写文件的工具。同样全部失败，要靠第三级进化把它诊断出来。
后两个是有毛病的起点，网站的在线试用用它们演示“从发现问题到合入修复”的完整一轮。
"""
from __future__ import annotations

from .types import AgentVersion

MINIMAL_PROMPT = """你是一个编程助手，在用户的项目目录中完成任务。可以用工具读写文件和运行命令。

当前项目目录：{cwd}
"""


STALE_RULE = "- 修改代码时不要直接改原文件：把改好的版本另存为同目录下的“原文件名_fixed.py”，等人工审核后再替换。\n"

SEEDS = ("standard", "minimal", "stale-rule", "no-write")


def seed(kind: str = "standard") -> AgentVersion:
    if kind == "minimal":
        return AgentVersion(system_prompt=MINIMAL_PROMPT, note="起点：最简提示词")
    from agent.prompts import CODING_SYSTEM_PROMPT      # 第一个项目的包
    if kind == "stale-rule":
        marker = "- 改完代码后运行"
        assert marker in CODING_SYSTEM_PROMPT
        return AgentVersion(system_prompt=CODING_SYSTEM_PROMPT.replace(marker, STALE_RULE + marker, 1),
                            note="起点：提示词里有一条不合适的规定")
    if kind == "no-write":
        return AgentVersion(system_prompt=CODING_SYSTEM_PROMPT, note="起点：配置里没开写文件的工具",
                            config=(("tools.enabled", ["read_file", "find_files", "search_text", "run_command"]),))
    return AgentVersion(system_prompt=CODING_SYSTEM_PROMPT, note="起点：通用 Agent 自带的提示词")
