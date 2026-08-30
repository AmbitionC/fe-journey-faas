#!/usr/bin/env bash
# FC 日志结构化聚合（stdin → stdout）——公开 Actions job 的**默认**输出。
#
# 由来（2026-08-30 第三轮验收 P1-1）：脱敏是黑名单，无法证明「输出无 PII」。
# 公开日志因此改为只出**计数与字段白名单**：行数、时间跨度、级别分布、
# 错误类关键词计数、HTTP 状态码计数、异常类名 Top。**一律不输出原始日志行**，
# 也不输出任何自由文本片段——没有文本，就没有未被预见的凭据可漏。
#
# 需要原文时走 fc-logs.yml 的 include_text 开关（默认关），那条路径再过
# scripts/redact-logs.sh；那是减损不是保证，用完即弃。
set -euo pipefail
IN=$(cat)

echo "===== 行数 ====="
printf '%s\n' "$IN" | grep -c '' || true

echo "===== 时间跨度（首末行时间戳）====="
printf '%s\n' "$IN" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}' \
  | sed -n '1p;$p' || echo "(无可识别时间戳)"

echo "===== 日志级别分布 ====="
printf '%s\n' "$IN" | grep -oiE '\b(TRACE|DEBUG|INFO|WARN(ING)?|ERROR|FATAL)\b' \
  | tr '[:lower:]' '[:upper:]' | sort | uniq -c | sort -rn || echo "(无)"

echo "===== 错误类关键词计数 ====="
for k in error timeout ETIMEDOUT ECONNREFUSED ECONNRESET EAI_AGAIN ENOTFOUND \
         PROTOCOL_ ER_ unhandled FATAL "exit code"; do
  n=$(printf '%s\n' "$IN" | grep -ic -- "$k" || true)
  [ "${n:-0}" -gt 0 ] && printf '%8d  %s\n' "$n" "$k"
done
echo "(以上为计数，原始行不进公开日志)"

echo "===== HTTP 状态码计数 ====="
printf '%s\n' "$IN" | grep -oE '\b(status|statusCode|code)[=: ]+[1-5][0-9]{2}\b' \
  | grep -oE '[1-5][0-9]{2}$' | sort | uniq -c | sort -rn || echo "(无)"

echo "===== 异常类名 Top10（仅类名，不含消息体）====="
printf '%s\n' "$IN" | grep -oE '\b[A-Za-z]+(Error|Exception)\b' \
  | sort | uniq -c | sort -rn | head -10 || echo "(无)"
