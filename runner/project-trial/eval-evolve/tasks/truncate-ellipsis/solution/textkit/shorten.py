def truncate(text: str, limit: int, suffix: str = "…") -> str:
    """把 text 截到最多 limit 个字符；截断时在末尾加 suffix，加上 suffix 之后总长度也不能超过 limit。"""
    if len(text) <= limit:
        return text
    if limit <= len(suffix):
        return suffix[:limit]
    return text[: limit - len(suffix)] + suffix
