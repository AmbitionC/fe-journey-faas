/**
 * Iris 代码运行函数（iris-code-runner）：在独立的 FC 函数里跑一小段 JS / TS，返回输出。
 *
 * 用途：Iris 的 run_code 工具。学习者贴来的代码、Iris 想验证的某个语言行为，都在这里真跑一遍，
 * 用运行结果说话，而不是凭印象判断对错。（阿里云云沙箱是邀测，这是方案里写好的退路：自建隔离运行。）
 *
 * 隔离层次（由外到内）：
 *  1. 独立 FC 函数：不挂 VPC、不绑 RAM 角色、关闭公网出站（internetAccess: false）、除调用令牌外没有任何环境变量；
 *     instanceConcurrency 1，一个实例同一时刻只跑一个请求。
 *  2. 每次运行一个全新临时目录，跑完即删。
 *  3. 子进程开 Node 权限模型：只能读自己的临时目录，不能写文件、不能起子进程 / worker；
 *     环境变量清空（看不到调用令牌）；堆上限 128MB；超时 SIGKILL；输出封顶。
 *
 * 零依赖，只用 Node 内置模块。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = Number(process.env.FC_SERVER_PORT || process.env.PORT || 9000);
const TOKEN = process.env.CODE_RUNNER_TOKEN || '';
const MAX_CODE = 20000;
const MAX_STDIN = 10000;
const MAX_OUT = 8000;
const DEFAULT_TIMEOUT = 5000;
const MAX_TIMEOUT = 10000;
/** 附带文件（评审时把仓库里的源码一起放进去跑）：数量与总量上限 */
const MAX_FILES = 40;
const MAX_FILES_BYTES = 300000;

/** 附带文件的相对路径：只允许普通相对路径，挡掉绝对路径、..、隐藏的奇怪字符。导出给单测用。 */
function safeRelPath(p) {
  const s = String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!s || s.startsWith('/') || s.length > 200) return null;
  if (!/^[\w@.\-\/ ]+$/.test(s)) return null;
  const parts = s.split('/');
  if (parts.some((x) => !x || x === '.' || x === '..')) return null;
  if (s === 'main.js' || s === 'main.ts') return null;
  return s;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** 跑一段代码。导出给单测用。 */
function runCode({ language, code, stdin, timeoutMs, files }, opts = {}) {
  const nodeBin = opts.nodeBin || process.execPath;
  return new Promise((resolve) => {
    const lang = language === 'typescript' || language === 'ts' ? 'typescript' : 'javascript';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-run-'));
    const file = path.join(dir, lang === 'typescript' ? 'main.ts' : 'main.js');
    fs.writeFileSync(file, String(code));
    if (files && typeof files === 'object') {
      let n = 0;
      let bytes = 0;
      for (const [rel, content] of Object.entries(files)) {
        const safe = safeRelPath(rel);
        if (!safe || typeof content !== 'string') continue;
        if (++n > MAX_FILES || (bytes += content.length) > MAX_FILES_BYTES) break;
        const target = path.join(dir, safe);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
      }
    }
    const limit = Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT, 500), MAX_TIMEOUT);
    const args = [
      '--experimental-permission',
      `--allow-fs-read=${dir}`,
      '--max-old-space-size=128',
      '--disable-warning=ExperimentalWarning',
      '--stack-size=2000',
    ];
    if (lang === 'typescript') args.push('--experimental-strip-types');
    args.push(file);

    const started = Date.now();
    const child = spawn(nodeBin, args, { cwd: dir, env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    const take = (cur, chunk) => {
      if (cur.length >= MAX_OUT) {
        truncated = true;
        return cur;
      }
      const next = cur + chunk.toString('utf8');
      if (next.length > MAX_OUT) truncated = true;
      return next.slice(0, MAX_OUT);
    };
    child.stdout.on('data', (c) => (stdout = take(stdout, c)));
    child.stderr.on('data', (c) => (stderr = take(stderr, c)));
    child.stdin.on('error', () => {});
    child.stdin.end(stdin ? String(stdin).slice(0, MAX_STDIN) : '');
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, limit);
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      fs.rmSync(dir, { recursive: true, force: true });
      // 运行时路径对用户没意义，还暴露实现细节：统一换成 main.js / main.ts
      const clean = (s) => s.split(dir + path.sep).join('').split(dir).join('');
      resolve({
        language: lang,
        exitCode: exitCode == null ? null : exitCode,
        signal: signal || null,
        timedOut,
        durationMs: Date.now() - started,
        stdout: clean(stdout),
        stderr: clean(stderr),
        truncated,
      });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ language: lang, exitCode: null, signal: null, timedOut: false, durationMs: 0, stdout: '', stderr: `运行器启动失败：${e.message}`, truncated: false });
    });
  });
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

function createServer(opts = {}) {
  const token = opts.token !== undefined ? opts.token : TOKEN;
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/health')) {
      return send(res, 200, { ok: true, node: process.version });
    }
    if (req.method !== 'POST' || !req.url.startsWith('/run')) return send(res, 404, { error: 'not found' });
    // 没配令牌＝拒绝一切调用（宁可不可用，也不做公开的代码执行服务）
    if (!token || !safeEqual(req.headers['x-runner-token'] || '', token)) return send(res, 401, { error: 'unauthorized' });
    let raw = '';
    let tooBig = false;
    req.on('data', (c) => {
      raw += c;
      if (raw.length > MAX_CODE + MAX_STDIN + MAX_FILES_BYTES + 20000) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on('end', async () => {
      if (tooBig) return;
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return send(res, 400, { error: 'bad json' });
      }
      const code = typeof body.code === 'string' ? body.code : '';
      if (!code.trim()) return send(res, 400, { error: 'empty code' });
      if (code.length > MAX_CODE) return send(res, 413, { error: 'code too long' });
      const result = await runCode(body, opts);
      send(res, 200, result);
    });
    req.on('close', () => {
      if (tooBig && !res.headersSent) send(res, 413, { error: 'payload too large' });
    });
  });
}

module.exports = { runCode, createServer, safeRelPath };

if (require.main === module) {
  createServer().listen(PORT, () => console.log(`iris-code-runner listening on ${PORT} (${process.version})`));
}
