def page_count(total: int, per_page: int) -> int:
    """一共多少页。"""
    return total // per_page


def page_slice(items: list, page: int, per_page: int) -> list:
    """取第 page 页（从 1 开始）。"""
    start = (page - 1) * per_page
    return items[start:start + per_page]
