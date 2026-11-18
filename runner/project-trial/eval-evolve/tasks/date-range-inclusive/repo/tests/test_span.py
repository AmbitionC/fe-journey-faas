from datetime import date

from calendar_kit.span import days_between, each_day


def test_same_day_is_one_day():
    assert days_between(date(2026, 3, 1), date(2026, 3, 1)) == 1


def test_week():
    assert days_between(date(2026, 3, 1), date(2026, 3, 7)) == 7


def test_each_day_includes_end():
    days = each_day(date(2026, 2, 27), date(2026, 3, 1))
    assert days[0] == date(2026, 2, 27) and days[-1] == date(2026, 3, 1) and len(days) == 3
