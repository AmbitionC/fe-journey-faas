"""Personal OS 健康预警定时器（FC 定时函数）：北京 08:30 / 20:30 调 Web 函数 /pos/alerts/push。

预警计算、去重、推送都在 Web 函数里（src/service/pos/alertPush.ts），这里只负责按时敲门。
事件里带 {"dryRun": true} 时只算不推（部署后冒烟用）。
"""
import json
import os
import urllib.request


def handler(event, context):
    base = os.environ.get("POS_API_BASE", "").rstrip("/")
    token = os.environ.get("HEALTH_API_TOKEN", "")
    if not base or not token:
        raise RuntimeError("缺少 POS_API_BASE / HEALTH_API_TOKEN")
    try:
        ev = json.loads(event or b"{}")
    except Exception:  # noqa: BLE001  定时器 payload 不是 JSON 时按正常推送处理
        ev = {}
    dry = isinstance(ev, dict) and bool(ev.get("dryRun"))
    req = urllib.request.Request(
        f"{base}/pos/alerts/push" + ("?dryRun=1" if dry else ""),
        data=b"{}",
        method="POST",
        headers={"X-Health-Token": token, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=50) as resp:
        body = resp.read().decode("utf-8")
    print(body[:2000])
    res = json.loads(body)
    if not res.get("success"):
        raise RuntimeError(body[:500])
    data = res.get("data") or {}
    if data.get("toPush") and not data.get("posted") and not dry:
        # 有新预警却没发出去（令牌/网络）：报错让 FC 日志可见；状态未记 last_pushed，下一班会重试
        raise RuntimeError(f"预警未推送：{data.get('reason')}")
    return json.dumps({"alerts": len(data.get("alerts") or []), "pushed": data.get("toPush"), "dryRun": dry}, ensure_ascii=False)
