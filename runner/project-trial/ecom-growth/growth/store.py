"""数据层：所有环节通过它交接，环节之间只传编号。

教程里的表结构是按 PostgreSQL 写的；这份实现用标准库自带的 SQLite，一个文件就是一次活动的全部状态，
拿到代码不用装数据库就能跑。数组和 JSONB 字段在这里存成 JSON 文本。

续跑靠两点：每个环节开始前先查这里，做过的跳过；写入用确定性的键，重复写不会多出记录。
"""
from __future__ import annotations

import json
import sqlite3
from dataclasses import asdict
from pathlib import Path

from .types import Creative, Finding, Impression, Product, Segment, SellingPoint

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS product (id INTEGER PRIMARY KEY, data TEXT);
CREATE TABLE IF NOT EXISTS selling_point (
  id INTEGER PRIMARY KEY, product_id INT, text TEXT, category TEXT, evidence TEXT, source TEXT,
  claim_level TEXT, review_support INT, confirmed INT, keywords TEXT);
CREATE TABLE IF NOT EXISTS segment (
  id INTEGER PRIMARY KEY, name TEXT, profile TEXT, size_share REAL, active INT DEFAULT 1);
CREATE TABLE IF NOT EXISTS creative (
  id INTEGER PRIMARY KEY, segment_id INT, selling_point_ids TEXT, angle TEXT, tone TEXT, body TEXT,
  format TEXT, parent_id INT, round INT, status TEXT, review TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS impression (
  round INT, creative_id INT, segment_id INT, user_id INT, clicked INT, ordered INT, feedback TEXT,
  holdout INT DEFAULT 0,
  PRIMARY KEY (round, creative_id, user_id, holdout));
CREATE TABLE IF NOT EXISTS trial_round (round INT PRIMARY KEY, status TEXT, plan TEXT, summary TEXT);
CREATE TABLE IF NOT EXISTS arm_prior (creative_id INT PRIMARY KEY, a REAL, b REAL);
CREATE TABLE IF NOT EXISTS review_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, creative_id INT, round INT, body TEXT, verdict TEXT,
  hits TEXT, checks TEXT, human TEXT, versions TEXT);
CREATE TABLE IF NOT EXISTS finding (
  id INTEGER PRIMARY KEY AUTOINCREMENT, round INT, segment_id INT, kind TEXT, statement TEXT,
  support TEXT, confidence TEXT, quotes TEXT);
