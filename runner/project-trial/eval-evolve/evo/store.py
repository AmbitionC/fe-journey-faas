"""结果库与版本库：一个 SQLite 文件加一个轨迹目录。"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from .types import AgentVersion, RunRecord

SCHEMA = """
CREATE TABLE IF NOT EXISTS version (
  id TEXT PRIMARY KEY, parent TEXT, note TEXT, body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate',   -- candidate | merged | rejected
  reason TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS run (
  id INTEGER PRIMARY KEY, version_id TEXT NOT NULL, task_id TEXT NOT NULL,
  split TEXT NOT NULL, attempt INTEGER NOT NULL, passed INTEGER, reason TEXT,
  grader TEXT, input_tokens INTEGER, output_tokens INTEGER, seconds REAL,
  stopped TEXT, turns INTEGER, final_reply TEXT, trajectory_path TEXT
);
CREATE INDEX IF NOT EXISTS run_lookup ON run (version_id, split, task_id);
"""


class Store:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "traces").mkdir(exist_ok=True)
        self.db = sqlite3.connect(self.root / "evo.db")
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)

    # ── 版本 ──
    def save_version(self, v: AgentVersion, status: str = "candidate", reason: str = "") -> None:
        """版本内容不可变：同一个编号再存只更新状态，不改内容。"""
        self.db.execute(
            "INSERT INTO version (id, parent, note, body, status, reason) VALUES (?,?,?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET status=excluded.status, reason=excluded.reason",
            (v.id, v.parent, v.note, json.dumps(v.to_json(), ensure_ascii=False), status, reason))
        self.db.commit()

    def get_version(self, version_id: str) -> AgentVersion | None:
        row = self.db.execute("SELECT body FROM version WHERE id=?", (version_id,)).fetchone()
        return AgentVersion.from_json(json.loads(row["body"])) if row else None

    def head(self) -> AgentVersion | None:
        """最近一次合入的版本。回退就是把更早的版本重新标成合入。"""
        row = self.db.execute("SELECT body FROM version WHERE status='merged' ORDER BY rowid DESC LIMIT 1").fetchone()
        return AgentVersion.from_json(json.loads(row["body"])) if row else None

    def promote(self, version_id: str, reason: str = "") -> None:
        """把一个已有版本重新设为当前版本：删掉再插入，让它排到最后。"""
        row = self.db.execute("SELECT parent, note, body FROM version WHERE id=?", (version_id,)).fetchone()
        self.db.execute("DELETE FROM version WHERE id=?", (version_id,))
        self.db.execute("INSERT INTO version (id, parent, note, body, status, reason) VALUES (?,?,?,?,'merged',?)",
                        (version_id, row["parent"], row["note"], row["body"], reason))
        self.db.commit()

    def versions(self) -> list[dict]:
        return [dict(r) for r in self.db.execute(
            "SELECT id, parent, note, status, reason, created_at FROM version ORDER BY rowid")]

    def rejected_notes(self, limit: int = 8) -> list[str]:
        """被拒绝的候选和拒绝理由，下一轮提案器要看，避免重复提出同样的修改。"""
        rows = self.db.execute(
            "SELECT note, reason FROM version WHERE status='rejected' ORDER BY rowid DESC LIMIT ?", (limit,))
        return [f"{r['note']} → 被拒绝：{r['reason']}" for r in rows]

    # ── 运行结果 ──
    def add_run(self, r: RunRecord) -> int:
        cur = self.db.execute(
            "INSERT INTO run (version_id, task_id, split, attempt, passed, reason, grader, input_tokens, "
            "output_tokens, seconds, stopped, turns, final_reply) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (r.version_id, r.task_id, r.split, r.attempt, int(r.passed), r.reason, r.grader, r.input_tokens,
             r.output_tokens, r.seconds, r.stopped, r.turns, r.final_reply))
        path = self.root / "traces" / f"{cur.lastrowid}.json"
        path.write_text(json.dumps(r.trajectory, ensure_ascii=False), encoding="utf-8")
        self.db.execute("UPDATE run SET trajectory_path=? WHERE id=?", (str(path), cur.lastrowid))
        self.db.commit()
        return int(cur.lastrowid)

    def runs(self, version_id: str, split: str | None = None, grader: str | None = None) -> list[RunRecord]:
        sql, args = "SELECT * FROM run WHERE version_id=?", [version_id]
        if split:
            sql, args = sql + " AND split=?", args + [split]
        if grader:
            sql, args = sql + " AND grader=?", args + [grader]
        out = []
        for row in self.db.execute(sql + " ORDER BY task_id, attempt", args):
            traj = []
            if row["trajectory_path"] and Path(row["trajectory_path"]).exists():
                traj = json.loads(Path(row["trajectory_path"]).read_text(encoding="utf-8"))
            out.append(RunRecord(row["version_id"], row["task_id"], row["split"], row["attempt"], bool(row["passed"]),
                                 row["reason"] or "", row["grader"] or "", row["input_tokens"] or 0,
                                 row["output_tokens"] or 0, row["seconds"] or 0.0, row["stopped"] or "",
                                 row["turns"] or 0, row["final_reply"] or "", traj))
        return out

    def close(self) -> None:
        self.db.close()
