def merge(base: dict, override: dict) -> dict:
    """用 override 覆盖 base，嵌套的字典要逐层合并。不修改传入的字典。"""
    out = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = merge(out[key], value)
        else:
            out[key] = value
    return out
