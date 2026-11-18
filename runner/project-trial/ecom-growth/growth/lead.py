"""活动主管：拆解任务、决定每一轮做什么、判断何时停。它不自己写文案，也不自己看数据。

折中的做法：主干顺序和决策规则写在主管的提示词里，由模型决定“接下来做什么”；
关键的闸口由代码强制，决定“什么绝对不能做”：
- 每一步只能从 allowed_actions() 给出的动作里选，选了别的按第一个处理；
- 没有通过审核的素材进不了试投；
- 开始试投、放弃人群要先得到人的确认；
- 投放预算和最大轮数到了就只能收尾；运行预算（模型调用）超了立即停下并保留状态。
主管看到的永远是编号和几行摘要，素材全文留在数据层。
"""
from __future__ import annotations

import asyncio
import random
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .llm import BudgetExceeded, Models, extract_json
from .sim.trial import SimEnv, pick_users, to_impressions
from .sim.users import behavior_features, build_pool
from .stages import allocate, attribute, creative, evolve, product as product_stage, review, segment as segment_stage
from .stats import lift_interval
from .store import Store
from .types import Creative, Product, SellingPoint

ROOT = Path(__file__).resolve().parent.parent

LEAD_SYSTEM = """你是一次营销活动的主管。你不写文案、不看原始数据，只决定下一步做什么。

主干顺序：商品理解 → 人群分层 → 素材生成 → 审核 → 试投 → 归因 → （素材进化 → 审核 → 试投 → 归因）…… → 收尾。

每轮归因之后按下面的规则决定：
- 各人群的第一名连续两轮稳定，且是最优的概率超过阈值：收尾，输出报告。
- 预算用完或达到最大轮数：收尾，报告里说明哪些人群尚未收敛。
- 某类人群所有素材持续无效：提议放弃这类人群（需要人确认）。
- 审核拦截比例连续上升：暂停，等待人工查看。
- 其他：继续下一轮（素材进化）。

你只能从“可选动作”里选一个。输出 JSON：{"action": "动作名", "reason": "一句话理由"}。只输出 JSON。"""

ACTIONS = {
    "understand_product": "提取商品卖点，返回卖点清单的摘要",
    "segment_audience": "基于卖点和评价划分人群，并构造模拟用户池",
    "generate_creatives": "为每类人群生成一批素材草稿",
    "review_creatives": "审核所有草稿，未通过的带着原因重写，最多两次",
    "run_trial": "分配曝光并执行一轮试投（需要人工确认）",
    "attribute": "对截至本轮的投放日志做归因",
    "evolve_creatives": "淘汰差的素材，改写好的素材，为未回应的顾虑补写",
    "drop_segment": "放弃一类持续无效的人群（需要人工确认）",
    "finish": "在留出用户上验收并输出最终报告",
}


@dataclass
class Config:
    budget: int = 3200                # 投放预算：整个活动的曝光总量
    round_budget: int = 800
    max_rounds: int = 4
    per_segment: int = 4              # 首轮每类人群生成几版
    max_segments: int = 5             # 最多保留几类人群
    rewrites_per_segment: int = 2     # 每轮每类人群改写几版
    objective: str = "click"          # click | order
    batches: int = 4                  # 一轮分几批放量：先打一小批，明显落后的不再继续分配
    floor_share: float = 0.03         # 每个选项每批的最低曝光占比
    stop_prob: float = 0.9
    format: str = "short_copy"
    brand_tone: str = "真诚、克制，不喊口号"
    checks: list[str] = field(default_factory=lambda: list(review.CHECKS))
    rules: str = "cosmetics"
    sim: dict = field(default_factory=dict)
    behavior: str = str(ROOT / "data" / "behavior_sample.csv")


class AutoApprover:
    """没有人在场时的确认策略，偏严：需要证据的卖点只认商品资料里登记了依据的；裁判拿不准的一律不放行。"""
    name = "auto"

    def confirm_points(self, product: Product, pending: list[SellingPoint]) -> list[int]:
        return [p.id for p in pending if any(proof in p.text or p.text in proof or proof in p.evidence for proof in product.proofs)]

    def confirm_trial(self, round: int, summary: str) -> bool:
        return True

    def decide_borderline(self, c: Creative, result: dict) -> tuple[bool, str]:
        return False, "无人值守时拿不准的一律不放行"

    def confirm_drop(self, segment_name: str, reason: str) -> bool:
        return False


