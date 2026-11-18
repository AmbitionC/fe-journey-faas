#!/usr/bin/env bash
# 把 agent-journey-projects 仓库里某个项目的试用代码同步进 runner/project-trial/。
# 用法：bash scripts/sync-project-trial.sh <agent-journey-projects 的本地路径>
# 试用函数部署的是这里的副本；源头在 agent-journey-projects，改代码请改那边再同步，不要直接改副本。
set -euo pipefail
SRC="${1:?用法：sync-project-trial.sh <agent-journey-projects 路径>}"
DEST=runner/project-trial
rm -rf "$DEST/general-agent"
mkdir -p "$DEST/general-agent"
for d in agent trial fixtures; do
  cp -R "$SRC/general-agent/$d" "$DEST/general-agent/$d"
done
find "$DEST" -name __pycache__ -type d -prune -exec rm -rf {} +
find "$DEST" -name .pytest_cache -type d -prune -exec rm -rf {} +
git -C "$SRC" rev-parse HEAD > "$DEST/SOURCE_COMMIT"
echo "已同步 general-agent @ $(cat "$DEST/SOURCE_COMMIT")"
