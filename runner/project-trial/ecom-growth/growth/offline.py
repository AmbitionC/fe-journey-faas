"""离线替身：不接模型也能把整条闭环跑通，用于 `--offline` 演示和测试。

它不是模型，只是一组认识示例商品的规则：按关键词提卖点、按模板拼文案、按关键词判断相关程度。
所以它跑出来的结果只说明流程是通的，文案质量和审核水平要接上真模型才看得出来。
各环节调用模型时都带着拼提示词用的结构化数据（data），替身直接读它，不去反解析提示词。
"""
from __future__ import annotations

import json
import re

from .types import ANGLES, TONES

# 示例商品（data/products/sunscreen.json）的卖点。最后一条的依据是编的，用来演示“依据找不到就丢弃”
POINTS = [
    {"text": "成膜快不黏腻", "category": "使用感", "evidence": "推开即成膜，清爽不黏腻", "source": "detail", "keywords": ["成膜", "不黏"]},
    {"text": "不含酒精", "category": "成分", "evidence": "不含酒精、不含香精", "source": "spec", "keywords": ["不含酒精", "酒精"]},
    {"text": "不含香精", "category": "成分", "evidence": "不含酒精、不含香精", "source": "spec", "keywords": ["香精"]},
    {"text": "SPF50+ PA++++", "category": "功效", "evidence": "SPF50+ PA++++", "source": "spec", "keywords": ["SPF50", "PA++++", "防晒力", "防晒指数"]},
    {"text": "防水防汗", "category": "功效", "evidence": "通过 40 分钟抗水测试，防水防汗", "source": "detail", "keywords": ["防水", "防汗", "出汗"]},
    {"text": "洗面奶可卸", "category": "使用感", "evidence": "洗面奶可卸", "source": "spec", "keywords": ["洗面奶"]},
    {"text": "50ml 便携装", "category": "规格", "evidence": "50ml 便携装", "source": "detail", "keywords": ["便携", "放包里", "小支"]},
    {"text": "同价位防晒效果第一", "category": "功效", "evidence": "同价位防晒效果第一", "source": "detail", "keywords": []},
    {"text": "敏感肌适用", "category": "功效", "evidence": "敏感肌适用", "source": "detail", "keywords": ["敏感肌", "敏感皮"]},
    {"text": "添加玻尿酸保湿", "category": "成分", "evidence": "添加三重玻尿酸，长效保湿", "source": "detail", "keywords": []},
]
CONS = [{"theme": "叠加粉底会搓泥", "keywords": ["搓泥"]}, {"theme": "价格偏贵", "keywords": ["贵"]}]
SEGMENTS = [
    {"name": "通勤上班族", "scenario": "夏天每天出门上班都会涂防晒，涂完马上要上妆出门。", "motive_keys": ["成膜", "便携"],
     "concerns": ["叠加粉底会搓泥"], "avoid": ["户外暴晒场景"], "quote_keys": ["通勤", "上班"], "size_share": 0.4},
    {"name": "敏感肌人群", "scenario": "皮肤容易泛红刺痛，买防晒先翻成分表。", "motive_keys": ["不含酒精", "香精"],
     "concerns": ["用了会刺痛泛红"], "avoid": ["夸张的功效承诺"], "quote_keys": ["敏感肌", "敏感皮"], "size_share": 0.35},
    {"name": "户外运动人群", "scenario": "跑步、骑车、徒步时长时间在户外，出汗多。", "motive_keys": ["防水", "SPF50"],
     "concerns": ["出汗后流白汤、要频繁补涂"], "avoid": ["妆前打底的说法"], "quote_keys": ["跑步", "骑车", "徒步"], "size_share": 0.25},
    {"name": "熬夜修复人群", "scenario": "熬夜后想靠防晒修复肤色。", "motive_keys": ["成膜"], "concerns": ["肤色暗沉"], "avoid": [],
     "quote_keys": ["这句话评价里没有"], "size_share": 0.1},     # 评价里找不到声音的人群，应当被程序丢弃
]
# 顾虑里的词 → 文案里出现哪些词算作回应了它
ANSWERS = {"搓泥": ["成膜", "不搓泥"], "刺痛": ["不含酒精", "0酒精", "不含香精"], "泛红": ["不含酒精", "不含香精"],
           "流白汤": ["防水", "防汗"], "补涂": ["防水", "防汗"], "卸": ["洗面奶"], "假白": ["不假白"], "贵": ["划算", "便携装"]}
