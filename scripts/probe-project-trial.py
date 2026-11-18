"""用真模型、对着线上沙箱直接跑评测与自进化项目的试用场景，把推给页面的事件打印出来。

不经过入口函数，不部署任何东西：用来在上线前看一轮进化实际跑出来是什么样、要多久、用多少量。
环境变量：OPENAI_API_KEY、OPENAI_BASE_URL、LLM_MODEL（同入口函数），SANDBOX_URL、SYNC_SECRET（派生沙箱令牌）。
用法：python scripts/probe-project-trial.py [场景名 ...]
"""
import asyncio
import hashlib
import importlib.util
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "runner" / "project-trial"
sys.path.insert(0, str(ROOT / "general-agent"))
os.environ["SANDBOX_TOKEN"] = hashlib.sha256(f"project-trial-sandbox:{os.environ['SYNC_SECRET']}".encode()).hexdigest()

spec = importlib.util.spec_from_file_location("evo_trial_plugin", ROOT / "eval-evolve" / "trial" / "plugin.py")
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)


async def main() -> int:
    bad = 0
    for name in sys.argv[1:] or list(plugin.SCENARIOS):
        started = time.monotonic()
        print(f"\n{'=' * 20} {name} {'=' * 20}", flush=True)

        def emit(ev: dict) -> None:
            at = f"[{time.monotonic() - started:6.1f}s]"
            if ev["type"] == "text":
                print(at, ev["text"].strip(), flush=True)
            elif ev["type"] == "tool_start":
                print(at, "→", ev["name"], ev["arguments"].get("query", ""), flush=True)
            elif ev["type"] == "tool_end":
                body = ev["result"].strip().replace("\n", "\n            ")
                print(at, "←", ev["id"], body[:1500], flush=True)

        summary = await plugin.run_evolution(plugin.SCENARIOS[name], emit)
        for change in summary.pop("changed_files"):
            print(f"\n--- {change['path']}（改之前）\n{change['before']}\n+++ {change['path']}（改之后）\n{change['after']}")
        print(f"\n结果 {summary}  全程 {time.monotonic() - started:.0f}s", flush=True)
        bad += summary["stopped"] != "admitted"
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
