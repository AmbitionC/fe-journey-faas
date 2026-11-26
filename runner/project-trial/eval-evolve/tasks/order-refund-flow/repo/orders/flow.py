"""订单状态机。

状态和事件都是字符串。每次流转都会记一条历史，方便客服查。
金额以分为单位；退款金额不能超过实付金额。
"""
from dataclasses import dataclass, field

CREATED, PAID, SHIPPED, DELIVERED = "created", "paid", "shipped", "delivered"
REFUNDING, REFUNDED, CANCELLED = "refunding", "refunded", "cancelled"

# 当前状态 → {事件: 下一个状态}
TRANSITIONS: dict[str, dict[str, str]] = {
    CREATED: {"pay": PAID, "cancel": CANCELLED},
    PAID: {"ship": SHIPPED, "refund_request": REFUNDING, "cancel": CANCELLED},
    SHIPPED: {"deliver": DELIVERED, "refund_request": REFUNDING},
    DELIVERED: {"refund_request": REFUNDING},
    REFUNDING: {"refund_approve": REFUNDED, "return_received": REFUNDING, "refund_reject": DELIVERED},
    REFUNDED: {},
    CANCELLED: {},
}

FINAL = {REFUNDED, CANCELLED}


class IllegalTransition(Exception):
    def __init__(self, state: str, event: str):
        super().__init__(f"订单处于 {state} 时不能 {event}")
        self.state, self.event = state, event


@dataclass
class Order:
    id: str
    amount_cents: int
    state: str = CREATED
    refunded_cents: int = 0
    history: list[tuple[str, str, str]] = field(default_factory=list)     # （原状态，事件，新状态）
    shipped_before_refund: bool = False


def allowed_events(order: Order) -> list[str]:
    """当前状态下可以发生哪些事件，按字母序。"""
    return sorted(TRANSITIONS[order.state])


def apply(order: Order, event: str, *, refund_cents: int | None = None) -> Order:
    """让订单发生一个事件，原地修改并返回它。不合法的流转抛 IllegalTransition。"""
    table = TRANSITIONS[order.state]
    if event not in table:
        raise IllegalTransition(order.state, event)
    target = table[event]

    if event == "refund_request":
        # 记下申请退款时货有没有发出去：发了货的要等仓库收到退货才退钱
        order.shipped_before_refund = order.state in (SHIPPED, DELIVERED)
    if event == "refund_approve" and order.shipped_before_refund:
        # 已发货的订单不能直接批准退款，必须走 return_received
        raise IllegalTransition(order.state, event)
    if event == "refund_reject" and not order.shipped_before_refund:
        # 没发货的订单驳回退款后回到已支付，而不是已签收
        target = PAID
    if target == REFUNDED:
        amount = order.amount_cents if refund_cents is None else refund_cents
        if amount <= 0 or amount > order.amount_cents:
            raise ValueError("退款金额必须为正且不超过实付金额")
        order.refunded_cents = amount

    order.history.append((order.state, event, target))
    order.state = target
    return order


def replay(order_id: str, amount_cents: int, events: list[str]) -> Order:
    """从头按顺序重放一串事件，得到最终的订单。对账和排查时用。"""
    order = Order(order_id, amount_cents)
    for event in events:
        apply(order, event)
    return order


def is_final(order: Order) -> bool:
    return order.state in FINAL


def summary(order: Order) -> str:
    """给客服看的一行摘要。"""
    path = " → ".join([order.history[0][0]] + [h[2] for h in order.history]) if order.history else order.state
    refund = f"，已退 {order.refunded_cents / 100:.2f} 元" if order.refunded_cents else ""
    return f"订单 {order.id}：{path}{refund}"
