"""滑动窗口限流：每个调用方在最近 window 秒内最多放行 limit 次。

时间由调用方传入（秒），不读系统时钟，方便测试和回放。
"""
from collections import deque
from dataclasses import dataclass, field


@dataclass
class Verdict:
    allowed: bool
    remaining: int          # 这次判定之后，窗口内还能放行几次
    retry_after: float      # 被拒绝时，最早多少秒后可以再试；放行时为 0


@dataclass
class _Bucket:
    hits: deque = field(default_factory=deque)      # 放行过的请求的时间戳，从旧到新


class SlidingWindowLimiter:
    def __init__(self, limit: int, window: float):
        if limit <= 0 or window <= 0:
            raise ValueError("limit 和 window 必须为正")
        self.limit = limit
        self.window = window
        self._buckets: dict[str, _Bucket] = {}

    def _bucket(self, caller: str) -> _Bucket:
        bucket = self._buckets.get(caller)
        if bucket is None:
            bucket = self._buckets[caller] = _Bucket()
        return bucket

    def _expire(self, bucket: _Bucket, now: float) -> None:
        """把已经滑出窗口的记录清掉。恰好在 window 秒之前的那一次算已经滑出。"""
        while bucket.hits and now - bucket.hits[0] >= self.window:
            bucket.hits.popleft()

    def check(self, caller: str, now: float) -> Verdict:
        """判定一次请求。放行的请求会被记进窗口，被拒绝的不记。"""
        bucket = self._bucket(caller)
        self._expire(bucket, now)
        if len(bucket.hits) >= self.limit:
            retry_after = bucket.hits[0] + self.window - now
            return Verdict(False, 0, retry_after)
        bucket.hits.append(now)
        return Verdict(True, self.limit - len(bucket.hits), 0.0)

    def peek(self, caller: str, now: float) -> int:
        """只看还能放行几次，不占名额。"""
        bucket = self._bucket(caller)
        self._expire(bucket, now)
        return self.limit - len(bucket.hits)

    def reset(self, caller: str) -> None:
        self._buckets.pop(caller, None)

    def callers(self) -> list[str]:
        """当前窗口里还有记录的调用方。"""
        return sorted(c for c, b in self._buckets.items() if b.hits)
