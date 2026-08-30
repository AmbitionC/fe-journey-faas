#!/usr/bin/env bash
# FC 日志脱敏过滤器（stdin → stdout）。fc-logs.yml 与行为测试共用同一份规则——
# 规则只在这里改，不在 yml 里复制（2026-08-30 二次验收 P1-2：此前只掩手机号，
# 邮箱/授权头/Cookie/token/连接串原样进入公开 Actions stdout）。
# 顺序敏感：连接串/URL 凭据先于泛化 token 规则，避免被半截替换拆散。
set -euo pipefail
sed -E \
  -e 's#([a-zA-Z][a-zA-Z0-9+.-]*://)[^/@[:space:]]+:[^/@[:space:]]+@#\1***:***@#g' \
  -e 's/(Authorization[[:space:]"'"'"':=]+)(Bearer[[:space:]]+)?[A-Za-z0-9._~+/=-]+/\1***/Ig' \
  -e 's/((api[_-]?key|access[_-]?key|secret|token|passwd|password|pwd)[[:space:]"'"'"']*[:=][[:space:]"'"'"']*)[^,;[:space:]"'"'"']+/\1***/Ig' \
  -e 's/(Set-)?(Cookie[[:space:]"'"'"':=]+)[^;[:space:]]+/\2***/Ig' \
  -e 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/***@***/g' \
  -e 's/1[3-9][0-9]{9}/1**********/g'
