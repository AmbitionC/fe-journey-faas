"""网站「在线试用」的服务端：现场跑一次小规模的营销活动，把过程推给浏览器。

它不是独立的服务，而是挂在第一个项目的试用入口（general-agent/trial/brain_server.py）上的一个场景：
入口负责验票据和推事件流，这里只管“跑什么”。这个项目不执行任何由模型决定的代码，所以用不到沙箱。

试用把规模调小了（人群最多三类、每类三版、两轮、每轮 300 次曝光），几分钟内能看完整条闭环：
商品理解 → 人群分层 → 素材生成 → 审核 → 试投 → 归因 → 进化 → 再审 → 再投 → 验收。
需要人确认的四个节点在这里按偏严的默认策略自动处理，并在过程里注明。
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from growth.lead import ACTIONS, AutoApprover, Campaign, Config  # noqa: E402
from growth.llm import ChatModel, Ledger, Models  # noqa: E402
from growth.report import lineage  # noqa: E402
from growth.store import Store  # noqa: E402
from growth.types import Product  # noqa: E402

MAX_SECONDS = int(os.environ.get("TRIAL_GROWTH_MAX_SECONDS", "240"))
MAX_CALLS = int(os.environ.get("TRIAL_GROWTH_MAX_CALLS", "450"))      # 运行预算的硬闸
TRIAL_CONFIG = dict(budget=600, round_budget=300, max_rounds=2, per_segment=3, rewrites_per_segment=1, batches=2,
                    max_segments=3, checks=["功效越界", "医疗暗示", "无依据的数据"])
SIM_USERS = 300

SCENARIOS = {
    "campaign": {
        "title": "给一款防晒乳跑两轮投放优化",
        "default_task": "为示例商品「晴屿清透防晒乳 SPF50+」跑一次小规模的营销活动。",
        "intro": "示例商品是虚构的一款防晒乳，详情和 57 条评价都是教程编写的。下面由活动主管一步步调度；"
                 "试投用的是模拟用户，所有效果数字只用于比较素材之间的相对表现。",
    },
}

NOTES = {
    "understand_product": "需要证据的功效类卖点本该由人确认。试用里自动处理：只认商品资料里登记了依据的那几条。",
    "review_creatives": "裁判拿不准的素材本该进人工队列。试用里自动处理：拿不准的一律不放行，带着原因重写。",
    "run_trial": "开始试投是花钱的动作，本该等人确认。试用里自动确认。",
}


class Narrator:
    """把主管的每个动作翻译成试用页面认识的事件：一步一个 tool_start / tool_end。"""

    def __init__(self, emit):
        self.emit, self.n, self.open, self.steps = emit, 0, None, 0

    def say(self, text: str) -> None:
        self.emit({"type": "text", "text": text.strip() + "\n\n"})

    def notify(self, kind: str, d: dict) -> None:
        if kind == "action":
            self.n += 1
            self.steps += 1
            self.open = (f"s{self.n}", d["action"])
            label = ACTIONS[d["action"]] + (f"｜{d['reason']}" if d["reason"] and "下一步" not in d["reason"] else "")
            self.emit({"type": "tool_start", "id": self.open[0], "name": d["action"], "arguments": {"query": label}})
        elif kind == "result" and self.open:
            step, name = self.open
            self.open = None
            if name == "finish":
                self.emit({"type": "tool_end", "id": step, "name": name, "denied": False, "result": "报告见下方"})
                return
            self.emit({"type": "tool_end", "id": step, "name": name, "denied": False, "result": d["result"][:4000]})
            first = d["result"].split("\n")[0]
            self.say(first + (f"\n（{NOTES[name]}）" if name in NOTES and self.steps < 9 else ""))
        elif kind == "note":
            self.say(d["text"])


async def run_campaign(scenario: dict, emit, *, model=None, product_path: Path | None = None) -> dict:
    """跑一次小规模的活动。model 不传时用真模型；测试里传离线替身。"""
    narrator = Narrator(emit)
    tmp = Path(tempfile.mkdtemp(prefix="growth-trial-"))
    store = Store(tmp / "campaign.db")
    ledger = Ledger(max_calls=MAX_CALLS)
    models = Models(model or ChatModel(), ledger=ledger, max_concurrency=int(os.environ.get("TRIAL_GROWTH_CONCURRENCY", "12")),
                    rpm=int(os.environ.get("TRIAL_GROWTH_RPM", "1200")))
    try:
        data = json.loads((product_path or ROOT / "data" / "products" / "sunscreen.json").read_text())
        data.pop("note", None)
        store.save_product(Product(**data))
        sim = {**json.loads((ROOT / "data" / "sim" / "sim-v1.json").read_text()), "users": SIM_USERS}
        campaign = Campaign(store, models, Config(sim=sim, **TRIAL_CONFIG), AutoApprover(), narrator.notify)
        narrator.say(scenario["intro"])
        stopped = "finished"
        try:
            await asyncio.wait_for(campaign.run(), timeout=MAX_SECONDS)
        except asyncio.TimeoutError:
            stopped = "timeout"
        if narrator.open:      # 超时打断在某一步中间：把这一步收掉，页面上不留一个转圈的步骤
            narrator.emit({"type": "tool_end", "id": narrator.open[0], "name": narrator.open[1], "denied": False,
                           "result": "到达试用的时间上限，这一步没有跑完"})
        report = store.get("final_report", "")
        if campaign.state["stage"] != "done" and stopped == "finished":
            stopped = "budget"
        if report:
            narrator.say("```text\n" + report + "\n```")
            tree = lineage(store)
            if "└─" in tree:
                narrator.say("素材谱系：一版素材是怎样一步步改出来的\n\n```text\n" + tree + "\n```")
        costs = "　".join(f"{r['stage']} {r['calls']} 次" + (f"（缓存命中 {r['cache_hits']}）" if r.get("cache_hits") else "")
                         for r in ledger.by_stage())
        narrator.say(f"这次活动按环节的模型调用：{costs}")
        return {"stopped": stopped, "turns": len(ledger.calls),
                "input_tokens": sum(c.input_tokens for c in ledger.calls),
                "output_tokens": sum(c.output_tokens for c in ledger.calls), "changed_files": []}
    finally:
        store.close()
        shutil.rmtree(tmp, ignore_errors=True)


def register(scenarios: dict) -> None:
    """入口服务启动时调用：把这里的场景登记进去。"""
    for name, sc in SCENARIOS.items():
        scenarios[name] = {"title": sc["title"], "default_task": sc["default_task"], "fixed_task": True,
                           "max_turns": MAX_CALLS, "run": lambda task, emit, sc=sc: run_campaign(sc, emit)}
