import pytest

from rooms.booking import BookingError, Schedule


def schedule():
    s = Schedule()
    s.add_room("小会议室", 4)
    s.add_room("大会议室", 12)
    return s


def test_overlapping_booking_is_rejected():
    s = schedule()
    s.book("小会议室", 600, 660, "小陈", "周会")
    with pytest.raises(BookingError, match="和 小陈 的预订冲突（10:00 到 11:00）"):
        s.book("小会议室", 630, 690, "小林")


def test_back_to_back_meetings_do_not_conflict():
    s = schedule()
    s.book("小会议室", 600, 660, "小陈")
    s.book("小会议室", 660, 720, "小林")
    s.book("小会议室", 540, 600, "小王")
    assert s.agenda("小林") == ["11:00-12:00 小会议室"]


def test_free_slots_and_find_room():
    s = schedule()
    s.book("小会议室", 600, 660, "小陈")
    assert s.free_slots("小会议室", 60) == [(480, 600), (660, 1200)]
    assert s.find_room(660, 720, 3) == "小会议室"
    assert s.find_room(630, 690, 3) == "大会议室"


def test_rules():
    s = schedule()
    with pytest.raises(BookingError):
        s.book("小会议室", 601, 660, "小陈")
    with pytest.raises(BookingError):
        s.book("小会议室", 600, 610, "小陈")
    with pytest.raises(BookingError):
        s.book("小会议室", 420, 500, "小陈")
