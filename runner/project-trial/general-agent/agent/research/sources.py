"""来源库：所有研究员共用，每登记一条得到一个全局编号，报告里写作 [3]。"""
from __future__ import annotations

import json
import re
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path


@dataclass
class Source:
    id: int
    url: str
    title: str
    fetched_at: str
    excerpts: list[str] = field(default_factory=list)  # 从正文里摘出的原文片段，不改写


class SourceStore:
    def __init__(self) -> None:
        self._by_url: dict[str, Source] = {}
        self.known_urls: set[str] = set()  # 搜索结果或已读网页里出现过的网址，读网页工具只认这些

    def register(self, url: str, title: str, excerpts: list[str]) -> Source:
        """同一个网址只登记一次，再次登记时返回已有编号并合并摘录。"""
        src = self._by_url.get(url)
        if src is None:
            src = Source(len(self._by_url) + 1, url, title, time.strftime("%Y-%m-%d %H:%M"))
            self._by_url[url] = src
        for e in excerpts:
            if e and e not in src.excerpts:
                src.excerpts.append(e)
        return src

    def get(self, source_id: int) -> Source | None:
        return next((s for s in self._by_url.values() if s.id == source_id), None)

    def all(self) -> list[Source]:
        return sorted(self._by_url.values(), key=lambda s: s.id)

    def dump(self, path: Path) -> None:
        path.write_text(json.dumps({"sources": [asdict(s) for s in self.all()],
                                    "known_urls": sorted(self.known_urls)}, ensure_ascii=False, indent=1),
                        encoding="utf-8")

    @classmethod
    def load(cls, path: Path) -> "SourceStore":
        store, data = cls(), json.loads(path.read_text(encoding="utf-8"))
        for s in data["sources"]:
            store._by_url[s["url"]] = Source(**s)
        store.known_urls = set(data.get("known_urls", []))
        return store


_CITE = re.compile(r"\[(\d+)\]")
_KEY = re.compile(r"\d+(?:\.\d+)?%?|[A-Za-z][A-Za-z0-9\-\.]{2,}")


def verify_report(report: str, store: SourceStore) -> list[str]:
    """机械校验。抓不住所有问题，但能抓住最常见的一类：编号不存在、数字和专有名词对不上来源。"""
    problems = []
    for sentence in re.split(r"(?<=[。！？\n])", report):
        ids = [int(x) for x in _CITE.findall(sentence)]
        if not ids:
            continue
        sources = []
        for i in ids:
            src = store.get(i)
            if src is None:
                problems.append(f"引用了不存在的来源 [{i}]：{sentence.strip()[:80]}")
            else:
                sources.append(src)
        if not sources:
            continue
        evidence = " ".join(" ".join(s.excerpts) + " " + s.title for s in sources).lower()
        claims = _KEY.findall(_CITE.sub("", sentence))
        missing = [k for k in claims if k.lower() not in evidence]
        if missing:
            problems.append(f"来源 {ids} 的摘录里找不到：{'、'.join(missing[:5])}。句子：{sentence.strip()[:80]}")
    return problems
