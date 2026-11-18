import re


def slugify(title: str) -> str:
    """把标题转成网址里用的别名：小写，非字母数字换成短横线。"""
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