HYPE = ["！", "闭眼", "绝了", "冲", "太", "超"]
TEMPLATES = {"痛点": "怕{concern}？{points}", "场景": "{scene}，{points}", "成分": "翻成分表就能确认：{points}",
             "对比": "和黏在脸上的感觉不一样，{points}", "口碑": "回购的人都在说：{points}"}
ENDINGS = {"理性": "。", "亲切": "，放心用。", "俏皮": "，闭眼冲！"}
SCENES = {"通勤上班族": "上班路上十分钟", "敏感肌人群": "换季脸容易红的时候", "户外运动人群": "跑步出一身汗"}
JUDGE_WORDS = {
    "功效越界": ["美白", "抗老", "提亮", "控油", "保湿", "修护", "不晒黑", "白回来"],
    "医疗暗示": ["痘痘", "消炎", "过敏好了", "泛红都退", "修复", "皮肤问题", "医生"],
    "贬低比较": ["别家", "其他牌子", "别的防晒都", "智商税", "不像某些"],
    "制造焦虑": ["老十岁", "晒一次", "后悔", "再不", "毁"],
}
JUDGE_UNSURE = {"品牌调性": ["闭眼", "冲！", "绝了", "姐妹"], "功效越界": ["一整天", "全天"], "医疗暗示": ["敏感肌也"]}


SHORT = {"搓泥": "上妆搓泥", "刺痛": "刺痛泛红", "流白汤": "出汗流白汤", "卸": "卸妆麻烦", "假白": "假白"}


def compose(segment_name: str, concern: str, points: list, angle: str, tone: str, dirty: str = "", retry: bool = False) -> str:
    concern = next((v for k, v in SHORT.items() if k in concern), concern[:6])
    if retry and tone == "俏皮":
        return TEMPLATES[angle].format(concern=concern, scene=SCENES.get(segment_name, "出门前"),
                                       points="、".join(p.text for p in points)) + "，冲就对了。"
    text = TEMPLATES[angle].format(concern=concern, scene=SCENES.get(segment_name, "出门前"),
                                   points="、".join(p.text for p in points)) + dirty
    return text + ENDINGS[tone]


