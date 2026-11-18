"""研究模式入口。

    export TAVILY_API_KEY=…
    python -m agent.research.cli "对比 Milvus 和 pgvector 的索引类型和许可" --out runs/vector-db

同一个问题、同一个输出目录再次运行时，会从检查点继续，已经查过的子问题不重跑。
"""
from __future__ import annotations

import argparse
import asyncio
import os

from ..model import OpenAICompatModel
from ..tools.research.web import TavilySearch
from ..types import Event
from .supervisor import Budget, ResearchRun


def render(event: Event) -> None:
    d = event.data
    if event.kind == "text_delta":
        print(d["text"], end="", flush=True)
    elif event.kind == "tool_start" and d["name"] == "researcher":
        print(f"\n\033[2m▸ 研究员出发：{d['arguments']['question'][:80]}\033[0m", flush=True)
    elif event.kind == "tool_end" and d["name"] == "researcher":
        print(f"\033[2m  研究员交回 {len(d['result'])} 字\033[0m", flush=True)


def main() -> None:
    p = argparse.ArgumentParser(description="从零手写的通用 Agent：研究模式")
    p.add_argument("question")
    p.add_argument("--out", default="research-run")
    p.add_argument("--rounds", type=int, default=3)
    p.add_argument("--parallel", type=int, default=3)
    p.add_argument("--searches", type=int, default=8)
    args = p.parse_args()
    model = OpenAICompatModel()
    cheap = OpenAICompatModel(model=os.environ.get("LLM_CHEAP_MODEL")) if os.environ.get("LLM_CHEAP_MODEL") else model
    run = ResearchRun(model, TavilySearch(), args.out, cheap_model=cheap, on_event=render,
                      budget=Budget(args.rounds, args.parallel, args.searches))
    state = asyncio.run(run.run(args.question))
    print(f"\n\n报告已写入 {args.out}/report.md（{state.rounds} 轮，{len(run.store.all())} 个来源）")
    for problem in state.problems:
        print(f"\033[33m未通过引用校验：{problem}\033[0m")


if __name__ == "__main__":
    main()
