def merge(base: dict, override: dict) -> dict:
    """用 override 覆盖 base，嵌套的字典要逐层合并。不修改传入的字典。"""
    out = dict(base)
    out.update(override)
    return out
