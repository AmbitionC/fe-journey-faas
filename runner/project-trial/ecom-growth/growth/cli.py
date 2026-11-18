"""命令行入口。

  python -m growth.cli run --offline --yes              不接模型，把整条闭环跑一遍
  python -m growth.cli run --yes --db runs/a.db         接真模型（读 OPENAI_BASE_URL / OPENAI_API_KEY / LLM_MODEL）
  python -m growth.cli report | lineage | costs --db runs/a.db
  python -m growth.cli review-eval [--offline]          在审核评测集上算漏放率和误拦率
  python -m growth.cli sim-check [--offline]            四项环境检验
  python -m growth.cli alloc-bench                      对比三种预算分配方式
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

from .lead import ROOT, AutoApprover, Campaign, Config
from .llm import ChatModel, Ledger, Models
from .offline import OfflineModel
from .report import costs, lineage
from .store import Store
from .types import Product


class ConsoleApprover(AutoApprover):
    """在终端里逐项确认。"""
    name = "console"

    def confirm_points(self, product, pending):
        ok = []
        for p in pending:
            if input(f"卖点 #{p.id}「{p.text}」（依据：{p.evidence}）有资质或检测报告支持吗？[y/N] ").strip().lower() == "y":
                ok.append(p.id)
        return ok

    def confirm_trial(self, round, summary):
        return input(f"{summary}\n确认开始试投？[Y/n] ").strip().lower() != "n"

    def decide_borderline(self, c, result):
        doubts = "；".join(f"{x['check']}：{x['quote']}" for x in result["checks"] if x["verdict"] == "拿不准")
        ok = input(f"素材 #{c.id}「{c.body}」裁判拿不准（{doubts}）。放行？[y/N] ").strip().lower() == "y"
        return ok, "" if ok else "人工否决"

    def confirm_drop(self, segment_name, reason):
        return input(f"放弃人群「{segment_name}」（{reason}）？[y/N] ").strip().lower() == "y"


def build_models(args, store: Store | None = None) -> Models:
    ledger = Ledger(max_calls=getattr(args, "max_calls", None), sink=store.log_call if store else None)
    if args.offline:
        return Models(OfflineModel(), ledger=ledger, rpm=60000, max_concurrency=64)
    tiers = {}
    for tier, env in (("strong", "LLM_MODEL_STRONG"), ("writer", "LLM_MODEL_WRITER"), ("cheap", "LLM_MODEL_CHEAP")):
        if os.environ.get(env):
            tiers[tier] = ChatModel(model=os.environ[env])
    if os.environ.get("SIM_MODEL"):      # 扮演用户的模型最好和写素材的不是同一家
        tiers["sim"] = ChatModel(model=os.environ["SIM_MODEL"], base_url=os.environ.get("SIM_BASE_URL"),
                                 api_key=os.environ.get("SIM_API_KEY"))
    return Models(ChatModel(), tiers, ledger=ledger, max_concurrency=args.concurrency, rpm=args.rpm)


def printer(kind: str, d: dict) -> None:
    if kind == "action":
        print(f"\n▶ {d['action']}　{d['reason']}", flush=True)
    elif kind == "result":
        print("  " + d["result"].replace("\n", "\n  "), flush=True)
    elif kind == "progress":
        print(f"  …第 {d['round']} 轮已完成 {d['done']} / {d['total']} 次曝光", flush=True)
    elif kind == "note":
        print(f"\n{d['text']}", flush=True)


def load_sim(path: str) -> dict:
    return json.loads(Path(path).read_text())


def cmd_run(args) -> None:
    store = Store(args.db)
    if store.product() is None:
        data = json.loads(Path(args.product).read_text())
        data.pop("note", None)
        store.save_product(Product(**data))
        config = Config(budget=args.budget, round_budget=args.round_budget, max_rounds=args.rounds,
                        per_segment=args.per_segment, objective=args.objective, sim=load_sim(args.sim))
    else:
        config = None        # 续跑：沿用这次活动保存下来的配置
        print(f"在 {args.db} 里找到一次未完成或已完成的活动，从断点继续。")
    models = build_models(args, store)
    campaign = Campaign(store, models, config, AutoApprover() if args.yes else ConsoleApprover(), printer)
    report = asyncio.run(campaign.run())
    print("\n" + "=" * 60 + "\n" + report)
    print("\n素材谱系\n" + lineage(store))
    print("\n按环节的模型调用\n" + costs(models.ledger.by_stage()))
    store.close()


def cmd_show(args) -> None:
    store = Store(args.db)
    if args.cmd == "report":
        print(store.get("final_report") or "活动还没有跑完。")
    elif args.cmd == "lineage":
        print(lineage(store))
    else:
        print(costs(store.costs()))


def cmd_review_eval(args) -> None:
    from .stages import review
    from .offline import POINTS
    from .types import SellingPoint
    points = [SellingPoint(i + 1, p["text"], p["category"], p["evidence"], p["source"], "verified") for i, p in enumerate(POINTS[:7])]
    samples = [json.loads(line) for line in (ROOT / "growth" / "evals" / "review_eval.jsonl").read_text().splitlines() if line.strip()]
    rules, version = review.load_rules(competitors=["安耐晒", "碧柔"])
    out = asyncio.run(review.evaluate(build_models(args).stage("review"), samples, rules, points))
    print(f"审核评测集 {out['n']} 条（规则库 {version}）")
    print(f"漏放率 {out['leak_rate']:.1%}（违规样本被判通过）　误拦率 {out['false_block_rate']:.1%}（合规样本被拦截）　"
          f"进人工的比例 {out['to_human_rate']:.1%}")
    for kind, row in out["by_kind"].items():
        print(f"  {kind:<10} 共 {row['n']:>2}　通过 {row['approved']:>2}　拦截 {row['rejected']:>2}　进人工 {row['escalate']:>2}")
    for body in out["leaked"]:
        print(f"  漏放：{body}")


def cmd_sim_check(args) -> None:
    from .sim.check import run_checks
    for row in asyncio.run(run_checks(build_models(args), load_sim(args.sim))):
        print(f"{'✓' if row['ok'] else '✗'} {row['name']}：{row['detail']}")
    print("\n四项都符合期望，只说明这个环境的行为合理且自洽，不说明它接近真实用户。")


def cmd_alloc_bench(args) -> None:
    from .stages.allocate import bench
    rates = [0.03, 0.04, 0.05, 0.06, 0.08, 0.05, 0.04, 0.07]
    print(f"8 个选项，真实点击率 {rates}，预算 {args.budget}，分 6 轮，各重复 {args.repeats} 次")
    for name, row in bench(rates, budget=args.budget, repeats=args.repeats).items():
        print(f"  {name:<6} 累计损失 {row['regret']:>6}　选对的比例 {row['correct']:.0%}")


def main(argv=None) -> None:
    parser = argparse.ArgumentParser(prog="growth", description="电商营销增长助手")
    sub = parser.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("--offline", action="store_true", help="不接模型，用离线替身")
        p.add_argument("--concurrency", type=int, default=8)
        p.add_argument("--rpm", type=int, default=600)
        p.add_argument("--sim", default=str(ROOT / "data" / "sim" / "sim-v1.json"))

    run = sub.add_parser("run", help="跑一次活动（可续跑）")
    common(run)
    run.add_argument("--product", default=str(ROOT / "data" / "products" / "sunscreen.json"))
    run.add_argument("--db", default="runs/campaign.db")
    run.add_argument("--yes", action="store_true", help="无人值守：按偏严的默认策略自动确认")
    run.add_argument("--budget", type=int, default=3200)
    run.add_argument("--round-budget", type=int, default=800)
    run.add_argument("--rounds", type=int, default=4)
    run.add_argument("--per-segment", type=int, default=4)
    run.add_argument("--objective", choices=["click", "order"], default="click")
    run.add_argument("--max-calls", type=int, default=None, help="运行预算：最多调用多少次模型")
    run.set_defaults(fn=cmd_run)
    for name in ("report", "lineage", "costs"):
        p = sub.add_parser(name)
        p.add_argument("--db", default="runs/campaign.db")
        p.set_defaults(fn=cmd_show)
    p = sub.add_parser("review-eval", help="审核评测")
    common(p)
    p.set_defaults(fn=cmd_review_eval)
    p = sub.add_parser("sim-check", help="环境检验")
    common(p)
    p.set_defaults(fn=cmd_sim_check)
    p = sub.add_parser("alloc-bench", help="分配策略对比")
    p.add_argument("--budget", type=int, default=3000)
    p.add_argument("--repeats", type=int, default=40)
    p.set_defaults(fn=cmd_alloc_bench)
    args = parser.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main(sys.argv[1:])
