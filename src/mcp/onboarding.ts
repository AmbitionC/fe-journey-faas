import type { Product } from './store';
import { siteOf, rechargeLink as siteRechargeLink } from './sites';

/**
 * 新用户引导（2026-11-01）：报错按原因给修法、余额快用完提醒一次、account_usage 带首次使用引导。
 *
 * 只放纯函数，单测直接覆盖；调用点在 ./http.ts。
 */

/**
 * @deprecated 管理页按产品取：`siteOf(product).manage`（./sites.ts）。只给没有产品上下文的老调用方。
 */
export const DEVELOPER_URL = siteOf('agent').manage;
/** 点数提醒里的充值链接：按产品取站点，带来源参数，Skill 页打开后直接定位到价格并显示对应横幅 */
export const rechargeLink = (
  from: 'credit_low' | 'credit_exhausted',
  product: Product = 'agent'
) => siteRechargeLink(from, product);

/** 余额第一次跌破这个数时提醒一次（体验点 50，一次核心场景约 2~8 点） */
export const LOW_POINTS = 10;

const ENV: Record<Product, string> = {
  agent: 'AGENT_JOURNEY_API_KEY',
  invest: 'INVEST_JOURNEY_API_KEY',
};
const NAME: Record<Product, string> = {
  agent: 'Agent Journey',
  invest: 'Invest Journey',
};

export type AuthFailReason =
  | 'missing' // 请求头里没有 Key
  | 'env_unset' // 有请求头但是空的，或环境变量占位符没展开
  | 'bad_format' // 不是 jk_ 开头
  | 'invalid' // 格式对但查不到
  | 'revoked'; // 已吊销

/**
 * 判断请求头里的 Key 为什么不可用（extractKey 已返回 null 时调用）。
 * 插件的 .mcp.json 写的是 `Bearer ${XXX_API_KEY}`：环境变量没 export 或改完没重启客户端，
 * 发来的就是空串或原样的 `${…}`，这是新用户最常见的失败。
 */