CREATE TABLE IF NOT EXISTS score_cache (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS question (key TEXT PRIMARY KEY, round INT, text TEXT);
CREATE TABLE IF NOT EXISTS lead_log (id INTEGER PRIMARY KEY AUTOINCREMENT, round INT, action TEXT, reason TEXT, result TEXT);
CREATE TABLE IF NOT EXISTS llm_call (id INTEGER PRIMARY KEY AUTOINCREMENT, stage TEXT, model TEXT,
  input_tokens INT, output_tokens INT, ms INT);
"""


class Store:
    def __init__(self, path: str | Path = ":memory:"):
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path))
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)

    def close(self) -> None:
        self.db.commit()
        self.db.close()

    # ---- 活动级的状态 ----
    def get(self, key: str, default=None):
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def set(self, key: str, value) -> None:
        self.db.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", (key, json.dumps(value, ensure_ascii=False)))
        self.db.commit()

    # ---- 商品与卖点 ----
    def save_product(self, p: Product) -> None:
        self.db.execute("INSERT OR REPLACE INTO product VALUES (?,?)", (p.id, json.dumps(asdict(p), ensure_ascii=False)))
        self.db.commit()

    def product(self) -> Product | None:
        row = self.db.execute("SELECT data FROM product LIMIT 1").fetchone()
        return Product(**json.loads(row[0])) if row else None

    def save_points(self, product_id: int, points: list[SellingPoint]) -> None:
        for sp in points:
            self.db.execute("INSERT OR REPLACE INTO selling_point VALUES (?,?,?,?,?,?,?,?,?,?)",
                            (sp.id, product_id, sp.text, sp.category, sp.evidence, sp.source, sp.claim_level,
                             sp.review_support, int(sp.confirmed), json.dumps(sp.keywords, ensure_ascii=False)))
        self.db.commit()

    def points(self, usable_only: bool = False) -> list[SellingPoint]:
        rows = self.db.execute("SELECT * FROM selling_point ORDER BY id").fetchall()
        out = [SellingPoint(r["id"], r["text"], r["category"], r["evidence"], r["source"], r["claim_level"],
                            r["review_support"], bool(r["confirmed"]), json.loads(r["keywords"] or "[]")) for r in rows]
        return [sp for sp in out if sp.usable] if usable_only else out

    # ---- 人群 ----
    def save_segments(self, segments: list[Segment]) -> None:
        for s in segments:
            profile = {k: v for k, v in asdict(s).items() if k not in ("id", "name", "size_share")}
            self.db.execute("INSERT OR REPLACE INTO segment (id,name,profile,size_share,active) VALUES (?,?,?,?,1)",
                            (s.id, s.name, json.dumps(profile, ensure_ascii=False), s.size_share))
        self.db.commit()

    def segments(self, active_only: bool = True) -> list[Segment]:
        rows = self.db.execute("SELECT * FROM segment ORDER BY id").fetchall()
        return [Segment(id=r["id"], name=r["name"], size_share=r["size_share"], **json.loads(r["profile"]))
                for r in rows if r["active"] or not active_only]

    def drop_segment(self, segment_id: int) -> None:
        self.db.execute("UPDATE segment SET active=0 WHERE id=?", (segment_id,))
        self.db.commit()

    # ---- 素材 ----
    def add_creative(self, c: Creative) -> Creative:
        cur = self.db.execute(
            "INSERT INTO creative (id,segment_id,selling_point_ids,angle,tone,body,format,parent_id,round,status,review,note)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (c.id or None, c.segment_id, json.dumps(c.selling_point_ids), c.angle, c.tone, c.body, c.format,
             c.parent_id, c.round, c.status, json.dumps(c.review, ensure_ascii=False), c.note))
        c.id = cur.lastrowid
        self.db.commit()
        return c

    def update_creative(self, c: Creative) -> None:
        self.db.execute("UPDATE creative SET body=?, status=?, review=?, note=?, selling_point_ids=?, angle=?, tone=? WHERE id=?",
                        (c.body, c.status, json.dumps(c.review, ensure_ascii=False), c.note,
                         json.dumps(c.selling_point_ids), c.angle, c.tone, c.id))
        self.db.commit()

    def creatives(self, status: str | None = None, segment_id: int | None = None) -> list[Creative]:
        rows = self.db.execute("SELECT * FROM creative ORDER BY id").fetchall()
        out = [Creative(id=r["id"], segment_id=r["segment_id"], selling_point_ids=json.loads(r["selling_point_ids"]),
                        angle=r["angle"], tone=r["tone"], body=r["body"], format=r["format"], parent_id=r["parent_id"],
                        round=r["round"], status=r["status"], review=json.loads(r["review"] or "{}"), note=r["note"] or "")
               for r in rows]
        return [c for c in out if (status is None or c.status == status)
                and (segment_id is None or c.segment_id == segment_id)]

    def creative(self, creative_id: int) -> Creative:
        return next(c for c in self.creatives() if c.id == creative_id)

    # ---- 投放日志 ----
    def add_impressions(self, items: list[Impression], holdout: bool = False) -> int:
        """键是（轮次、素材、用户）：重复写入不会产生第二条记录。返回实际新增的条数。"""
        before = self.db.total_changes
        self.db.executemany("INSERT OR IGNORE INTO impression VALUES (?,?,?,?,?,?,?,?)",
                            [(i.round, i.creative_id, i.segment_id, i.user_id, int(i.clicked), int(i.ordered),
                              i.feedback, int(holdout)) for i in items])
        self.db.commit()
        return self.db.total_changes - before

    def impressions(self, round: int | None = None, holdout: bool = False) -> list[Impression]:
        sql, args = "SELECT * FROM impression WHERE holdout=?", [int(holdout)]
        if round is not None:
            sql, args = sql + " AND round=?", args + [round]
        return [Impression(r["round"], r["creative_id"], r["segment_id"], r["user_id"], bool(r["clicked"]),
                           bool(r["ordered"]), r["feedback"] or "") for r in self.db.execute(sql, args)]

    def seen(self, round: int, creative_id: int) -> set[int]:
        return {r[0] for r in self.db.execute(
            "SELECT user_id FROM impression WHERE round=? AND creative_id=? AND holdout=0", (round, creative_id))}

    def used_budget(self) -> int:
        return self.db.execute("SELECT COUNT(*) FROM impression WHERE holdout=0").fetchone()[0]

    def round_status(self, round: int) -> str | None:
        row = self.db.execute("SELECT status FROM trial_round WHERE round=?", (round,)).fetchone()
        return row[0] if row else None

    def set_round(self, round: int, status: str, plan: dict | None = None, summary: str = "") -> None:
        old = self.db.execute("SELECT plan, summary FROM trial_round WHERE round=?", (round,)).fetchone()
        self.db.execute("INSERT OR REPLACE INTO trial_round VALUES (?,?,?,?)",
                        (round, status, json.dumps(plan) if plan is not None else (old["plan"] if old else None),
                         summary or (old["summary"] if old else "")))
        self.db.commit()

    def rounds_done(self) -> list[int]:
        return [r[0] for r in self.db.execute("SELECT round FROM trial_round WHERE status='done' ORDER BY round")]

    def set_prior(self, creative_id: int, a: float, b: float) -> None:
        self.db.execute("INSERT OR REPLACE INTO arm_prior VALUES (?,?,?)", (creative_id, a, b))
        self.db.commit()

    def priors(self) -> dict[int, tuple[float, float]]:
        return {r[0]: (r[1], r[2]) for r in self.db.execute("SELECT * FROM arm_prior")}

    # ---- 审核留痕 ----
    def log_review(self, creative_id: int, round: int, body: str, verdict: str, hits: list, checks: list,
                   human: dict | None, versions: dict) -> None:
        dump = lambda v: json.dumps(v, ensure_ascii=False)  # noqa: E731
        self.db.execute("INSERT INTO review_log (creative_id,round,body,verdict,hits,checks,human,versions) VALUES (?,?,?,?,?,?,?,?)",
                        (creative_id, round, body, verdict, dump(hits), dump(checks), dump(human), dump(versions)))
        self.db.commit()

    def review_logs(self, round: int | None = None) -> list[dict]:
        rows = self.db.execute("SELECT * FROM review_log ORDER BY id").fetchall()
        out = [{**dict(r), "hits": json.loads(r["hits"]), "checks": json.loads(r["checks"]),
                "human": json.loads(r["human"]), "versions": json.loads(r["versions"])} for r in rows]
        return [r for r in out if round is None or r["round"] == round]

    # ---- 归因结论、待人回答的问题、主管的决定 ----
    def save_findings(self, round: int, findings: list[Finding]) -> None:
        self.db.execute("DELETE FROM finding WHERE round=?", (round,))
        dump = lambda v: json.dumps(v, ensure_ascii=False)  # noqa: E731
        self.db.executemany("INSERT INTO finding (round,segment_id,kind,statement,support,confidence,quotes) VALUES (?,?,?,?,?,?,?)",
                            [(round, f.segment_id, f.kind, f.statement, dump(f.support), f.confidence, dump(f.quotes))
                             for f in findings])
        self.db.commit()

    def findings(self, round: int | None = None) -> list[tuple[int, Finding]]:
        rows = self.db.execute("SELECT * FROM finding ORDER BY id").fetchall()
        return [(r["round"], Finding(r["segment_id"], r["kind"], r["statement"], json.loads(r["support"]),
                                     r["confidence"], json.loads(r["quotes"])))
                for r in rows if round is None or r["round"] == round]

    def ask_human(self, key: str, round: int, text: str) -> None:
        """同一个问题只留一条，内容更新为最近一次的说法。"""
        self.db.execute("INSERT OR REPLACE INTO question VALUES (?,?,?)", (key, round, text))
        self.db.commit()

    def questions(self) -> list[str]:
        return [r[0] for r in self.db.execute("SELECT text FROM question ORDER BY round, key")]

    def log_lead(self, round: int, action: str, reason: str, result: str) -> None:
        self.db.execute("INSERT INTO lead_log (round,action,reason,result) VALUES (?,?,?,?)", (round, action, reason, result))
        self.db.commit()

    def lead_log(self) -> list[dict]:
        return [dict(r) for r in self.db.execute("SELECT * FROM lead_log ORDER BY id")]

    # ---- 缓存与记账 ----
    def cache_get(self, key: str):
        row = self.db.execute("SELECT value FROM score_cache WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def cache_put(self, key: str, value) -> None:
        self.db.execute("INSERT OR REPLACE INTO score_cache VALUES (?,?)", (key, json.dumps(value, ensure_ascii=False)))

    def log_call(self, call) -> None:
        self.db.execute("INSERT INTO llm_call (stage,model,input_tokens,output_tokens,ms) VALUES (?,?,?,?,?)",
                        (call.stage, call.model, call.input_tokens, call.output_tokens, call.ms))

    def costs(self) -> list[dict]:
        return [dict(r) for r in self.db.execute(
            "SELECT stage, COUNT(*) calls, SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens, SUM(ms) ms"
            " FROM llm_call GROUP BY stage ORDER BY calls DESC")]
