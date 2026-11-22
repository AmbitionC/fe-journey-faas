import re

_UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400}


def parse_duration(text: str) -> int:
    """把 "1h30m"、"45s"、"2d" 这样的写法换算成秒。写法不合法时抛 ValueError。"""
    text = text.strip().lower()
    if not text or not re.fullmatch(r"(\d+[smhd])+", text):
        raise ValueError(f"无法识别的时长：{text!r}")
    return sum(int(n) * _UNITS[u] for n, u in re.findall(r"(\d+)([smhd])", text))
