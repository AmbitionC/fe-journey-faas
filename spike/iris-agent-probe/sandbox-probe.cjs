// 云沙箱（FC Agent Sandbox，E2B 兼容）排雷：在 cn-hangzhou 建沙箱，验证评审需要的每一项能力。只打印结论。
const { Sandbox } = require('e2b');
const REGION = process.env.SANDBOX_REGION || 'cn-hangzhou';
const conn = { apiKey: process.env.E2B_API_KEY, apiUrl: `https://api.${REGION}.e2b.fc.aliyuncs.com`, domain: `${REGION}.e2b.fc.aliyuncs.com` };
const out = [];
const rec = (name, ok, detail) => { out.push({ name, ok, ...detail }); };
async function sh(sbx, name, cmd, timeoutMs = 120000) {
  const t0 = Date.now();
  try { const r = await sbx.commands.run(cmd, { timeoutMs }); rec(name, r.exitCode === 0, { ms: Date.now() - t0, out: (r.stdout || '').trim().slice(-300), err: (r.stderr || '').trim().slice(-200) }); }
  catch (e) { rec(name, false, { ms: Date.now() - t0, error: String(e.message || e).slice(0, 300) }); }
}
(async () => {
  for (const template of ['base', 'code-interpreter-v1']) {
    const t0 = Date.now(); let sbx;
    try { sbx = await Sandbox.create(template, { ...conn, timeoutMs: 600000 }); rec(`create ${template}`, true, { ms: Date.now() - t0 }); }
    catch (e) { rec(`create ${template}`, false, { ms: Date.now() - t0, error: String(e.message || e).slice(0, 300) }); continue; }
    try {
      await sh(sbx, `${template} 运行时版本`, 'node -v; npm -v; python3 -V; git --version; nproc; free -m | head -2; df -h / | tail -1');
      await sh(sbx, `${template} 外网 npmmirror`, 'curl -sS -o /dev/null -w "%{http_code} %{time_total}s" https://registry.npmmirror.com/zod');
      await sh(sbx, `${template} 外网 npmjs`, 'curl -sS -o /dev/null -w "%{http_code} %{time_total}s" https://registry.npmjs.org/zod');
      await sh(sbx, `${template} 外网 github`, 'curl -sS -o /dev/null -w "%{http_code} %{time_total}s" https://codeload.github.com/sindresorhus/is/tar.gz/refs/heads/main');
      await sh(sbx, `${template} 外网 deepseek`, 'curl -sS -o /dev/null -w "%{http_code} %{time_total}s" https://api.deepseek.com/models');
      await sh(sbx, `${template} npm install(npmmirror)`, 'mkdir -p /tmp/p && cd /tmp/p && npm init -y >/dev/null && npm i zod openai --registry=https://registry.npmmirror.com --no-audit --no-fund 2>&1 | tail -1', 300000);
      const t1 = Date.now();
      try { await sbx.files.write('/tmp/blob.bin', Buffer.alloc(5 * 1024 * 1024, 1)); rec(`${template} 上传 5MB`, true, { ms: Date.now() - t1 }); } catch (e) { rec(`${template} 上传 5MB`, false, { error: String(e.message || e).slice(0, 200) }); }
    } finally { await sbx.kill().catch(() => {}); }
  }
  console.log('SANDBOX_PROBE ' + JSON.stringify(out, null, 1));
  if (!out.some(r => r.name.startsWith('create') && r.ok)) process.exitCode = 1;
})();
