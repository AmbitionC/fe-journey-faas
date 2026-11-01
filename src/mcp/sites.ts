import type { Product } from './store';

/**
 * 两个产品各自的站点地址（owner 2026-11-01：两个产品各自独立、不互相耦合，只是底层共用一套账户与计费）。
 *
 * 后端对外给用户的任何链接——点数不足的充值链接、Key 报错的排查页、account_usage 里的管理页、
 * 支付宝付款后的回跳——都必须按调用来自哪个产品取，不能一律写 Agent Journey。
 * 此前全部写死 agent-journey.cn，Invest 用户点数用完会被引到 Agent Journey 去充值。
 *
 * Invest Journey 目前只有 Vercel 默认域名；以后绑自有域名只改这里一行。
 */
export interface Site {
  name: string;
  /** 站点根地址（不带末尾斜杠） */
  origin: string;
  /** Skill / 数据服务页：开通、建 Key、我的后台 */
  manage: string;
  /** 价格区锚点：点数不足 / 余额提醒里的充值链接 */
  recharge: string;
  /** 支付宝付款完成后的默认回跳页（页面会读 out_trade_no 主动查单） */
  payReturn: string;
  /** 允许前端指定的回跳页路径白名单（如 Agent Journey 的会员页）；不在表里的一律回默认页 */
  payReturnPaths: string[];
}

const site = (
  name: string,
  origin: string,
  path: string,
  extraReturnPaths: string[] = []
): Site => ({
  name,
  origin,
  manage: `${origin}${path}`,
  recharge: `${origin}${path}#pricing`,
  payReturn: `${origin}${path}`,
  payReturnPaths: [path, ...extraReturnPaths],
});

export const SITES: Record<Product, Site> = {
  agent: site('Agent Journey', 'https://www.agent-journey.cn', '/developer', [
    '/membership',
  ]),
  invest: site('Invest Journey', 'https://invest-journey.vercel.app', '/skills'),
};

/**
 * 付款回跳地址：站点 + 可选页面路径。路径只认白名单（防开放跳转），不认就回该站默认页。
 * Agent Journey 的会员页下单，付完要回会员页而不是开发者页。
 */
export function payReturnUrl(
  product?: Product | string | null,
  returnPath?: unknown
): string {
  const s = siteOf(product);
  const p = typeof returnPath === 'string' ? returnPath.split(/[?#]/)[0] : '';
  return s.payReturnPaths.includes(p) && p ? `${s.origin}${p}` : s.payReturn;
}

export function isProduct(x: unknown): x is Product {
  return x === 'agent' || x === 'invest';
}

/** 取站点；拿不到产品（老接口、没传参数）时按 Agent Journey，与改版前行为一致。 */
export function siteOf(product?: Product | string | null): Site {
  return SITES[isProduct(product) ? product : 'agent'];
}

/** 点数提醒里的充值链接：带来源参数，Skill 页打开后直接定位到价格并显示对应横幅。 */
export function rechargeLink(
  from: 'credit_low' | 'credit_exhausted',
  product?: Product | string | null
): string {
  return siteOf(product).recharge.replace('#', `?from=${from}#`);
}
