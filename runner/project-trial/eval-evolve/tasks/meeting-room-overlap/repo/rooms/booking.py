"""会议室预订。

时间用“当天的第几分钟”表示（0 到 1440），区间左闭右开：10:00 结束的会和 10:00 开始的会不冲突。
每个会议室每天的营业时间可以单独设置，默认 8:00 到 20:00。
"""
from dataclasses import dataclass, field

DAY_START, DAY_END = 8 * 60, 20 * 60
MIN_LENGTH = 15          # 最短订 15 分钟
STEP = 5                 # 开始和结束时间都要落在 5 分钟的格子上


class BookingError(Exception):
    pass


@dataclass(frozen=True)
class Booking:
    room: str
    start: int
    end: int
    owner: str
    title: str = ""

    @property
    def minutes(self) -> int:
        return self.end - self.start


@dataclass
class Room:
    name: str
    capacity: int
    open_at: int = DAY_START
    close_at: int = DAY_END
    bookings: list[Booking] = field(default_factory=list)


def fmt(minute: int) -> str:
    return f"{minute // 60:02d}:{minute % 60:02d}"


def overlaps(a_start: int, a_end: int, b_start: int, b_end: int) -> bool:
    """两个左闭右开的区间有没有重叠。首尾相接不算重叠。"""
    return a_start <= b_end and b_start <= a_end


class Schedule:
    def __init__(self):
        self._rooms: dict[str, Room] = {}

    def add_room(self, name: str, capacity: int, open_at: int = DAY_START, close_at: int = DAY_END) -> Room:
        if name in self._rooms:
            raise BookingError(f"会议室 {name} 已存在")
        room = self._rooms[name] = Room(name, capacity, open_at, close_at)
        return room

    def _room(self, name: str) -> Room:
        if name not in self._rooms:
            raise BookingError(f"没有会议室 {name}")
        return self._rooms[name]

    def conflicts(self, room: str, start: int, end: int) -> list[Booking]:
        """和 [start, end) 冲突的已有预订，按开始时间排序。"""
        return sorted((b for b in self._room(room).bookings if overlaps(start, end, b.start, b.end)),
                      key=lambda b: b.start)

    def book(self, room: str, start: int, end: int, owner: str, title: str = "") -> Booking:
        r = self._room(room)
        if start % STEP or end % STEP:
            raise BookingError(f"时间要落在 {STEP} 分钟的格子上")
        if end - start < MIN_LENGTH:
            raise BookingError(f"最短要订 {MIN_LENGTH} 分钟")
        if start < r.open_at or end > r.close_at:
            raise BookingError(f"{room} 的开放时间是 {fmt(r.open_at)} 到 {fmt(r.close_at)}")
        clash = self.conflicts(room, start, end)
        if clash:
            first = clash[0]
            raise BookingError(f"和 {first.owner} 的预订冲突（{fmt(first.start)} 到 {fmt(first.end)}）")
        booking = Booking(room, start, end, owner, title)
        r.bookings.append(booking)
        return booking

    def cancel(self, booking: Booking) -> None:
        self._room(booking.room).bookings.remove(booking)

    def free_slots(self, room: str, at_least: int = MIN_LENGTH) -> list[tuple[int, int]]:
        """这间会议室当天还空着的时间段，只返回不短于 at_least 分钟的。"""
        r = self._room(room)
        slots, cursor = [], r.open_at
        for b in sorted(r.bookings, key=lambda b: b.start):
            if b.start - cursor >= at_least:
                slots.append((cursor, b.start))
            cursor = max(cursor, b.end)
        if r.close_at - cursor >= at_least:
            slots.append((cursor, r.close_at))
        return slots

    def find_room(self, start: int, end: int, people: int) -> str | None:
        """找一间坐得下、这个时间段空着的会议室；有多间时选容量最小的。"""
        fits = [r for r in self._rooms.values()
                if r.capacity >= people and r.open_at <= start and end <= r.close_at
                and not self.conflicts(r.name, start, end)]
        return min(fits, key=lambda r: (r.capacity, r.name)).name if fits else None

    def agenda(self, owner: str) -> list[str]:
        """某个人当天订的所有会，按开始时间排序。"""
        mine = sorted((b for r in self._rooms.values() for b in r.bookings if b.owner == owner),
                      key=lambda b: (b.start, b.room))
        return [f"{fmt(b.start)}-{fmt(b.end)} {b.room} {b.title}".rstrip() for b in mine]
