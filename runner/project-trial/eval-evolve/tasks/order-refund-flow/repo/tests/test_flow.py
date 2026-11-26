import pytest

from orders.flow import IllegalTransition, Order, allowed_events, apply, replay, summary


def test_happy_path():
    o = replay("o1", 9900, ["pay", "ship", "deliver"])
    assert o.state == "delivered" and allowed_events(o) == ["refund_request"]


def test_unshipped_refund_is_approved_directly():
    o = replay("o2", 9900, ["pay", "refund_request", "refund_approve"])
    assert o.state == "refunded" and o.refunded_cents == 9900


def test_shipped_refund_completes_when_return_is_received():
    o = replay("o3", 9900, ["pay", "ship", "refund_request"])
    with pytest.raises(IllegalTransition):
        apply(o, "refund_approve")
    apply(o, "return_received", refund_cents=5000)
    assert o.state == "refunded" and o.refunded_cents == 5000
    assert summary(o) == "订单 o3：created → paid → shipped → refunding → refunded，已退 50.00 元"


def test_rejected_refund_goes_back_to_where_it_was():
    assert replay("o4", 100, ["pay", "refund_request", "refund_reject"]).state == "paid"
    assert replay("o5", 100, ["pay", "ship", "refund_request", "refund_reject"]).state == "delivered"


def test_illegal_transition():
    with pytest.raises(IllegalTransition):
        replay("o6", 100, ["ship"])
