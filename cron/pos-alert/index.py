"""Personal OS 健康定时器（FC 定时函数），只负责按时敲门，计算/去重/推送都在 Web 函数里：

- 每天北京 08:30 / 20:30 → /pos/alerts/push（健康 / 热量差预警，src/service/pos/alertPush.ts）
- 每周一北京 09:00      → /pos/review/weekly/run（上一周复盘，src/service/pos/reviewService.ts）
- 每 2 分钟             → 预热 Web 函数（GET /article/navList，避免实例被回收后的 5 秒冷启动）

定时器 payload 为 'weekly' 时走周复盘，'warm' 时只做预热，其余走预警。
事件里带 {"dryRun": true} 时只算不推（部署后冒烟用）；{"job": "weekly"} 手动指定周复盘。
"""
import json
import os
import time
import urllib.request


def _parse(event):
    try:
        ev = json.loads(event or b"{}")
    except Exception:  # noqa: BLE001  非 JSON 事件按默认（预警）处理
        return {}
    return ev if isinstance(ev, dict) else {}


def _warm(base):
    """每 2 分钟敲一次 Web 函数的公开只读接口，让实例不被回收。

    2026-11-13 线上实测：实例被回收后第一个请求要等 5 秒多（备考库目录首屏 6.6 秒）。
    失败只打日志不报错：预热没成功不该让定时器告警。
    """
    if not base:
        raise RuntimeError("缺少 POS_API_BASE")
    started = time.time()
    try:
        with urllib.request.urlopen(f"{base}/article/navList?module=soe", timeout=20) as resp:
            status = resp.status
            resp.read()
    except Exception as e:  # noqa: BLE001
        print(f"warm failed: {e}")
        return json.dumps({"job": "warm", "ok": False})
    ms = int((time.time() - started) * 1000)
    print(f"warm status={status} ms={ms}")
    return json.dumps({"job": "warm", "ok": status == 200, "ms": ms})


def handler(event, context):
    base = os.environ.get("POS_API_BASE", "").rstrip("/")
    token = os.environ.get("HEALTH_API_TOKEN", "")
    ev = _parse(event)
    if "warm" in (ev.get("payload"), ev.get("triggerName"), ev.get("job")):
        return _warm(base)
    if not base or not token:
        raise RuntimeError("缺少 POS_API_BASE / HEALTH_API_TOKEN")
    weekly = "weekly" in (ev.get("payload"), ev.get("triggerName"), ev.get("job"))
    dry = bool(ev.get("dryRun"))
    path = "/pos/review/weekly/run" if weekly else "/pos/alerts/push"
    req = urllib.request.Request(
        f"{base}{path}" + ("?dryRun=1" if dry else ""),
        data=b"{}",
        method="POST",
        headers={"X-Health-Token": token, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=50) as resp:
        body = resp.read().decode("utf-8")
    print(body[:3000])
    res = json.loads(body)
    if not res.get("success"):
        raise RuntimeError(body[:500])
    data = res.get("data") or {}
    if weekly:
        if not dry and not data.get("posted") and data.get("reason") != "already_pushed":
            raise RuntimeError(f"周复盘未推送：{data.get('reason')}")
        return json.dumps({"job": "weekly", "week": data.get("weekStart"), "posted": data.get("posted"), "dryRun": dry}, ensure_ascii=False)
    if data.get("toPush") and not data.get("posted") and not dry:
        # 有新预警却没发出去（令牌/网络）：报错让 FC 日志可见；状态未记 last_pushed，下一班会重试
        raise RuntimeError(f"预警未推送：{data.get('reason')}")
    return json.dumps({"job": "alerts", "alerts": len(data.get("alerts") or []), "pushed": data.get("toPush"), "dryRun": dry}, ensure_ascii=False)
