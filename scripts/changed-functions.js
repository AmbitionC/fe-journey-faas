#!/usr/bin/env node
/**
 * 决定「增量部署」还是「全量部署」。
 *
 * 用法: node scripts/changed-functions.js <beforeSha> <afterSha>
 * 输出（stdout，供 workflow 读取）:
 *   - "ALL"  → 需要全量部署
 *   - "NONE" → 没有与部署相关的改动，跳过部署
 *   - 否则   → 换行分隔的函数名列表，仅部署这些函数
 *
 * 背景：所有 FC 函数共用同一份代码包（s.yaml 里每个 service 的 codeUri 都是 '.'）。
 * 因此：
 *   - 只改了 src/function/*.ts → 只有这些端点的逻辑变化，按 functionName 增量部署即可。
 *   - 改了任何共享代码/配置/依赖（service、entity、config、middleware、common、dto、
 *     decorator、configuration.ts、package.json、s.yaml 等）→ 影响多个函数，必须全量，
 *     保证所有函数拿到同一份最新代码包。
 *   - 无法 diff（首次推送 / 强推 / workflow_dispatch）→ 保守起见全量。
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const before = (process.argv[2] || '').trim();
const after = (process.argv[3] || 'HEAD').trim();

function emit(value, reason) {
  if (reason) process.stderr.write(`[deploy] ${reason}\n`);
  process.stdout.write(`${value}\n`);
  process.exit(0);
}

// 无前置 commit（首次推送 / 手动触发 / 全 0）→ 全量
if (!before || /^0+$/.test(before)) {
  emit('ALL', 'no usable before sha → full deploy');
}

let files;
try {
  files = execSync(`git diff --name-only ${before} ${after}`, { encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
} catch (e) {
  emit('ALL', `git diff failed (${e.message}) → full deploy`);
}

if (!files.length) emit('NONE', 'no files changed');

// 与部署完全无关的文件：不参与判定
const IGNORE = [
  /^\.github\//,
  /^docs?\//,
  /\.md$/i,
  /^README/i,
  /^\.gitignore$/,
  /^\.env/,
  /\.test\.ts$/,
  /^test\//,
  /^scripts\/changed-functions\.js$/,
];
const relevant = files.filter((f) => !IGNORE.some((re) => re.test(f)));
if (!relevant.length) emit('NONE', 'only deploy-irrelevant files changed');

// 只要有一个改动不在 src/function/ 下 → 视为共享改动，全量
const onlyFunctionFiles = relevant.every((f) =>
  /^src\/function\/[^/]+\.ts$/.test(f),
);
if (!onlyFunctionFiles) emit('ALL', 'shared code / config / deps changed → full deploy');

// 从改动的 function 文件里解析 functionName（= s.yaml 中的 service key）
const names = new Set();
for (const f of relevant) {
  let src;
  try {
    src = fs.readFileSync(path.join(process.cwd(), f), 'utf8');
  } catch (e) {
    // 文件被删除（端点移除）等情况无法解析受影响集合 → 全量更安全
    emit('ALL', `cannot read ${f} → full deploy`);
  }
  const re = /functionName:\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) names.add(m[1]);
}

if (!names.size) emit('ALL', 'no functionName found in changed files → full deploy');

emit([...names].join('\n'), `incremental deploy: ${[...names].join(', ')}`);
