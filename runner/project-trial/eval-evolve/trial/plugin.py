"""网站「在线试用」的服务端：现场跑一轮进化，把过程推给浏览器。

它不是一个独立的服务，而是挂在第一个项目的试用入口（general-agent/trial/brain_server.py）上的场景：
入口负责验票据和推事件流，这里只管“跑什么”。被测 Agent 的命令和评分器的检查命令都发到隔离沙箱里执行，
这个进程自己不执行任何由模型决定的代码。

试用从一个有毛病的起点版本开始（见 evo/seeds.py），所以基线会失败，能看到完整的一轮：
基线评测 → 分析失败 → 提出修改 → 候选评测 → 准入闸门。
试用只开放第一级（提示词）和第三级（配置）：这两级的候选只是文本和有边界的配置值，不涉及加载新代码。
第三个场景用提示词有毛病的起点去跑配置进化，演示“不该改的时候不改、没用的修改不合入”。

另有一个连续跑多代的入口 run_generations：从一个能过一半的起点出发，四级轮着改五代。它一次要跑上百次任务，
不登记成试用场景，只用来录网站上那份「升级记录」。
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import tempfile
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from evo.adapters import ChatTextModel, GeneralAgentAdapter  # noqa: E402
from evo.evolve import code as code_level, config as config_level, diagnose, playbook as playbook_level  # noqa: E402
from evo.evolve import prompt as prompt_level  # noqa: E402
from evo.evolve.loop import evolve_generations  # noqa: E402
from evo.evolve.gate import Bench  # noqa: E402
from evo.graders import CommandGrader  # noqa: E402
from evo.harness import effective_config  # noqa: E402
from evo.seeds import seed  # noqa: E402
from evo.store import Store  # noqa: E402
from evo.tasks import load_tasks  # noqa: E402
from evo.types import AgentVersion  # noqa: E402

MAX_SECONDS = int(os.environ.get("TRIAL_EVO_MAX_SECONDS", "240"))
RUN_TIMEOUT = 80          # 单次任务运行的时间上限
TRIAL_MAX_TURNS = 16      # 试用里每次任务运行的轮次上限，控制时长和用量
GEN_MAX_SECONDS = int(os.environ.get("TRIAL_EVO_GEN_MAX_SECONDS", "1500"))   # 连续多代的总时长上限
LEVEL_NAMES = {"prompt": "系统提示词", "playbook": "经验手册", "config": "外壳配置", "code": "外壳代码"}

SCENARIOS = {
    "evolve-prompt": {
        "title": "第一级：让它自己改提示词",
        "default_task": "起点版本的提示词里有一条不合适的规定，跑一轮提示词进化。",
        "seed": "stale-rule", "level": "prompt",
        "intro": "起点版本的提示词里混进了一条从别的流程抄来的规定。先看它在进化集上表现如何。",
    },
    "evolve-config": {
        "title": "第三级：让它自己调配置",
        "default_task": "起点版本的配置有问题，跑一轮配置进化。",
        "seed": "no-write", "level": "config",
        "intro": "起点版本的外壳配置有问题。先看它在进化集上表现如何。",
    },
    "evolve-mismatch": {
        "title": "第三级：毛病不在配置上，看它会不会硬改",
        "default_task": "起点版本的毛病在提示词里，却让它跑一轮配置进化。",
        "seed": "stale-rule", "level": "config",
        "intro": "这次故意用错了级别：起点版本的毛病在提示词里，却只允许它改配置。"
                 "一条进化链路除了会改，还得知道什么时候不该改。先看它在进化集上表现如何。",
    },
}

ASK_LABELS = {prompt_level.SYSTEM: "反思：这些失败有没有共同原因，提示词该怎么改",
              diagnose.SYSTEM: "分析一次失败出在哪个环节",
              config_level.SYSTEM: "针对最主要的弱点提出配置修改",
              playbook_level.SYSTEM: "复盘：这几次任务里有什么经验值得记进手册",
              code_level.SYSTEM: "反思：失败是不是因为工具结果里的关键信息不够显眼"}


class Narrator:
    """把进化过程里的内部事件翻译成试用页面认识的事件（text / tool_start / tool_end）。"""

    def __init__(self, emit):
        self.emit, self.n, self.open = emit, 0, {}
        self.runs, self.input_tokens, self.output_tokens = 0, 0, 0
        self.found: dict[int, str] = {}      # 第几代 → 这一代发现了什么（提案器自己的话）
        self.gen = 0

    def say(self, text: str) -> None:
        self.emit({"type": "text", "text": text.strip() + "\n\n"})

    def start(self, name: str, what: str) -> str:
        self.n += 1
        self.emit({"type": "tool_start", "id": f"s{self.n}", "name": name, "arguments": {"query": what}})
        return f"s{self.n}"

    def end(self, step: str, name: str, result: str) -> None:
        self.emit({"type": "tool_end", "id": step, "name": name, "denied": False, "result": result[:3000]})

    def notify(self, kind: str, d: dict) -> None:
        if kind == "eval_start":
            self.say(f"▶ {d['label']}：{len(d['tasks'])} 条任务")
        elif kind == "run_start":
            self.open[(d["version"], d["task"], d["attempt"])] = self.start("run_task", f"{d['label']} · {d['task']}")
        elif kind == "run_end":
            r = d["record"]
            self.runs += 1
            self.input_tokens += r.input_tokens
            self.output_tokens += r.output_tokens
            step = self.open.pop((r.version_id, r.task_id, r.attempt), None)
            if step:
                self.end(step, "run_task", f"{'通过' if r.passed else '未通过'}（{r.turns} 轮，{r.seconds:.0f} 秒，"
                                           f"停止原因 {r.stopped}）\n评分理由：{r.reason}\n\n"
                                           f"Agent 的最终回复：{r.final_reply[:600] or '（空）'}")
        elif kind == "eval_end":
            records = d["records"]
            marks = "  ".join(f"{'✓' if r.passed else '✗'} {r.task_id}" for r in records)
            self.say(f"{d['label']}：通过 {sum(r.passed for r in records)}/{len(records)}　{marks}")
        elif kind == "diagnosis":
            lines = [f"· {name}（{len(ids)} 条任务）" for name, ids in d["groups"]]
            self.say("失败归因后聚成的弱点：\n" + "\n".join(lines))
        elif kind == "proposal":
            if d["level"] == 1:
                self.found[self.gen] = d["diagnosis"]
                self.say(f"第 {d['round']} 轮反思的诊断：{d['diagnosis'] or '（没有给出）'}\n"
                         + ("据此改写了提示词，先在小批量上和原来的比一比。" if d["changed"] else "这一轮没有给出可用的改写。"))
            elif d["level"] == 2:
                self.found[self.gen] = f"从这几次任务里提炼经验：新增 {d['added']} 条，改写 {d['updated']} 条，淘汰 {d['removed']} 条"
                self.say(self.found[self.gen] + ("。" if d["changed"] else "。手册内容没有变化，这一轮不修改。"))
            elif d["level"] == 3:
                self.found[self.gen] = f"{d['weakness']}。{d['rationale']}" if d["changed"] else f"{d['weakness']}。判断不是改配置能解决的"
                self.say((f"提出的配置修改：{json.dumps(d['changes'], ensure_ascii=False)}\n理由：{d['rationale']}\n"
                          f"风险：{d['risk'] or '（未说明）'}\n先只在这类弱点涉及的任务上验证。")
                         if d["changed"] else "判断这类弱点不是改配置能解决的，这一轮不修改。")
            else:
                self.found[self.gen] = d["rationale"]
                self.say(f"对外壳代码的判断：{d['rationale'] or '（没有给出）'}\n"
                         + ("据此改写了工具结果的加工钩子，先过静态检查和试跑。" if d["changed"] else "这一轮不修改代码。"))
        elif kind == "gate":
            self.say(f"准入闸门：{'合入' if d['admitted'] else '拒绝'}。{d['reason']}")
        elif kind == "note":
            self.say(d["text"])
        elif kind == "generations_start":
            self.say(f"起点版本在验收集上的通过率：{d['score']:.0%}。接下来最多跑 {d['generations']} 代。")
        elif kind == "generation_start":
            self.gen = d["no"]
            self.say(f"━━ 第 {d['no']} 代 ━━　这一代改{LEVEL_NAMES[d['level']]}"
                     + (f"，最多改 {d['budget']} 行" if d["budget"] is not None else ""))
        elif kind == "generation_end":
            what = {"admitted": "合入", "rejected": "被拦下", "no_change": "没有提出修改"}[d["outcome"]]
            self.say(f"第 {d['no']} 代结束：{what}。当前版本在验收集上的通过率 {d['score']:.0%}")


class NarratedModel:
    """提案器和失败分析每问一次模型，页面上就多一步，展开能看到模型的原话。"""

    def __init__(self, inner: ChatTextModel, narrator: Narrator):
        self.inner, self.narrator = inner, narrator

    async def ask(self, system: str, user: str) -> str:
        step = self.narrator.start("ask_model", ASK_LABELS.get(system, "询问模型"))
        try:
            reply = await self.inner.ask(system, user)
        except Exception as e:
            self.narrator.end(step, "ask_model", f"模型调用失败：{type(e).__name__}: {e}")
            raise
        self.narrator.end(step, "ask_model", reply)
        return reply


def sandbox_check(executor):
    """评分器的检查命令也发到沙箱里执行：它跑的是被 Agent 改过的代码。"""
    from agent.tools.coding.workspace import Workspace

    async def check(workdir: Path, command: str, timeout: int):
        status, output = await executor.run(Workspace(workdir), command, timeout)
        m = re.match(r"退出码 (-?\d+)", status)
        if m:
            return int(m.group(1)), output
        return (None, output) if "未结束" in status else (-1, f"{status}：{output}")

    return check


def changes(before: AgentVersion, after: AgentVersion) -> list[dict]:
    out = []
    if before.system_prompt != after.system_prompt:
        out.append({"path": "系统提示词", "before": before.system_prompt, "after": after.system_prompt})
    if before.config != after.config:
        dump = lambda v: json.dumps(effective_config(v.config_dict), ensure_ascii=False, indent=2)  # noqa: E731
        out.append({"path": "外壳配置", "before": dump(before), "after": dump(after)})
    if before.playbook != after.playbook:
        out.append({"path": "经验手册", "before": playbook_level.render(list(before.playbook)),
                    "after": playbook_level.render(list(after.playbook))})
    if before.code != after.code:
        out.append({"path": "外壳代码", "before": before.code, "after": after.code})
    return out


def real_parts():
    """真模型和沙箱。测试里不走这里，传脚本化的替身。"""
    from agent.model import OpenAICompatModel
    from agent.sandbox import RemoteExecutor
    executor = RemoteExecutor(os.environ.get("SANDBOX_URL", ""), os.environ.get("SANDBOX_TOKEN", ""))
    return (GeneralAgentAdapter(OpenAICompatModel(), command_timeout=45, executor=executor),
            ChatTextModel(OpenAICompatModel()), sandbox_check(executor))


def totals(narrator: Narrator, model) -> dict:
    usage = getattr(model, "usage", None)
    return {"turns": narrator.runs, "input_tokens": narrator.input_tokens + (usage.input if usage else 0),
            "output_tokens": narrator.output_tokens + (usage.output if usage else 0)}


async def run_evolution(scenario: dict, emit, *, agent=None, model=None, check=None, tasks_dir: Path | None = None
                        ) -> dict:
    """跑一轮进化。agent / model / check 不传时用真模型和沙箱；测试里传脚本化的替身。"""
    if agent is None:
        agent, model, check = real_parts()
    narrator = Narrator(emit)
    tmp = Path(tempfile.mkdtemp(prefix="evo-trial-"))
    store = Store(tmp)
    try:
        v0 = seed(scenario["seed"])
        v0 = v0.derive(v0.note, config={**v0.config_dict, "loop.max_turns": TRIAL_MAX_TURNS})
        store.save_version(v0, "merged", "起点版本")
        # 单独的一轮只用文件短的那 14 条题：现场跑要在两三分钟内出结果。文件长的 6 条留给连续多代
        tasks = [t for t in load_tasks(tasks_dir or ROOT / "tasks") if t.difficulty != "long_file"]
        bench = Bench(agent, CommandGrader(timeout=60, **({"check": check} if check else {})),
                      tasks, store, attempts=1, concurrency=6,
                      notify=narrator.notify, run_timeout=RUN_TIMEOUT)
        narrator.say(scenario["intro"])
        narrated = NarratedModel(model, narrator)
        step = (prompt_level.evolve_prompt(bench, narrated, v0, rounds=2) if scenario["level"] == "prompt"
                else config_level.evolve_config(bench, narrated, v0))
        try:
            version, decision = await asyncio.wait_for(step, timeout=MAX_SECONDS)
            stopped = "no_change" if decision is None else "admitted" if decision.admitted else "rejected"
        except asyncio.TimeoutError:
            version, stopped = v0, "timeout"
        return {"stopped": stopped, **totals(narrator, model), "changed_files": changes(v0, version)}
    finally:
        store.close()
        shutil.rmtree(tmp, ignore_errors=True)


async def run_generations(emit, *, generations: int = 5, seed_kind: str = "tight", agent=None, model=None, check=None,
                          tasks_dir: Path | None = None) -> dict:
    """从一个能过一半的起点连续跑几代。返回里的 generations 是每一代的结构化记录，网站的「升级记录」直接用它。"""
    if agent is None:
        agent, model, check = real_parts()
    narrator = Narrator(emit)
    tmp = Path(tempfile.mkdtemp(prefix="evo-trial-"))
    store = Store(tmp)
    try:
        v0 = seed(seed_kind)
        store.save_version(v0, "merged", "起点版本")
        bench = Bench(agent, CommandGrader(timeout=60, **({"check": check} if check else {})),
                      load_tasks(tasks_dir or ROOT / "tasks"), store, attempts=1, concurrency=6,
                      notify=narrator.notify, run_timeout=150)
        narrator.say("起点是刚上线时常见的样子：提示词是最简版，为了省用量把轮次上限压到了 6，工具结果只留 500 字。"
                     "接下来让它自己一代一代改：每一代改一处，考试通过才合入，下一代从合入的版本接着改。")
        stopped = "finished"
        try:
            await asyncio.wait_for(evolve_generations(bench, NarratedModel(model, narrator), v0, generations),
                                   timeout=GEN_MAX_SECONDS)
        except asyncio.TimeoutError:
            stopped = "timeout"
        history, start_score = [], None
        for g in store.generations():
            base, cand = store.get_version(g["base"]), store.get_version(g["candidate"]) if g["candidate"] else None
            history.append({**{k: g[k] for k in ("no", "level", "outcome", "rule", "reason", "score", "budget", "edit")},
                            "found": narrator.found.get(g["no"], ""),
                            "changes": changes(base, cand) if cand else []})
        scores = store.accept_scores()
        start_score = scores.get(v0.id)
        head = store.head() or v0
        return {"stopped": stopped, **totals(narrator, model), "start_score": start_score, "generations": history,
                "changed_files": changes(v0, head)}
    finally:
        store.close()
        shutil.rmtree(tmp, ignore_errors=True)


def register(scenarios: dict) -> None:
    """入口服务启动时调用：把这里的场景登记进去。"""
    for name, sc in SCENARIOS.items():
        scenarios[name] = {"title": sc["title"], "default_task": sc["default_task"], "fixed_task": True,
                           "max_turns": TRIAL_MAX_TURNS,
                           "run": lambda task, emit, sc=sc: run_evolution(sc, emit)}
