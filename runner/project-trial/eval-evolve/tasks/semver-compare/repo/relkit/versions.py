def parse(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in version.strip().lstrip("v").split("."))


def is_newer(candidate: str, current: str) -> bool:
    """candidate 是否比 current 新。"""
    return candidate.lstrip("v") > current.lstrip("v")


def latest(versions: list[str]) -> str:
    return max(versions)
