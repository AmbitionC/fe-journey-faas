"""终端入口。

    python -m agent.cli                 交互模式
    python -m agent.cli -p "修好测试"    无界面模式，执行一条任务后退出
    python -m agent.cli --dream         整理长期记忆后退出

交互模式里以 / 开头的是命令：/help 列出全部，/plan <任务> 先出计划再动手，/dream 整理记忆，
其余来自项目的 .agent/commands/*.md。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

from .build import build_coding_agent
from .extensions.commands import discover_commands, parse
from .extensions.mcp_client import mount_all
from .kernel.permission import Answer, Rule
from .model import OpenAICompatModel
from .state.dream import consolidate
from .state.memory import MemoryStore
from .types import Event, ToolCall

DIM, BOLD, YELLOW, RED, RESET = "\033[2m", "\033[1m", "\033[33m", "\033[31m", "\033[0m"

PLAN_PROMPT = """先不要动手。用只读的工具把相关代码看清楚，然后给出一份计划：
要改哪些文件、每处怎么改、改完怎么验证、有哪些拿不准需要我确认的地方。只输出计划。

任务：{task}"""
EXECUTE_PROMPT = "计划可以，按它执行。{note}"
BUILTIN = {"help": "列出所有命令", "plan": "先出计划，你同意后再动手：/plan <任务>", "dream": "整理长期记忆"}


async def plan_then_run(agent, task: str, confirm) -> None:
    """计划模式：闸门先切到只读，模型交出计划；用户同意后放开闸门再执行。
    confirm(计划文本) 返回 None 表示放弃，返回字符串表示同意（可以带一句补充要求）。"""
    agent.gate.plan_mode = True
    try:
        outcome = await agent.run(PLAN_PROMPT.format(task=task))
    finally:
        agent.gate.plan_mode = False      # 无论计划阶段怎么结束，都不能把闸门留在只读状态
    note = await confirm(outcome.text)
    if note is not None:
        await agent.run(EXECUTE_PROMPT.format(note=f"补充要求：{note}" if note else "").strip())


MEMORY_DB = Path.home() / ".agent" / "memory.db"


def load_rules(cwd: Path) -> list[Rule]:
    """项目规则：项目目录下的 .agent/rules.json，可以提交到仓库。"""
    path = cwd / ".agent" / "rules.json"
    if not path.is_file():
        return []
    return [Rule(r["tool"], r["pattern"], r["decision"]) for r in json.loads(path.read_text(encoding="utf-8"))]


def render(event: Event) -> None:
    d = event.data
    if event.kind == "text_delta":
        print(d["text"], end="", flush=True)
    elif event.kind == "tool_start":
        args = json.dumps(d["arguments"], ensure_ascii=False)
        print(f"\n{DIM}▸ {d['name']} {args[:160]}{RESET}", flush=True)
    elif event.kind == "tool_end":
        first = d["result"].strip().splitlines()[0] if d["result"].strip() else ""
        color = RED if d["denied"] else DIM
        print(f"{color}  {first[:160]}{RESET}", flush=True)


async def ask_in_terminal(call: ToolCall, reason: str) -> Answer:
    print(f"\n{YELLOW}{BOLD}需要确认{RESET} {call.name}")
    for key, value in call.arguments.items():
        text = str(value)
        print(f"  {key}: {text if len(text) < 600 else text[:600] + '……'}")
    if reason:
        print(f"  {DIM}{reason}{RESET}")
    choice = (await asyncio.to_thread(input, "  [y] 同意这一次  [a] 本会话同类不再问  [n] 拒绝 > ")).strip().lower()
    if choice == "y":
        return Answer("once")
    if choice == "a":
        return Answer("always")
    note = (await asyncio.to_thread(input, "  想对它说什么（可留空）> ")).strip()
    return Answer("deny", note)


async def main_async(args: argparse.Namespace) -> int:
    cwd = Path(args.cwd).resolve()
    if args.dream:
        print(await consolidate(MemoryStore(MEMORY_DB, scope=str(cwd)), OpenAICompatModel()))
        return 0
    session_file = cwd / ".agent" / "sessions" / f"{time.strftime('%Y%m%d-%H%M%S')}.jsonl"
    headless = args.prompt is not None
    rules = load_rules(cwd) + [Rule("run_command", p, "allow") for p in args.allow]
    agent = build_coding_agent(
        OpenAICompatModel(), cwd, rules=rules, headless=headless,
        asker=None if headless else ask_in_terminal,
        session_file=session_file, on_event=render, max_turns=args.max_turns,
        memory_db=MEMORY_DB, hooks=True)
    mcp_file = cwd / ".agent" / "mcp.json"
    mcp_sessions = []
    if mcp_file.is_file():
        mcp_sessions, warnings = await mount_all(json.loads(mcp_file.read_text(encoding="utf-8")), agent.registry)
        for w in warnings:
            print(f"{YELLOW}{w}{RESET}")
    try:
        return await interact(agent, args, headless, cwd, session_file)
    finally:
        for s in mcp_sessions:
            await s.close()


async def interact(agent, args, headless, cwd, session_file) -> int:
    if headless:
        outcome = await agent.run(args.prompt)
        print(f"\n{DIM}[{outcome.stopped} · {outcome.turns} 轮 · 输入 {outcome.usage.input} 输出 {outcome.usage.output}]{RESET}")
        return 0 if outcome.stopped == "finished" else 1
    commands = discover_commands(cwd / ".agent" / "commands")
    print(f"{BOLD}通用 Agent · 编程模式{RESET}  项目目录 {cwd}\n输入任务开始，Ctrl+C 中断当前任务，输入 exit 退出，/help 看命令。")

    async def confirm(plan: str) -> str | None:
        answer = (await asyncio.to_thread(input, f"\n{YELLOW}按这个计划执行？{RESET}[回车] 执行  [n] 放弃  或直接写补充要求 > ")).strip()
        return None if answer.lower() == "n" else answer
    while True:
        try:
            task = (await asyncio.to_thread(input, f"\n{BOLD}>{RESET} ")).strip()
        except (EOFError, KeyboardInterrupt):
            break
        if task in ("exit", "quit"):
            break
        if not task:
            continue
        slash = parse(task)
        if slash and slash[0] == "help":
            for name, desc in {**BUILTIN, **{c.name: c.description for c in commands.values()}}.items():
                print(f"  /{name:<10} {desc}")
            continue
        if slash and slash[0] == "dream":
            print(await consolidate(MemoryStore(MEMORY_DB, scope=str(cwd)), agent.model))
            continue
        if slash and slash[0] == "plan" and slash[1]:
            run = asyncio.create_task(plan_then_run(agent, slash[1], confirm))
        elif slash and slash[0] in commands:
            run = asyncio.create_task(agent.run(commands[slash[0]].expand(slash[1])))
        elif slash:
            print(f"{YELLOW}没有 /{slash[0]} 这个命令，/help 看有哪些。{RESET}")
            continue
        else:
            run = asyncio.create_task(agent.run(task))
        try:
            await run
        except (KeyboardInterrupt, asyncio.CancelledError):
            agent.interrupt()
            print(f"\n{YELLOW}已中断。会话记录在 {session_file}{RESET}")
        print()
    return 0


def main() -> None:
    p = argparse.ArgumentParser(description="从零手写的通用 Agent：编程模式")
    p.add_argument("-p", "--prompt", help="无界面模式：执行这条任务后退出")
    p.add_argument("-C", "--cwd", default=".", help="项目目录")
    p.add_argument("--allow", action="append", default=[], metavar="PATTERN",
                   help="放行匹配的命令，如 --allow 'pytest *'，可重复")
    p.add_argument("--max-turns", type=int, default=40)
    p.add_argument("--dream", action="store_true", help="整理长期记忆（合并重复、清掉过时、改好标题）后退出")
    sys.exit(asyncio.run(main_async(p.parse_args())))


if __name__ == "__main__":
    main()
