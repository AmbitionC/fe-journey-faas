from gateway.limiter import SlidingWindowLimiter


def test_allows_up_to_limit():
    lim = SlidingWindowLimiter(2, 10)
    assert lim.check("u", 0).allowed and lim.check("u", 1).allowed
    v = lim.check("u", 2)
    assert not v.allowed and v.remaining == 0 and v.retry_after == 8


def test_hit_exactly_one_window_ago_has_expired():
    lim = SlidingWindowLimiter(2, 10)
    lim.check("u", 0)
    lim.check("u", 1)
    v = lim.check("u", 10)
    assert v.allowed and v.remaining == 0
    assert lim.peek("u", 11) == 1


def test_rejected_requests_do_not_count():
    lim = SlidingWindowLimiter(1, 10)
    lim.check("u", 0)
    assert not lim.check("u", 5).allowed
    assert lim.check("u", 10).allowed


def test_callers_are_independent():
    lim = SlidingWindowLimiter(1, 10)
    assert lim.check("a", 0).allowed and lim.check("b", 0).allowed
    assert lim.callers() == ["a", "b"]
