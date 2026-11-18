from datetime import date, timedelta


def days_between(start: date, end: date) -> int:
    """区间包含的天数，首尾两天都算。"""
    return (end - start).days


def each_day(start: date, end: date) -> list[date]:
    """区间里的每一天，首尾两天都算。"""
    return [start + timedelta(days=i) for i in range(days_between(start, end))]
