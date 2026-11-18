#!/usr/bin/env bash
# 把 agent-journey-projects 仓库里某个项目的试用代码同步进 runner/project-trial/，
# 并把整个项目打成会员下载用的 project-source/<项目>.zip（两者来自同一个提交）。
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
# 会员下载的源码包：整个项目目录（含 README、测试、评测任务），随主函数代码包发布
mkdir -p project-source
rm -f project-source/general-agent.zip
git -C "$SRC" archive --format=zip --prefix=general-agent/ -o "$PWD/project-source/general-agent.zip" HEAD:general-agent
unzip -l project-source/general-agent.zip general-agent/README.md >/dev/null || { echo "源码包里没有 README"; exit 1; }
echo "已同步 general-agent @ $(cat "$DEST/SOURCE_COMMIT")"
