"""命令行入口。

    python -m evo.cli audit                       # 审计评分器（不调模型）
    python -m evo.cli eval --split accept -n 3    # 评测当前版本
    python -m evo.cli evolve --level prompt       # 跑一轮进化：prompt | playbook | config | code
    python -m evo.cli versions                    # 版本历史
    python -m evo.cli report 版本号 --base 版本号  # 两个版本的对比报告
    python -m evo.cli rollback 版本号             # 回退到某个版本

模型用环境变量配置，和第一个项目相同：OPENAI_BASE_URL、OPENAI_API_KEY、LLM_MODEL。
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from . import report
from .audit import audit
from .graders import AllOf, CommandGrader, JudgeGrader
from .seeds import SEEDS, seed
from .store import Store
from .tasks import by_split, load_tasks
from .types import SPLITS, AgentVersion

LEVELS = ("prompt", "playbook", "config", "code")


def models():
    from agent.model import OpenAICompatModel       # 第一个项目的包
    from .adapters import ChatTextModel, GeneralAgentAdapter
    return GeneralAgentAdapter(OpenAICompatModel()), ChatTextModel(OpenAICompatModel())


def current(store: Store, kind: str) -> AgentVersion:
    head = store.head()
    if head is None:
        head = seed(kind)
        store.save_version(head, "merged", "起点版本")
        print(f"还没有版本，已建立起点 {head.id}（{head.note}）")
    return head


def pick(store: Store, version_id: str) -> AgentVersion:
    v = store.get_version(version_id)
    if v is None:
        sys.exit(f"没有版本 {version_id}。用 versions 查看已有版本。")
    return v


def show(kind: str, data: dict) -> None:
    if kind == "eval_start":
        print(f"\n▶ {data['label']}（版本 {data['version']}，{len(data['tasks'])} 条任务）")
    elif kind == "eval_end":
        for r in data["records"]:
            print(f"   {'✓' if r.passed else '✗'} {r.task_id}#{r.attempt}  {r.turns} 轮  {r.stopped}")
    elif kind == "diagnosis":
        for name, ids in data["groups"]:
            print(f"   弱点 {name}：{', '.join(ids)}")
    elif kind == "proposal":
        detail = {k: v for k, v in data.items() if k not in ("level", "changed")}
        print(f"\n✎ 提案（第 {data['level']} 级）{'' if data['changed'] else '：这一轮不修改'}  {detail}")
    elif kind == "gate":
        print(f"\n{'✅ 合入' if data['admitted'] else '⛔ 拒绝'} {data['candidate']}：{data['reason']}")
    elif kind == "note":
        print(f"   {data['text']}")


async def run(args: argparse.Namespace) -> int:
    tasks = load_tasks(Path(args.tasks))
    store = Store(Path(args.store))
    try:
        if args.cmd == "audit":
            result = await audit(CommandGrader(), tasks)
            print(result.summary())
            return 1 if result.defects else 0

        if args.cmd == "versions":
            for v in store.versions():
                print(f"{v['id']}  {v['status']:<9}  父 {v['parent'] or '-':<10}  {v['note']}"
                      + (f"  ｜{v['reason']}" if v["reason"] else ""))
            return 0

        if args.cmd == "rollback":
            target = pick(store, args.version)
            try:
                store.promote(target.id, "手动回退")
            except ValueError as e:
                print(e)
                return 1
            print(f"当前版本已回到 {target.id}")
            return 0

        if args.cmd == "report":
            records = store.runs(args.version, args.split)
            if not records:
                sys.exit(f"版本 {args.version} 在 {args.split} 集上还没有评测结果。")
            base = store.runs(args.base, args.split) if args.base else None
            print(report.render(f"版本 {args.version}（{args.split} 集）", records, base))
            return 0

        agent, text_model = models()
        grader = AllOf(CommandGrader(), JudgeGrader(text_model)) if args.judge else CommandGrader()

        if args.cmd == "eval":
            from .runner import evaluate
            version = pick(store, args.version) if args.version else current(store, args.seed)
            subset = by_split(tasks, args.split) if args.split != "all" else tasks
            records = await evaluate(
                agent, grader, version, subset, attempts=args.attempts, concurrency=args.concurrency, store=store,
                on_record=lambda r: print(f"{'✓' if r.passed else '✗'} {r.task_id}#{r.attempt}  {r.reason[:70]}"))
            print("\n" + report.render(f"版本 {version.id}（{args.split} 集）", records))
            return 0

        if args.cmd == "evolve":
            from .evolve.code import evolve_code
            from .evolve.config import evolve_config
            from .evolve.gate import Bench
            from .evolve.playbook import evolve_playbook
            from .evolve.prompt import evolve_prompt
            step = {"prompt": evolve_prompt, "playbook": evolve_playbook, "config": evolve_config,
                    "code": evolve_code}[args.level]
            bench = Bench(agent, grader, tasks, store, attempts=args.attempts, concurrency=args.concurrency,
                          notify=show, min_gain=args.min_gain)
            before = current(store, args.seed)
            after, decision = await step(bench, text_model, before)
            if decision is None:
                print("\n这一轮没有产生需要过闸门的候选。")
            print(f"\n当前版本：{after.id}" + ("（未变）" if after.id == before.id else f"（上一个 {before.id}）"))
            return 0
        return 2
    finally:
        store.close()


def main() -> None:
    p = argparse.ArgumentParser(prog="evo", description="Agent 评测与自进化平台")
    p.add_argument("--tasks", default="tasks", help="任务集目录")
    p.add_argument("--store", default="runs", help="结果库目录")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("audit", help="审计评分器")
    sub.add_parser("versions", help="版本历史")

    def common(sp):
        sp.add_argument("-n", "--attempts", type=int, default=3, help="每条任务运行几次")
        sp.add_argument("--concurrency", type=int, default=4)
        sp.add_argument("--judge", action="store_true", help="加上模型裁判（只对写了细则的任务生效）")
        sp.add_argument("--seed", choices=SEEDS, default="standard", help="没有版本时用哪个起点")

    e = sub.add_parser("eval", help="评测一个版本")
    e.add_argument("--split", choices=(*SPLITS, "all"), default="accept")
    e.add_argument("--version", help="不填则评测当前版本")
    common(e)
    v = sub.add_parser("evolve", help="跑一轮进化")
    v.add_argument("--level", choices=LEVELS, required=True)
    v.add_argument("--min-gain", type=float, default=0.0,
                   help="验收集至少要涨多少才算数（0.1 即 10 个百分点），用来挡掉重复运行之间的随机波动")
    common(v)
    r = sub.add_parser("report", help="可靠性报告；带 --base 时做两个版本的对比")
    r.add_argument("version")
    r.add_argument("--base")
    r.add_argument("--split", choices=SPLITS, default="accept")
    b = sub.add_parser("rollback", help="把某个旧版本重新设为当前版本")
    b.add_argument("version")
    sys.exit(asyncio.run(run(p.parse_args())))


if __name__ == "__main__":
    main()