class OfflineModel:
    model = "offline"
    last_usage = (0, 0)

    def __init__(self, flaws: bool = True):
        self.flaws = flaws     # 是否故意让个别文案第一次写出违规内容，用来演示拦截、重写、再审

    async def ask(self, system: str, user: str, *, data: dict | None = None) -> str:
        if not data or "task" not in data:
            raise RuntimeError("离线替身需要结构化输入")
        return getattr(self, data["task"].replace(".", "_"))(data)

    # ---- 商品理解 ----
    def product_extract(self, d) -> str:
        return json.dumps(POINTS, ensure_ascii=False)

    def product_reviews(self, d) -> str:
        pros = [{"theme": p["text"], "category": p["category"], "keywords": p["keywords"],
                 "quote": next((r for r in d["reviews"] if any(k in r for k in p["keywords"])), "")}
                for p in POINTS if p["keywords"]]
        cons = [{**c, "quote": next((r for r in d["reviews"] if any(k in r for k in c["keywords"])), "")} for c in CONS]
        return json.dumps({"pros": pros, "cons": cons}, ensure_ascii=False)

    def product_levels(self, d) -> str:
        out = []
        for p in d["points"]:
            level = ("forbidden" if re.search("最|第一|唯一", p.text) else
                     "verified" if p.category in ("规格", "成分") or p.text in ("洗面奶可卸", "成膜快不黏腻") else "needs_proof")
            out.append({"id": p.id, "level": level, "reason": "离线规则"})
        return json.dumps(out, ensure_ascii=False)

    # ---- 人群 ----
    def segment(self, d) -> str:
        out = []
        for s in SEGMENTS:
            motives = [p.id for p in d["points"] if any(k in " ".join([p.text, *p.keywords]) for k in s["motive_keys"])]
            quotes = [r for r in d["reviews"] if any(k in r for k in s["quote_keys"])][:2] or ["（没有找到原话）"]
            out.append({"name": s["name"], "scenario": s["scenario"], "motives": motives[:2], "concerns": s["concerns"],
                        "avoid": s["avoid"], "review_quotes": quotes, "size_share": s["size_share"]})
        return json.dumps(out, ensure_ascii=False)

    # ---- 素材 ----
    def creative_plan(self, d) -> str:
        seg, ids = d["segment"], [p.id for p in d["points"]]
        order = [i for i in seg.motives if i in ids] + [i for i in ids if i not in seg.motives]
        plans = [{"selling_point_ids": [order[k % len(order)]] if k % 2 == 0 else [order[0], order[(k + 1) % len(order)]],
                  "angle": ANGLES[(k + seg.id) % len(ANGLES)], "tone": TONES[k % len(TONES)]} for k in range(d["n"])]
        return json.dumps(plans, ensure_ascii=False)

    def creative_write(self, d) -> str:
        seg, plan = d["segment"], d["plan"]
        dirty = ""
        if self.flaws and not d["feedback"]:          # 第一次写时故意出两类问题；带着拦截原因重写时就不再犯
            if plan["angle"] == "口碑" and plan["tone"] == "俏皮":
                dirty = "，顶级体验"
            elif plan["angle"] == "痛点" and plan["tone"] == "亲切":
                dirty = "，用完痘痘都少了"
        concern = seg.concerns[-1] if len(seg.concerns) > 1 and plan["angle"] == "痛点" and len(d["points"]) == 1 else seg.concerns[0]
        return compose(seg.name, concern, d["points"], plan["angle"], plan["tone"], dirty, retry=bool(d["feedback"]))

    def creative_selfcheck(self, d) -> str:
        return "没有"

    # ---- 审核 ----
    def review_judge(self, d) -> str:
        body, allowed = d["body"], " ".join(p.text + p.evidence for p in d["points"])
        if d["check"] == "无依据的数据":
            extra = [m for m in re.findall(r"\d+(?:\.\d+)?\s*(?:%|倍|小时|天|分钟|万)", body) if m.replace(" ", "") not in allowed.replace(" ", "")]
            return f"原句：{extra[0]}\n结论：违规" if extra else "原句：无\n结论：合规"
        for w in JUDGE_WORDS.get(d["check"], []):
            if w in body and w not in allowed:
                return f"原句：{w}\n结论：违规"
        for w in JUDGE_UNSURE.get(d["check"], []):
            if w in body and w not in allowed:
                return f"原句：{w}\n结论：拿不准"
        return "原句：无\n结论：合规"

    # ---- 模拟用户打分 ----
    def sim_score(self, d) -> str:
        body, out = d["creative"].body, []
        for n, persona in enumerate(d["personas"], 1):
            if "没有买这类商品的打算" in persona:
                out.append({"n": n, "motive": 0, "concern": 0, "aversion": 0, "feedback": "跟我没什么关系，划走了"})
                continue
            care = (re.search(r"你最在意：(.+?)。", persona) or [None, ""])[1].split("；")
            hit = [c for c in care if c and any(k in body for k in [c] + [kw for p in POINTS if p["text"] == c for kw in p["keywords"]])]
            motive = min(len(hit), 2) if len(care) > 1 else 2 * bool(hit)
            if "主要看价格" in persona and not any(w in body for w in ANSWERS["贵"]):
                motive = min(motive, 1)
            worries = [k for k in ANSWERS if k in persona.split("你最在意")[-1]]
            answered = [k for k in worries if any(w in body for w in ANSWERS[k])]
            concern = 0 if not answered else 2 if len(answered) == len(worries) else 1
            aversion = 0
            if "反感夸张" in persona and any(w in body for w in HYPE):
                aversion = 2
            if "户外暴晒" in persona and "暴晒" in body or "妆前" in persona and "上妆" in body:
                aversion = max(aversion, 1)
            missing = [k for k in worries if k not in answered]
            feedback = ("语气太夸张了，像在喊口号" if aversion == 2 else
                        f"说到了我在意的{hit[0]}" + (f"，不过不知道会不会{missing[0]}" if missing and missing[0] == "假白" else "") if hit else
                        "不知道会不会假白，没说清楚" if "假白" in missing else
                        "要是洗面奶洗不掉还得专门卸，嫌麻烦" if "卸" in missing else "没说到我关心的点")
            out.append({"n": n, "motive": motive, "concern": concern, "aversion": aversion, "feedback": feedback})
        return json.dumps(out, ensure_ascii=False)

    # ---- 归因 ----
    def attribute_feedback(self, d) -> str:
        tally = d["tally"]
        clicks = sorted(((t, c) for t, (c, s) in tally.items() if c and "在意" in t), key=lambda x: -x[1])
        skips = sorted(((t, s) for t, (c, s) in tally.items() if s and "在意" not in t), key=lambda x: -x[1])
        un = []
        for word, name in (("假白", "担心涂了会假白"), ("卸", "嫌还要专门卸妆麻烦")):
            quotes = [t for t in tally if word in t]
            if quotes and not any(word in c for c in d["segment"].concerns):
                un.append({"concern": name, "count": sum(sum(tally[q]) for q in quotes), "quotes": quotes[:2]})
        return json.dumps({"click_reasons": [{"reason": t, "count": c, "quotes": [t]} for t, c in clicks[:3]],
                           "skip_reasons": [{"reason": t, "count": s, "quotes": [t]} for t, s in skips[:3]],
                           "unaddressed": un}, ensure_ascii=False)

    def attribute_bait(self, d) -> str:
        return "否"

    # ---- 进化 ----
    def evolve_rewrite(self, d) -> str:
        parent, seg, points = d["parent"], d["segment"], {p.id: p for p in d["points"]}
        tried = " ".join(d["failed"])
        plan = {"selling_point_ids": list(parent.selling_point_ids), "angle": parent.angle, "tone": parent.tone}
        best_angle = next((f.support.get("best") for f in d["findings"] if f.kind == "works" and f.statement.startswith("角度")), None)
        missing = [i for i in seg.motives if i in points and i not in parent.selling_point_ids]
        if parent.tone == "俏皮" and "改语气" not in tried:
            plan["tone"], why = "理性", "有用户反感夸张的语气"
        elif best_angle and best_angle != parent.angle and "改角度" not in tried:
            plan["angle"], why = best_angle, f"归因显示{best_angle}角度更有效"
        elif missing and "改卖点" not in tried:
            plan["selling_point_ids"], why = [parent.selling_point_ids[0], missing[0]][:2], "还有一个核心动机没说到"
        else:
            plan["angle"], why = ANGLES[(ANGLES.index(parent.angle) + 1) % len(ANGLES)], "换一个切入角度试试"
        body = compose(seg.name, seg.concerns[0] if seg.concerns else "不好用", [points[i] for i in plan["selling_point_ids"] if i in points],
                       plan["angle"], plan["tone"])
        return json.dumps({"diagnosis": why, "changed": "", **plan, "body": body}, ensure_ascii=False)

    def evolve_gap(self, d) -> str:
        for word, answers in ANSWERS.items():
            if word in d["concern"]:
                hit = next((p for p in d["points"] if any(a in p.text for a in answers)), None)
                return json.dumps({"selling_point_id": hit.id if hit else None, "reason": "离线规则"}, ensure_ascii=False)
        return '{"selling_point_id": null, "reason": "没有对应卖点"}'

    # ---- 主管 ----
    def lead_decide(self, d) -> str:
        return json.dumps({"action": d["allowed"][0], "reason": d["hints"].get(d["allowed"][0], "按主干顺序推进")}, ensure_ascii=False)
