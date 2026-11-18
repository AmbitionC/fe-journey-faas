#!/usr/bin/env bash
# 把 agent-journey-projects 仓库里各项目的试用代码同步进 runner/project-trial/，
# 并把每个项目整个打成会员下载用的 project-source/<项目>.zip（两者来自同一个提交）。
# 用法：bash scripts/sync-project-trial.sh <agent-journey-projects 的本地路径>
# 试用函数部署的是这里的副本；源头在 agent-journey-projects，改代码请改那边再同步，不要直接改副本。
set -euo pipefail
SRC="${1:?用法：sync-project-trial.sh <agent-journey-projects 路径>}"
DEST=runner/project-trial
# 项目 → 试用要用到的目录（整个项目另外打进源码包）
sync_project() {
  local project="$1"; shift
  rm -rf "$DEST/$project"
  mkdir -p "$DEST/$project"
  for d in "$@"; do
    cp -R "$SRC/$project/$d" "$DEST/$project/$d"
  done
  # 会员下载的源码包：整个项目目录（含 README、测试、任务集），随主函数代码包发布
  mkdir -p project-source
  rm -f "project-source/$project.zip"
  git -C "$SRC" archive --format=zip --prefix="$project/" -o "$PWD/project-source/$project.zip" "HEAD:$project"
  unzip -l "project-source/$project.zip" "$project/README.md" >/dev/null || { echo "$project 的源码包里没有 README"; exit 1; }
}
sync_project general-agent agent trial fixtures
sync_project eval-evolve evo trial tasks
sync_project ecom-growth growth trial data
find "$DEST" -name __pycache__ -type d -prune -exec rm -rf {} +
find "$DEST" -name .pytest_cache -type d -prune -exec rm -rf {} +
git -C "$SRC" rev-parse HEAD > "$DEST/SOURCE_COMMIT"
echo "已同步 general-agent、eval-evolve、ecom-growth @ $(cat "$DEST/SOURCE_COMMIT")"
