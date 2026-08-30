#!/usr/bin/env bash
# FC 日志脱敏过滤器（stdin → stdout）。fc-logs.yml 与行为测试共用同一份规则——
# 规则只在这里改，不在 yml 里复制。
#
# 🔴 边界声明（2026-08-30 第三轮验收 P1-1）：这是**黑名单**，原理上无法证明
# 「输出无 PII」——任何未被规则预见的凭据或个人信息仍会漏出。因此公开 job 的
# 默认输出已改为 scripts/summarize-logs.sh 的**结构化聚合**（只出计数与字段
# 白名单）；本脚本只在显式索要原文时作最后一道减损，不作为安全保证。
#
# 顺序敏感：URL 凭据 → 授权头/Cookie（整头遮到行尾）→ 引号内 token → 裸 token
# → 邮箱 → 手机号 → 长数字串 → 用户标识键。
set -euo pipefail

sed -E \
  -e 's#([a-zA-Z][a-zA-Z0-9+.-]*://)[^/@[:space:]]+:[^/@[:space:]]+@#\1***:***@#g' \
  -e 's/(Authorization[[:space:]"'"'"':=]*[:=]).*$/\1 ***/Ig' \
  -e 's/((Set-)?Cookie[[:space:]"'"'"':=]*[:=]).*$/\1 ***/Ig' \
  -e 's/((api[_-]?key|access[_-]?key|secret|token|passwd|password|pwd)[[:space:]]*[:=][[:space:]]*)"[^"]*"/\1"***"/Ig' \
  -e "s/((api[_-]?key|access[_-]?key|secret|token|passwd|password|pwd)[[:space:]]*[:=][[:space:]]*)'[^']*'/\\1'***'/Ig" \
  -e 's/((api[_-]?key|access[_-]?key|secret|token|passwd|password|pwd)[[:space:]"'"'"']*[:=][[:space:]"'"'"']*)[^,;[:space:]"'"'"']+/\1***/Ig' \
  -e 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/***@***/g' \
  -e 's/1[3-9][0-9]{9}/1**********/g' \
  -e 's/[0-9]{11,}/***/g' \
  -e 's/((user[_-]?id|uid|openid|unionid|idcard|id[_-]?no|card[_-]?no|mobile|phone|tel)[[:space:]"'"'"']*[:=][[:space:]"'"'"']*)[^,;[:space:]"'"'"']+/\1***/Ig' \
  -e 's/((card|idcard|身份证|卡号)[[:space:]]+)[0-9A-Za-z]{6,}/\1***/Ig'
