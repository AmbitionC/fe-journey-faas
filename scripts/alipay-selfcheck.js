/* global fetch */
/**
 * 部署后支付宝收款自检（deploy.yml 调用，不阻断部署）。
 *
 * 用与线上同一套环境变量查一笔不存在的订单，回答三个问题：
 * 1. 三项配置是否齐、私钥能否解析；
 * 2. 应用私钥是否被支付宝认出（签名没被拒）＝私钥与开放平台登记的应用公钥是一对；
 * 3. 支付宝响应能否用 ALIPAY_PUBLIC_KEY 验签＝支付宝公钥填对了。
 * 线上 /mcp/pricing 的 payChannels 一并核对。只输出非机密信息。
 *
 * 用法：npm run build 之后 node scripts/alipay-selfcheck.js [函数地址]
 */
const fs = require('fs');
// eslint-disable-next-line node/no-unpublished-require
const { loadAlipayConfig, selfCheck } = require('../dist/mcp/alipay');

const lines = [];
const say = s => {
  lines.push(s);
  console.log(s);
};

async function pricingChannels(base) {
  if (!base) return null;
  try {
    const r = await fetch(`${base.replace(/\/$/, '')}/mcp/pricing`);
    const body = await r.json();
    return (body.data || body).payChannels || null;
  } catch (e) {
    return `查询失败：${e.message}`;
  }
}

(async () => {
  say('### 支付宝收款自检');
  let cfg = null;
  try {
    cfg = loadAlipayConfig(process.env);
    if (!cfg)
      say(
        '- 未配置（APPID / 应用私钥 / 支付宝公钥缺一项），网站只显示微信收款码'
      );
  } catch (e) {
    say(`- ❌ 私钥或支付宝公钥无法解析：${e.message}`);
  }
  if (cfg) {
    const r = await selfCheck(cfg);
    say(`- APPID：${r.appId}`);
    say(`- 网关：${r.gateway}`);
    say(
      `- 由应用私钥推出的应用公钥指纹（sha256 前 16 位）：\`${r.appPublicKeySha256}\``
    );
    if (r.error) {
      say(`- ⚠️ 未能连上支付宝网关：${r.error}`);
    } else {
      say(`- 支付宝返回：${r.code} ${r.subCode || ''} ${r.subMsg || ''}`);
      say(
        r.signatureAccepted
          ? '- ✅ 应用私钥被支付宝认出（签名未被拒）'
          : '- ❌ 签名被拒：应用私钥与开放平台登记的应用公钥不是一对，或 APPID 填错'
      );
      say(
        r.responseVerified
          ? '- ✅ 支付宝响应验签通过（支付宝公钥填对了）'
          : '- ❌ 支付宝响应验签不过：ALIPAY_PUBLIC_KEY 可能填成了应用公钥'
      );
      if (r.subCode === 'ACQ.TRADE_NOT_EXIST')
        say('- ✅ 查单链路正常（查无此单＝预期结果）');
    }
  }
  const ch = await pricingChannels(process.argv[2]);
  if (ch) say(`- 线上 /mcp/pricing payChannels：${JSON.stringify(ch)}`);
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
})();
