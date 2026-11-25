"""用真模型直接跑项目实战的试用场景（通用 Agent 和评测平台对着线上沙箱，电商项目不需要沙箱），把推给页面的事件打印出来。

不经过入口函数，不部署任何东西：用来在上线前看一轮进化实际跑出来是什么样、要多久、用多少量。
环境变量：OPENAI_API_KEY、OPENAI_BASE_URL、LLM_MODEL（同入口函数），SANDBOX_URL、SYNC_SECRET（派生沙箱令牌）。
用法：python scripts/probe-project-trial.py [场景名 ...]
"""
import asyncio
import base64
import gzip
import hashlib
import importlib.util
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "runner" / "project-trial"
sys.path.insert(0, str(ROOT / "general-agent"))
os.environ["SANDBOX_TOKEN"] = hashlib.sha256(f"project-trial-sandbox:{os.environ['SYNC_SECRET']}".encode()).hexdigest()



def load(project: str):
    spec = importlib.util.spec_from_file_location(f"{project}_trial_plugin", ROOT / project / "trial" / "plugin.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_brain():
    spec = importlib.util.spec_from_file_location("trial_brain", ROOT / "general-agent" / "trial" / "brain_server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


evo, growth, brain = load("eval-evolve"), load("ecom-growth"), load_brain()
PELICAN = ("做一个单文件网页 app/pelican.html：用内联 SVG 画一只鹈鹕沿海边骑自行车的侧视动画。"
           "车是标准菱形车架，两个轮子带辐条；鹈鹕坐实在车座上，身体白色偏圆，长脖子，橙黄色长喙加下垂的喉囊，翅膀向前扶着车把。"
           "两条腿各分大腿、小腿两段，用 JS 每帧按踏板位置算出膝盖，脚始终踩在踏板上；曲柄、车轮和路面后退的速度要对得上。"
           "背景分天空、海面、沙丘、路面四层，远的慢近的快。再加身体轻微起伏、眨眼、围巾飘动。画面铺满窗口，配色柔和有渐变。"
           "下方放三个控件：白天、日落、夜晚切换，速度滑块，暂停按钮。动笔前先在注释里定好各部件的坐标，保证身体、车座、车把、踏板对得上。"
           "不用看仓库里别的文件，一次把整个文件写完整，控制在 500 行以内；写完最多检查修正一次就结束。")
# 通用 Agent 的样例任务，和网站在线试用页上的样例一一对应
STORE_TASKS = {
    "store-fix-tests": "跑一下测试，有几条用例挂了。找到原因并修好，不要修改测试。",
    "store-oversell": "有用户反馈同一件商品被卖超了。检查 store/inventory.py 的预占逻辑，有问题就修掉，并补一条能复现这个问题的测试。",
    "store-shipping": "给订单加上运费：实付金额满 99 元免运费，否则收 8 元。在 Order 上加 shipping_cents 字段，并补上测试。仓库里原本就挂着的几条用例和这件事无关，先不用管。",
    "store-explain": "下一张订单会依次经过哪些函数？按调用顺序讲一遍，指出每一步在哪个文件。不要改代码。",
    "store-pelican": PELICAN,
    # 同一句话多跑几遍，挑画得最好的一遍做成回放
    "store-pelican-b": PELICAN,
    "store-pelican-c": PELICAN,
    "store-shooter": "做一个打飞机的小游戏，放在 app/shooter.html：用 canvas 画，自己的飞机在下方，能用方向键或鼠标、手指移动，自动开火；敌机从上方一波波飞下来，打中有爆炸效果并加分，被撞到掉一条命，三条命用完显示得分和重新开始按钮。难度随时间慢慢提高。",
    "store-pomodoro": "做一个番茄钟小应用，放在 app/pomodoro.html：25 分钟专注、5 分钟休息，能开始、暂停、重置，有环形进度，下面能记今天要做的几件事并勾选完成。界面做得精致一些。",
    "store-ledger": "做一个记账小应用，放在 app/ledger.html：能记一笔收入或支出（金额、分类、备注），列表按时间倒序，顶部显示本月收入、支出和结余，再用一个环形图显示各分类的支出占比。先放几条示例数据。界面做得精致一些。",
    "store-kanban": "做一个任务看板小应用，放在 app/kanban.html：待办、进行中、已完成三列，能新增卡片、在三列之间拖动、删除，每列顶部显示数量。先放几条示例卡片。界面做得精致一些。",
}
# 场景名 → （怎么跑, 跑成什么样算正常）
# evolve-mismatch 故意用错级别：正常结局是不改或被拦下，合入了反而不对
RUNNERS = {**{name: (lambda emit, sc=sc: evo.run_evolution(sc, emit),
                     ("no_change", "rejected") if name == "evolve-mismatch" else "admitted")
              for name, sc in evo.SCENARIOS.items()},
           **{name: (lambda emit, sc=sc: growth.run_campaign(sc, emit), "finished") for name, sc in growth.SCENARIOS.items()},
           **{name: (lambda emit, task=task: brain.run_trial(brain.SCENARIOS["store"], task, emit), "finished")
              for name, task in STORE_TASKS.items()}}


async def main() -> int:
    bad = 0
    for name in sys.argv[1:] or list(RUNNERS):
        started = time.monotonic()
        print(f"\n{'=' * 20} {name} {'=' * 20}", flush=True)

        recorded: list = []

        def emit(ev: dict) -> None:
            recorded.append([int((time.monotonic() - started) * 1000), ev])
            at = f"[{time.monotonic() - started:6.1f}s]"
            if ev["type"] == "text":
                # 通用 Agent 的文字是一小段一小段推的，攒到工具调用或结束再打印
                if name in STORE_TASKS:
                    pending.append(ev["text"])
                else:
                    print(at, ev["text"].strip(), flush=True)
                return
            if pending:
                print(at, "".join(pending).strip(), flush=True)
                pending.clear()
            if ev["type"] == "tool_start":
                args = ev["arguments"]
                print(at, "→", ev["name"], args.get("query") or args.get("command") or args.get("path")
                      or args.get("pattern") or "", flush=True)
            elif ev["type"] == "tool_end":
                body = ev["result"].strip().replace("\n", "\n            ")
                print(at, "←", ev["id"], "（被拒绝）" if ev.get("denied") else "", body[:1500 if name in STORE_TASKS else 4000],
                      flush=True)

        pending: list = []
        runner, expected = RUNNERS[name]
        summary = await runner(emit)
        if pending:
            print("".join(pending).strip(), flush=True)
        # 整段事件流压缩后打成一行，可以直接做成网站上的录制回放；开头那条和试用函数发给页面的一致
        scenario = brain.SCENARIOS.get(name, {})
        recorded.insert(0, [0, {"type": "start", "task": STORE_TASKS.get(name) or scenario.get("default_task", ""),
                                "max_turns": brain.MAX_TURNS if name in STORE_TASKS else scenario.get("max_turns", brain.MAX_TURNS)}])
        recorded.append([int((time.monotonic() - started) * 1000), {"type": "done", **summary}])
        blob = base64.b64encode(gzip.compress(json.dumps(recorded, ensure_ascii=False).encode())).decode()
        print(f"RECORDING {name} {blob}", flush=True)
        summary.pop("workspace", None)
        for change in summary.pop("changed_files"):
            print(f"\n--- {change['path']}（改之前）\n{change['before']}\n+++ {change['path']}（改之后）\n{change['after']}")
        print(f"\n结果 {summary}  全程 {time.monotonic() - started:.0f}s", flush=True)
        bad += summary["stopped"] not in ((expected,) if isinstance(expected, str) else expected)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