export function missingKeyReason(
  headers: Record<string, any>
): 'missing' | 'env_unset' | 'bad_format' {
  const auth = headers['authorization'];
  const xKey = headers['x-api-key'];
  if (auth === undefined && xKey === undefined) return 'missing';
  const raw = String(auth ?? xKey ?? '')
    .replace(/^Bearer\b/i, '')
    .trim();
  if (
    !raw ||
    /^\$\{?[A-Za-z_]/.test(raw) ||
    raw === 'undefined' ||
    raw === 'null'
  )
    return 'env_unset';
  return 'bad_format';
}

/** 401 报错正文：说清原因 + 用户能自己做的下一步。 */
export function authHelp(reason: AuthFailReason, product: Product): string {
  const env = ENV[product];
  const manage = siteOf(product).manage;
  const restart = '改完要重启客户端（Claude Code 需退出后重新打开）才会生效。';
  switch (reason) {
    case 'env_unset':
      return (
        `没读到 API Key：环境变量 ${env} 没有生效。` +
        `在终端运行 echo $${env} 确认能看到 jk_ 开头的 Key；没有的话把 export ${env}=jk_你的key 加进 ~/.zshrc 或 ~/.bashrc。` +
        restart +
        `还没有 Key 的话到 ${manage} 登录开通并创建。`
      );
    case 'bad_format':
      return (
        'API Key 格式不对：应以 jk_ 开头，请求头写成 Authorization: Bearer jk_xxx。' +
        `检查 ${env} 是否复制完整、前后没有多余的引号或空格。Key 在 ${manage} 管理。`
      );
    case 'invalid':
      return (
        `API Key 不存在：可能复制不完整或输错了。到 ${manage} 登录后核对 Key 前缀；` +
        `明文只显示一次，找不到原文就新建一个，替换 ${env} 后重启客户端。`
      );
    case 'revoked':
      return `这个 API Key 已被吊销。到 ${manage} 新建一个，替换 ${env} 后重启客户端即可，点数余额不受影响。`;
    case 'missing':
    default:
      return (
        '缺少 API Key：请求头需要带 Authorization: Bearer jk_xxx。' +
        `到 ${manage} 登录后开通（新用户送体验点）并创建 Key，页面上会给出填好 Key 的安装命令。`
      );
  }
}

/** Key 有效但没开通这个产品（管理员手发的单产品 Key）。不提另一个产品。 */
export function scopeHelp(product: Product): string {
  return (
    `这个 Key 没有开通 ${NAME[product]} 的数据服务。` +
    `到 ${siteOf(product).manage} 登录后自助创建一个新 Key，替换 ${ENV[product]} 后重启客户端即可。`
  );
}

/**
 * 本次扣点后余额第一次跌破 LOW_POINTS 时返回提醒；否则 null。
 * 用「扣之前 ≥ 阈值、扣之后 < 阈值」判断，所以每次跌破只提醒一次（充值后再跌破会再提醒）。
 */
export function lowBalanceNotice(
  left: number,
  cost: number,
  product: Product = 'agent'
): string | null {
  if (cost <= 0 || left >= LOW_POINTS || left + cost < LOW_POINTS) return null;
  const runs = Math.floor(left / 3);
  return (
    `【Journey 提示】点数余额还剩 ${left} 点` +
    (runs > 0 ? `，大约还够 ${runs} 次简单查询` : '') +
    `。用完后调用会被暂停，可以到 ${rechargeLink(
      'credit_low',
      product
    )} 开通会员或买加油包，Key 不用换。` +
    '（请把这条提示转告用户一次，不必重复。）'
  );
}

export interface OnboardingExample {
  ask: string;
  /** 大约消耗的点数（按典型调用路径估算） */
  points: string;
}

const EXAMPLES: Record<Product, OnboardingExample[]> = {
  agent: [
    { ask: '讲讲 RAG 里的重排，要有出处。', points: '约 3 点' },
    {
      ask: '给我一道 Agent 记忆模块的实战题，做完帮我验收。',
      points: '约 2 点',
    },
    { ask: '下周面字节全栈，最近最常考什么？', points: '约 6~8 点' },
  ],
  invest: [
    { ask: '这个恐慌指数是怎么算的？有什么局限？', points: '不扣点' },
    { ask: '现在沪深300 贵不贵？市场情绪怎么样？', points: '约 2 点' },
    { ask: '把 2015 年以来的恐慌指数画出来。', points: '约 2 点' },
  ],
};

const CAN_DO: Record<Product, string> = {
  agent:
    '查前端 / AI 工程知识点（带出处）、按公司岗位整理真实面经高频题、领带验收标准的实战题卡、读完文章做自测。',
  invest:
    '看 A 股恐慌指数、宽基指数相对长期中枢的位置、短期偏离度排名、股息率和宏观数据，每个数都能查到计算方法。不提供买卖建议。',
};

/**
 * account_usage 里给体验用户的首次使用引导。会员不返回（不再需要）。
 * 只讲本产品：两个产品各自独立，不在一个产品的引导里推另一个（owner 2026-11-01）。
 */
export function onboardingFor(
  product: Product,
  tier: string,
  points: number
): Record<string, any> | null {
  if (tier !== 'free') return null;
  return {
    hint: '用户刚开始用时，用两三句话介绍能做什么、当前余额，并给出下面的示例问法让用户挑一个试，不要长篇介绍。',
    canDo: CAN_DO[product],
    balance:
      points > 0
        ? `体验点余额 ${points} 点（1 点约 ¥0.1，调用失败自动退点）`
        : `体验点已用完，开通会员或买加油包后继续：${rechargeLink(
            'credit_exhausted',
            product
          )}`,
    tryAsking: EXAMPLES[product],
  };
}

/** 两个 MCP 的 instructions 末尾共用的一句。 */
export const ONBOARDING_INSTRUCTIONS =
  '用户第一次使用、或问「能做什么 / 怎么用」时，先调 account_usage（不扣点）看余额和 onboarding 里的示例问法，用两三句话介绍；' +
  '工具结果里出现【Journey 提示】时原样转告用户一次。';
