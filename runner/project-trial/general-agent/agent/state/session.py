"""会话记录：每追加一条消息就写一行 JSON。崩溃恢复、调试回看、评测评分都用它。"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from ..types import Message


class Session:
    def __init__(self, path: str | Path | None):
        self.path = Path(path) if path else None
        if self.path:
            self.path.parent.mkdir(parents=True, exist_ok=True)

    def _write(self, record: dict[str, Any]) -> None:
        if not self.path:
            return
        record["ts"] = round(time.time(), 3)
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")

    def message(self, m: Message) -> None:
        self._write({"type": "message", **m.to_api()})

    def note(self, kind: str, **data: Any) -> None:
        """工具开始执行、被拒绝、循环结束等过程事件。执行前写一次，查卡死时才有据可依。"""
        self._write({"type": kind, **data})

    @staticmethod
    def load_messages(path: str | Path) -> list[Message]:
        out = []
        for line in Path(path).read_text(encoding="utf-8").splitlines():
            rec = json.loads(line)
            if rec.get("type") == "message":
                out.append(Message.from_api(rec))
        return out