class Campaign:
    def __init__(self, store: Store, models: Models, config: Config | None = None, approver=None, notify=None, env=None):
        self.store, self.models = store, models
        saved = store.get("config")
        self.config = config or (Config(**saved) if saved else Config())
        store.set("config", asdict(self.config))
        self.approver = approver or AutoApprover()
        self.notify = notify or (lambda kind, data: None)
        self.state = store.get("state") or {"stage": "new", "round": 0, "leaders": {}, "block_rates": {}, "stop": ""}
        self.sim = self.config.sim
        self.env = env or SimEnv(models.stage("sim"), self.sim, cache=store, ledger=models.ledger)
        self._users = None
        self.rules, self.rules_version = None, ""

    # ------------------------------------------------------------------ 状态
    def save(self) -> None:
        self.store.set("state", self.state)

    @property
    def users(self):
        if self._users is None:      # 用户池由人群定义和配置确定性地生成，续跑时重建出来的是同一批人
            self._users = build_pool(self.store.segments(active_only=False), self.store.points(),
                                     behavior_features(self.config.behavior), self.sim)
        return self._users

    def arms(self) -> list[Creative]:
        active = {s.id for s in self.store.segments()}
        return [c for c in self.store.creatives(status="approved") if c.segment_id in active]

    def reward(self, i) -> bool:
        return i.ordered if self.config.objective == "order" else i.clicked

    def allocator(self) -> allocate.ThompsonAllocator:
        arms = self.arms()
        alloc = allocate.ThompsonAllocator([allocate.Arm(c.id, c.segment_id) for c in arms],
                                           allocate.PRIORS[self.config.objective], self.store.priors())
        tally: dict[int, list[int]] = {}
        for i in self.store.impressions():
            t = tally.setdefault(i.creative_id, [0, 0])
            t[0] += self.reward(i)
            t[1] += 1
        for c in arms:
            if c.id in tally:
                alloc.update(c.id, *tally[c.id])
        return alloc

    def remaining(self) -> int:
        return self.config.budget - self.store.used_budget()

    # ------------------------------------------------------------------ 闸口
    def converged(self) -> bool:
        rounds = sorted(int(r) for r in self.state["leaders"])
        if len(rounds) < 2:
            return False
        last, prev = self.state["leaders"][str(rounds[-1])], self.state["leaders"][str(rounds[-2])]
        active = [str(s.id) for s in self.store.segments()]
        return bool(active) and all(
            s in last and s in prev and last[s][0] == prev[s][0] and min(last[s][1], prev[s][1]) > self.config.stop_prob
            for s in active)

    def blocks_rising(self) -> bool:
        rates = [self.state["block_rates"][k] for k in sorted(self.state["block_rates"], key=int)]
        return len(rates) >= 3 and rates[-1] > rates[-2] > rates[-3]

    def dead_segments(self) -> list[int]:
        """连续两轮都被归因判为“所有素材无效”的人群。"""
        r = self.state["round"]
        fails = lambda rnd: {f.segment_id for _, f in self.store.findings(rnd) if f.kind == "fails"}  # noqa: E731
        active = {s.id for s in self.store.segments()}
        return sorted(fails(r) & fails(r - 1) & active) if r >= 2 else []

    def allowed_actions(self) -> tuple[list[str], dict[str, str]]:
        """当前这一步允许主管选哪些动作，以及每个动作的说明。第一个是默认。"""
        stage, cfg, hints = self.state["stage"], self.config, {}
        if stage == "new":
            return ["understand_product"], hints
        if stage == "product":
            return ["segment_audience"], hints
        if stage == "segments":
            return ["generate_creatives"], hints
        if stage in ("drafts", "evolved") and self.store.creatives(status="draft"):
            return ["review_creatives"], hints      # 没审过的素材不可能进试投
        if stage in ("drafts", "evolved", "reviewed"):
            if not self.arms():
                return ["finish"], {"finish": "没有通过审核的素材，无法试投"}
            if self.state["round"] >= cfg.max_rounds or self.remaining() < cfg.round_budget * 0.1:
                return ["finish"], {"finish": "预算或轮数已到上限"}
            return ["run_trial"], hints
        if stage == "trialed":
            return ["attribute"], hints
        if stage == "attributed":
            if self.state["round"] >= cfg.max_rounds:
                return ["finish"], {"finish": f"达到最大轮数 {cfg.max_rounds}"}
            if self.remaining() < cfg.round_budget * 0.1:
                return ["finish"], {"finish": "投放预算用完"}
            if self.blocks_rising():
                return ["finish"], {"finish": "审核拦截比例连续上升，暂停等待人工查看"}
            if self.converged():
                return ["finish", "evolve_creatives"], {"finish": "各人群的第一名连续两轮稳定且概率超过阈值"}
            options = ["evolve_creatives", "finish"]
            if self.dead_segments():
                options.insert(1, "drop_segment")
                hints["drop_segment"] = "有人群连续两轮所有素材无效"
            return options, hints
        return [], hints

    # ------------------------------------------------------------------ 主循环
    async def run(self) -> str:
        """一直跑到收尾。可以随时中断：状态都在数据层里，再次调用会从断点接着做。"""
        try:
            while self.state["stage"] != "done":
                allowed, hints = self.allowed_actions()
                action, reason = await self.decide(allowed, hints)
                self.notify("action", {"action": action, "reason": reason, "round": self.state["round"]})
                result = await getattr(self, action)()
                self.store.log_lead(self.state["round"], action, reason, result)
                self.notify("result", {"action": action, "result": result})
                self.save()
        except BudgetExceeded as e:
            self.state["stop"] = f"运行预算用完：{e}"
            self.save()
            self.notify("note", {"text": f"{e}。已保存状态，调高运行预算后可以接着跑。"})
        return self.store.get("final_report", "")

    async def decide(self, allowed: list[str], hints: dict[str, str]) -> tuple[str, str]:
        if len(allowed) == 1:           # 只有一条路时不花一次调用去问
            return allowed[0], hints.get(allowed[0], "主干顺序的下一步")
        reply = await self.models.stage("lead").ask(LEAD_SYSTEM, self.situation(allowed, hints),
                                                    data={"task": "lead.decide", "allowed": allowed, "hints": hints})
        out = extract_json(reply)
        if isinstance(out, dict) and out.get("action") in allowed:
            return out["action"], str(out.get("reason", ""))[:200]
        return allowed[0], "主管给出的动作不在可选范围内，按默认动作处理"

    def situation(self, allowed: list[str], hints: dict[str, str]) -> str:
        r = self.state["round"]
        lines = [f"当前轮次：{r} / {self.config.max_rounds}　投放预算：已用 {self.store.used_budget()} / {self.config.budget}"]
        leaders = self.state["leaders"].get(str(r), {})
        names = {s.id: s.name for s in self.store.segments(active_only=False)}
        for seg, (cid, prob) in leaders.items():
            prev = self.state["leaders"].get(str(r - 1), {}).get(seg)
            lines.append(f"- {names.get(int(seg), seg)}：当前第一名 #{cid}，是最优的概率 {prob:.2f}"
                         + (f"；上一轮第一名 #{prev[0]}（{prev[1]:.2f}）" if prev else ""))
        if self.state["block_rates"]:
            lines.append("各轮审核拦截比例：" + "、".join(f"{self.state['block_rates'][k]:.0%}" for k in sorted(self.state["block_rates"], key=int)))
        report = self.store.get(f"report:{r}")
        if report:
            lines += ["", report]
        lines += ["", "可选动作："] + [f"- {a}：{ACTIONS[a]}" + (f"（{hints[a]}）" if a in hints else "") for a in allowed]
        return "\n".join(lines)

    # ------------------------------------------------------------------ 生产区
    async def understand_product(self) -> str:
        p = self.store.product()
        out = await product_stage.understand(self.models.stage("product"), p)
        pending = [sp for sp in out["points"] if sp.claim_level == "needs_proof"]
        confirmed = set(self.approver.confirm_points(p, pending))     # 人在这里介入：哪些功效有依据只有人知道
        for sp in pending:
            sp.confirmed = sp.id in confirmed
        self.store.save_points(p.id, out["points"])
        self.store.set("cons", out["cons"])
        self.store.set("discarded", [d.get("text", "") for d in out["discarded"]])
        self.state["stage"] = "product"
        text = product_stage.brief(out["points"], out["cons"])
        if out["discarded"]:
            text += f"\n因依据在原文里找不到而丢弃：{'；'.join(d.get('text', '') for d in out['discarded'])}"
        return text

    async def segment_audience(self) -> str:
        p = self.store.product()
        out = await segment_stage.segment_audience(self.models.stage("segment"), self.store.points(),
                                                   self.store.get("cons", []), p.reviews)
        if not out["segments"]:
            why = "；".join(f"{d['name']}（{d['reason']}）" for d in out["dropped"]) or "模型没有给出人群"
            raise RuntimeError(f"没有划分出任何有评价依据的人群：{why}")
        out["segments"] = out["segments"][:self.config.max_segments]
        total = sum(s.size_share for s in out["segments"])
        for s in out["segments"]:
            s.size_share = round(s.size_share / total, 3)
        self.store.save_segments(out["segments"])
        self._users = None
        self.state["stage"] = "segments"
        pool = self.users
        lines = [f"#{s.id} {s.name}（占比 {s.size_share:.0%}）：{s.scenario}" for s in out["segments"]]
        lines += [f"丢弃「{d['name']}」：{d['reason']}" for d in out["dropped"]]
        lines.append(f"模拟用户池 {len(pool)} 人，其中路人 {sum(u.segment_id is None for u in pool)} 人、"
                     f"留出用户 {sum(u.holdout for u in pool)} 人（留出用户不参与试投，只在最后验收）")
        return "\n".join(lines)

    async def generate_creatives(self) -> str:
        points, lines = self.store.points(usable_only=True), []
        existing = [c.body for c in self.store.creatives()]
        results = await asyncio.gather(*(creative.generate(
            self.models.stage("creative"), self.models.stage("selfcheck"), s, points, n=self.config.per_segment,
            round=1, format=self.config.format, existing=existing) for s in self.store.segments()))
        for s, out in zip(self.store.segments(), results):
            ids = [self.store.add_creative(c).id for c in out["creatives"]]
            lines.append(f"{s.name}：草稿 {'、'.join(f'#{i}' for i in ids) or '无'}"
                         + (f"；跳过 {len(out['skipped'])} 版" if out["skipped"] else ""))
        self.state["stage"] = "drafts"
        return "\n".join(lines)

    async def review_creatives(self) -> str:
        if self.rules is None:
            self.rules, self.rules_version = review.load_rules(self.config.rules, self.store.product().competitors)
        drafts = self.store.creatives(status="draft")
        outcomes = await asyncio.gather(*(self.review_one(c) for c in drafts))
        first_blocked = sum(o["first"] != "approved" for o in outcomes)
        rnd = self.state["round"] + 1
        self.state["block_rates"][str(rnd)] = first_blocked / max(len(drafts), 1)
        self.state["stage"] = "reviewed"
        lines = [f"送审 {len(drafts)} 版：通过 {sum(o['final'] == 'approved' for o in outcomes)}，"
                 f"放弃 {sum(o['final'] == 'rejected' for o in outcomes)}；首次送审未通过 {first_blocked} 版"]
        lines += [o["line"] for o in outcomes if o["line"]]
        return "\n".join(lines)

    async def review_one(self, c: Creative) -> dict:
        """规则 → 裁判 → 人工；没通过的带着原因重写，重写后从第一层重新审。同一版最多重写两次。"""
        points, model = self.store.points(usable_only=True), self.models.stage("review")
        seg = next(s for s in self.store.segments(active_only=False) if s.id == c.segment_id)
        versions = {"rules": self.rules_version, "judge": review.JUDGE_VERSION, "model": getattr(model.inner, "model", "?")}
        first, trail = None, []
        for attempt in range(3):
            result = await review.review(model, c, points, self.rules, checks=self.config.checks,
                                         brand_tone=self.config.brand_tone)
            human = None
            if result["verdict"] == "escalate":
                ok, note = self.approver.decide_borderline(c, result)
                human = {"decision": "approve" if ok else "reject", "by": getattr(self.approver, "name", "human"), "note": note}
                result = {**result, "verdict": "approved" if ok else "rejected", "human": human}
            self.store.log_review(c.id, self.state["round"] + 1, c.body, result["verdict"], result["hits"],
                                  result["checks"], human, versions)
            first = first or result["verdict"]
            if result["verdict"] == "approved":
                c.status, c.review = "approved", {"verdict": "approved", "attempts": attempt + 1}
                self.store.update_creative(c)
                return {"first": first, "final": "approved",
                        "line": f"#{c.id} 重写 {attempt} 次后通过：{'；'.join(trail)}" if attempt else ""}
            note = review.rejection_note(c.id, result)
            trail.append(note.replace("\n", " ｜ "))
            if attempt == 2:
                break
            plan = {"selling_point_ids": c.selling_point_ids, "angle": c.angle, "tone": c.tone}
            c.body = await creative.write_body(self.models.stage("creative"), seg, plan, points, c.format, note) or c.body
        c.status, c.review = "rejected", {"verdict": "rejected", "attempts": 3, "note": trail[-1]}
        self.store.update_creative(c)
        return {"first": first, "final": "rejected", "line": f"#{c.id} 两次重写仍未通过，放弃：{trail[-1]}"}

    # ------------------------------------------------------------------ 试投区
    async def run_trial(self) -> str:
        cfg, rnd = self.config, self.state["round"] + 1
        arms = {c.id: c for c in self.arms()}
        if self.store.round_status(rnd) != "done":       # 花钱的动作防重复：一轮只执行一次，中断后只补没投完的部分
            done_before = len(self.store.impressions(rnd))
            budget = min(cfg.round_budget, self.remaining() + done_before) - done_before
            if self.store.round_status(rnd) is None:
                summary = f"第 {rnd} 轮试投：{len(arms)} 版素材，本轮预算 {budget} 次曝光，剩余总预算 {self.remaining()}"
                if not self.approver.confirm_trial(rnd, summary):
                    self.state.update(stage="done", stop="试投未获确认")
                    return "试投未获确认，活动停止"
                self.store.set_round(rnd, "running")
            alloc = self.allocator()
            segs = {s.id: s for s in self.store.segments()}
            batch_n = max(1, cfg.batches)
            for b in range(batch_n):
                size = budget // batch_n + (b < budget % batch_n)
                if size <= 0:
                    continue
                seen = {cid: self.store.seen(rnd, cid) for cid in arms}
                avail = {cid: len(pick_users(self.users, c.segment_id, cid, rnd, 10 ** 9, seen[cid], self.sim["seed"],
                                             self.sim["bystander_share"])) for cid, c in arms.items()}
                caps = {sid: int(size * min(1.0, s.size_share * 1.5)) + 1 for sid, s in segs.items()}   # 每类人群的触达上限
                plan = alloc.allocate(size, random.Random(f"{self.sim['seed']}:alloc:{rnd}:{b}:{done_before}"), caps,
                                      cfg.floor_share, avail)

                async def serve(cid: int, k: int) -> None:
                    users = pick_users(self.users, arms[cid].segment_id, cid, rnd, k, seen[cid], self.sim["seed"],
                                       self.sim["bystander_share"])
                    reactions = await self.env.expose(rnd, arms[cid], users)
                    imps = to_impressions(rnd, arms[cid], users, reactions)
                    self.store.add_impressions(imps)      # 每个选项投完立刻落库：中途断了，已经投出去的不会丢也不会重投
                    alloc.update(cid, sum(self.reward(i) for i in imps), len(imps))

                await asyncio.gather(*(serve(cid, k) for cid, k in plan.items() if k > 0))
                self.notify("progress", {"round": rnd, "done": len(self.store.impressions(rnd)), "total": done_before + budget})
            self.store.set_round(rnd, "done")
        self.state.update(stage="trialed", round=rnd)
        imps = self.store.impressions(rnd)
        summary = attribute.summarize(imps)
        lines = [f"第 {rnd} 轮试投完成：{len(imps)} 次曝光，点击 {sum(i.clicked for i in imps)}，下单 {sum(i.ordered for i in imps)}"]
        for cid in sorted(summary, key=lambda k: -summary[k]["n"]):
            s = summary[cid]
            lines.append(f"  #{cid}　曝光 {s['n']}　点击 {s['clicks']}")
        return "\n".join(lines)

    async def attribute(self) -> str:
        rnd = self.state["round"]
        result = await attribute.attribute(self.models.stage("attribute"), rnd, self.store.segments(), self.store.creatives(),
                                           self.store.points(), self.store.impressions(), base_ctr=self.sim["base_ctr"])
        self.store.save_findings(rnd, result["findings"])
        self.store.set(f"feedback:{rnd}", {str(k): v for k, v in result["feedback"].items()})
        self.store.set(f"clickbait:{rnd}", result["clickbait"])
        probs = self.allocator().prob_best_by_segment(random.Random(f"{self.sim['seed']}:pb:{rnd}"))
        self.state["leaders"][str(rnd)] = {str(seg): [max(p, key=p.get), max(p.values())] for seg, p in probs.items() if p}
        report = attribute.render(rnd, self.store.segments(), result, self.sim["name"])
        self.store.set(f"report:{rnd}", report)
        self.state["stage"] = "attributed"
        return report

    async def evolve_creatives(self) -> str:
        rnd, rng = self.state["round"], random.Random(f"{self.sim['seed']}:evolve:{self.state['round']}")
        creatives, points = self.store.creatives(), self.store.points(usable_only=True)
        summary = attribute.summarize(self.store.impressions())
        probs = self.allocator().prob_best_by_segment(rng)
        findings = [f for _, f in self.store.findings(rnd)]
        feedback = self.store.get(f"feedback:{rnd}", {})
        baits = {b["creative_id"] for b in self.store.get(f"clickbait:{rnd}", []) if b["confirmed"]}
        lines = []

        retired = evolve.to_retire(summary, probs, creatives, baits)
        for cid in retired:
            c = next(x for x in creatives if x.id == cid)
            c.status = "retired"
            self.store.update_creative(c)
        if retired:
            lines.append("淘汰：" + "、".join(f"#{i}" for i in retired))

        model, jobs = self.models.stage("evolve"), []
        for seg in self.store.segments():
            alive = [c for c in creatives if c.segment_id == seg.id and c.status == "approved" and c.id in summary]
            alive.sort(key=lambda c: -probs.get(seg.id, {}).get(c.id, 0))
            for parent in alive[:self.config.rewrites_per_segment]:
                jobs.append((seg, parent, evolve.rewrite(model, seg, parent, summary[parent.id], findings,
                                                         feedback.get(str(seg.id), {}),
                                                         evolve.failed_attempts(parent, creatives, summary, rng), points, rnd + 1)))
        existing = [c.body for c in creatives]
        for (seg, parent, _), (child, diagnosis) in zip(jobs, await asyncio.gather(*(j[2] for j in jobs))):
            if child is None:
                lines.append(f"#{parent.id} 未改写：{diagnosis}")
            elif any(creative.similarity(child.body, old) > 0.8 for old in existing):
                lines.append(f"#{parent.id} 的改写与已有素材过于接近，丢弃")
            else:
                existing.append(child.body)
                self.store.add_creative(child)
                s = summary[parent.id]      # 新素材继承父素材打过折的统计，作为起步的先验
                ok = s["orders"] if self.config.objective == "order" else s["clicks"]
                self.store.set_prior(child.id, ok * allocate.INHERIT, (s["n"] - ok) * allocate.INHERIT)
                lines.append(f"#{parent.id} → #{child.id}　{child.note}")

        filled: set[int] = set()
        for f in findings:      # 补缺：没被回应的顾虑。有能回应的卖点就写新素材，没有就停下来问人
            if f.kind != "unaddressed" or f.segment_id in filled:
                continue
            seg = next((s for s in self.store.segments() if s.id == f.segment_id), None)
            if seg is None or any(f.statement == c for c in seg.concerns):
                continue
            answer = await evolve.find_answer(model, f, points)
            if answer is None:
                self.store.ask_human(f"{seg.id}:{f.statement}", rnd, f"「{seg.name}」里有 {f.support.get('count', 0)} 人的反馈提到「{f.statement}」，"
                                          "商品资料里没有相关信息，是否补充？")
                lines.append(f"{seg.name}：用户关心「{f.statement}」，卖点清单里没有能回应的，已记入待人回答的问题")
                continue
            filled.add(seg.id)                      # 每类人群每轮最多补一版，免得同一个顾虑换个说法被反复补
            seg.concerns.append(f.statement)        # 人群定义在闭环里被修正
            self.store.save_segments([seg])
            out = await creative.generate(self.models.stage("creative"), self.models.stage("selfcheck"), seg, points, n=1,
                                          round=rnd + 1, format=self.config.format, existing=existing,
                                          plans=[{"selling_point_ids": [answer.id], "angle": "痛点", "tone": "亲切"}])
            for c in out["creatives"]:
                c.note = f"补缺：回应「{f.statement}」，使用卖点 #{answer.id}"
                existing.append(c.body)
                self.store.add_creative(c)
                lines.append(f"{seg.name}：新增 #{c.id}　{c.note}")
        self.state["stage"] = "evolved"
        return "\n".join(lines) or "本轮没有淘汰，也没有产生新素材"

    async def drop_segment(self) -> str:
        names = {s.id: s.name for s in self.store.segments()}
        lines = []
        for sid in self.dead_segments():
            if self.approver.confirm_drop(names[sid], "连续两轮所有素材点击率接近基准"):
                self.store.drop_segment(sid)
                lines.append(f"已放弃人群「{names[sid]}」")
            else:
                lines.append(f"提议放弃「{names[sid]}」未获确认，保留")
        self.state["stage"] = "evolved"      # 接着进入下一轮
        return "\n".join(lines)

    async def finish(self) -> str:
        from .report import final_report
        allowed, hints = self.allowed_actions()
        self.state["stop"] = self.state["stop"] or hints.get("finish", "主管决定收尾")
        holdout = await self.verify_on_holdout()
        text = final_report(self, holdout)
        self.store.set("final_report", text)
        self.state["stage"] = "done"
        return text

    async def verify_on_holdout(self) -> dict:
        """把最终素材和首轮最优素材一起投给留出用户比一次。留出用户从没参与过试投和归因：
        优化用的用户上涨了而这里没涨，说明几轮下来只是拟合了那一批用户的噪声。"""
        out, rng = {}, random.Random(f"{self.sim['seed']}:holdout")
        if not self.state["round"]:
            return out
        first_round = attribute.summarize(self.store.impressions(1))
        probs = self.allocator().prob_best_by_segment(rng)
        creatives = {c.id: c for c in self.store.creatives()}
        for seg in self.store.segments():
            firsts = [cid for cid in first_round if creatives[cid].segment_id == seg.id and first_round[cid]["n"] >= 20]
            if not firsts or not probs.get(seg.id):
                continue
            first = max(firsts, key=lambda cid: first_round[cid]["ctr"])
            final = max(probs[seg.id], key=probs[seg.id].get)
            row = {"first": first, "final": final, "prob_best": probs[seg.id][final]}
            if first != final:
                users = [u for u in self.users if u.holdout and u.segment_id == seg.id]
                tallies = {}
                for cid in (first, final):
                    reactions = await self.env.expose("holdout", creatives[cid], users)
                    self.store.add_impressions(to_impressions(0, creatives[cid], users, reactions), holdout=True)
                    ok = sum((r.ordered if self.config.objective == "order" else r.clicked) for r in reactions)
                    tallies[cid] = (ok, len(users))
                mid, lo, hi = lift_interval(tallies[final], tallies[first], rng)
                row.update(lift=mid, lo=lo, hi=hi, n=len(users), tallies={str(k): v for k, v in tallies.items()})
            out[seg.id] = row
        return out
