import type { IncomingMessage, ServerResponse } from 'http';
import type { McpRuntime } from './http';
import {
  SKUS,
  TIERS,
  TRIAL_POINTS,
  DAY_PASS_TOOLS,
  currentPhase,
  phasePrice,
  PRICING_PHASES,
  toolCostFor,
  effectiveTier,
  findSku,
  findSellableSku,
  payCode,
  PAY_TEST_SKU,
  irisPricing,
  referralPricing,
} from './billing';
import {
  checkPaid,
  pagePayUrl,
  queryTrade,
  verifyNotify,
  withinAlipayLimit,
} from './alipay';
import { track } from './analytics';
import { describeEntry, entryProps, sanitizeEntry } from './attribution';
import { notifySafely, PayEvent } from './payNotify';
import type { Product } from './store';
import { isProduct, payReturnUrl, siteOf } from './sites';

/**
 * 自助开通与购买（/mcp/pricing、/mcp/me/*），以及管理端的订单/点数/看板（/mcp/admin/* 的计费部分）。
 *
 * 收款方式：
 * - 支付宝网页收款（配置了 ALIPAY_* 时）：下单即带付款链接，异步通知验签后自动发货，
 *   用户跳回时再主动查一次单兜底（见 ./alipay.ts）。
 * - 个人微信收款码：已关闭（owner 2026-11-04「微信没有后台检验，微信的付费通道都先关闭」）。
 *   超过支付宝单笔限额的商品（年卡）标「暂时缺货」、不能下单；用户自报「我已支付」接口一律拒绝。
 *   以前下的微信单管理员仍可在后台人工确认发放。要重开把 WECHAT_QR_ENABLED 改回 true。
 * 两条路都只调 fulfill（幂等），handled_by 记 `alipay:<支付宝交易号>` 或管理员标识，后台据此区分渠道。
 */

const PAY_QR = 'https://www.agent-journey.cn/payment.png';
export const WECHAT_QR_ENABLED = false;
export const SOLD_OUT_MESSAGE = '该商品暂时缺货，可以先选其他套餐';

/** 没有可用收款方式的商品（未开通支付宝，或超过支付宝单笔限额且微信已关）显示缺货。 */
export function soldOut(
  amountCents: number,
  alipay: boolean,
  alipayMaxCents: number
): boolean {
  if (WECHAT_QR_ENABLED) return false;
  if (!alipay) return true;
  return alipayMaxCents > 0 && amountCents > alipayMaxCents;
}

function send(res: ServerResponse, status: number, body: any) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function parse(body: Buffer): any {
  try {
    return JSON.parse(body.toString('utf8') || '{}');
  } catch {
    return null;
  }
}

/**
 * 公开价目。传 product 时只下发该产品的工具价目与它自己站点的充值链接——
 * 两个站各自只讲自己（owner 2026-11-01）；不传时与旧行为一致（全部工具、Agent 站链接）。
 */
export function pricing(
  now = new Date(),
  alipay = false,
  alipayMaxCents = 0,
  product: Product | null = null
) {
  const phase = currentPhase(now);
  return {
    payChannels: [
      ...(alipay ? ['alipay'] : []),
      ...(WECHAT_QR_ENABLED ? ['wechat_qr'] : []),
    ],
    // 支付宝单笔限额（元）；null＝不限或未开通支付宝。超过的商品 soldOut=true。
    alipayMaxYuan: alipay && alipayMaxCents > 0 ? alipayMaxCents / 100 : null,
    currency: 'CNY',
    phase,
    // 免费那一天（10-31）过去后不再在时间线上展示
    phases: PRICING_PHASES.filter(p => p.id !== 'free' || phase.id === 'free'),
    promo: phase.note,
    // 文案不提另一个产品：余额共用是实现细节，不是卖点
    unit:
      product === 'invest'
        ? '1 点 ≈ ¥0.1，按调用扣点，失败自动退点；历史序列（恐慌、乖离率、宏观）同一天只扣一次'
        : '1 点 ≈ ¥0.1，按调用扣点，失败自动退点',
    dayPassTools: product === 'invest' ? DAY_PASS_TOOLS : [],
    trialPoints: TRIAL_POINTS,
    trialNote: `新用户开通即送 ${TRIAL_POINTS} 点体验额度，用完需开通会员或购买加油包`,
    product,
    rechargeUrl: siteOf(product).recharge,
    tiers: Object.entries(TIERS).map(([id, t]) => ({ id, ...t })),
    skus: SKUS.map(s => ({
      sku: s.sku,
      name: s.name,
      kind: s.kind,
      tier: s.tier || null,
      months: s.months || null,
      points: s.points,
      // 当前阶段的售价（只有 2026-10-31 公测免费那一天为 0 且不开放购买）
      price: phasePrice(s, phase.id) / 100,
      listPrice: s.listCents / 100,
      halfPrice: phasePrice(s, 'half') / 100,
      purchasable:
        phase.id !== 'free' &&
        !soldOut(phasePrice(s, phase.id), alipay, alipayMaxCents),
      soldOut: soldOut(phasePrice(s, phase.id), alipay, alipayMaxCents),
      desc: s.desc,
    })),
    toolCost: toolCostFor(product),
    defaultToolCost: 1,
    chargeCalls: phase.id !== 'free',
    // 网站 Iris 的计点口径与邀请奖励（前端只读这里，不写死数字）
    iris: irisPricing(),
    referral: referralPricing(),
  };
}

function orderView(o: any) {
  const sku = findSku(o.sku);
  return {
    orderNo: o.order_no,
    sku: o.sku,
    name: sku?.name || o.sku,
    amount: Number(o.amount_cents) / 100,
    status: o.status,
    payCode: payCode(o.order_no),
    createdAt: o.created_at,
    reportedAt: o.reported_at || null,
    paidAt: o.paid_at || null,
    paidVia: o.status === 'paid' ? paidVia(o.handled_by) : null,
  };
}

function paidVia(handledBy?: string | null): 'alipay' | 'manual' | 'auto' {
  if (handledBy && handledBy.startsWith('alipay:')) return 'alipay';
  return handledBy === 'auto' ? 'auto' : 'manual';
}

const PAYABLE = ['pending', 'self_reported'];

/** 超过支付宝单笔限额的订单（如年卡）不给支付宝链接（微信已关，这类商品下单前就标缺货）。 */
function alipayOverLimit(rt: McpRuntime, o: any): boolean {
  return !!rt.alipay && !withinAlipayLimit(rt.alipay, Number(o.amount_cents));
}

/**
 * 发货的唯一入口（支付宝通知、跳回查单、管理员确认、自报即发都走这里），
 * 真正发货（'ok'）时记 order_paid，重复确认不重复记。
 */
/** 下单时记下的来源；埋点没装配或查不到都返回 null，绝不影响发货。 */
async function orderSource(rt: McpRuntime, orderNo: string) {
  try {
    return (await rt.analytics?.orderEntry?.(orderNo)) || null;
  } catch {
    return null;
  }
}

async function fulfillTracked(rt: McpRuntime, orderNo: string, actor: string) {
  const r = await rt.billing.fulfill(orderNo, actor);
  if (r === 'ok') {
    const o = await rt.billing.getOrder(orderNo).catch(() => null);
    // 受邀者开通会员 → 邀请人加点（只认 plan SKU；加油包不算「成为会员」）
    if (o && rt.referral && findSku(o.sku)?.kind === 'plan') {
      const bonus = await rt.referral
        .onMemberPaid(String(o.user_id))
        .catch(() => null);
      if (bonus) {
        await track(rt, {
          event: 'referral_member',
          userId: bonus.inviter,
          props: { invitee: String(o.user_id), points: bonus.points, orderNo },
        });
      }
    }
    // 下单时记下的来源，跟着到账事件和收款提醒一起走（查不到不影响发货）
    const src = await orderSource(rt, orderNo);
    // 收款提醒：只提醒支付宝到账（管理员手动确认是站长自己点的；自报即发在自报那一步已提醒）
    if (o && actor.startsWith('alipay:'))
      await notifySafely(rt.payNotify, {
        ...payEventOf(o, 'paid', 'alipay'),
        source: describeEntry(src?.entry),
      });
    await track(rt, {
      event: 'order_paid',
      userId: o?.user_id || null,
      product: (src?.site as any) || null,
      props: {
        orderNo,
        sku: o?.sku || null,
        amountCents: o ? Number(o.amount_cents) : null,
        channel: paidVia(actor),
        site: src?.site || null,
        ...entryProps(src?.entry || null),
      },
    });
  }
  return r;
}

function payEventOf(
  o: any,
  kind: PayEvent['kind'],
  channel: PayEvent['channel']
): PayEvent {
  return {
    kind,
    channel,
    orderNo: String(o.order_no),
    sku: String(o.sku),
    skuName: findSku(o.sku)?.name || String(o.sku),
    amountCents: Number(o.amount_cents),
    userId: o.user_id ? String(o.user_id) : null,
  };
}

/** 开通：只在真正新建账户时记 account_activated + trial_granted。 */
async function trackActivation(
  rt: McpRuntime,
  userId: string,
  created: boolean,
  via: 'activate' | 'order'
) {
  if (!created) return;
  await track(rt, {
    event: 'account_activated',
    userId,
    props: { created, via },
  });
  await track(rt, {
    event: 'trial_granted',
    userId,
    props: { points: TRIAL_POINTS },
  });
}

/** 下单 / 取链接时前端带的来源站点，只认两个产品，其余按 Agent Journey。 */
function siteParam(data: any): Product {
  return isProduct(data?.site) ? data.site : 'agent';
}

function alipayUrlOf(
  rt: McpRuntime,
  o: any,
  site: Product = 'agent',
  returnPath?: unknown
): string | null {
  if (!rt.alipay || !PAYABLE.includes(o.status)) return null;
  if (alipayOverLimit(rt, o)) return null;
  const sku = findSku(o.sku);
  return pagePayUrl(rt.alipay, {
    orderNo: o.order_no,
    amountCents: Number(o.amount_cents),
    subject: `${siteOf(site).name} 会员与点数 · ${sku?.name || o.sku}`,
    // 付完回到下单的那个站、那一页（白名单内），不再一律回 Agent Journey 的开发者页
    returnUrl: payReturnUrl(site, returnPath),
  });
}

/** 主动查单并在确认到账时发货；通知与查单同时到也只会发一次（fulfill 幂等）。 */
async function syncAlipay(rt: McpRuntime, o: any) {
  const r = await queryTrade(rt.alipay!, o.order_no);
  if (r.code !== '10000') {
    // ACQ.TRADE_NOT_EXIST：用户还没扫码付款，不是错误
    return { paid: false, reason: r.sub_code || r.code };
  }
  const c = checkPaid(rt.alipay!, r, o);
  if (!c.ok) {
    if (c.reason === 'amount_mismatch')
      console.error('[mcp] 支付宝查单金额不符', o.order_no, r.total_amount);
    return { paid: false, reason: c.reason };
  }
  await fulfillTracked(rt, o.order_no, `alipay:${c.tradeNo}`);
  return { paid: true, reason: 'ok' };
}

/**
 * POST /mcp/pay/alipay/notify：支付宝服务器回调（application/x-www-form-urlencoded）。
 * 必须回纯文本 success，否则支付宝会在 25 小时内重复推送；验签失败回 failure。
 */
export async function handleAlipayNotify(
  res: ServerResponse,
  rt: McpRuntime,
  body: Buffer,
  method: string
) {
  const text = (code: number, s: string) => {
    res.statusCode = code;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(s);
  };
  if (!rt.alipay) return text(404, 'alipay disabled');
  if (method !== 'POST') return text(405, 'failure');
  const params: Record<string, string> = {};
  new URLSearchParams(body.toString('utf8')).forEach((v, k) => {
    params[k] = v;
  });
  if (!verifyNotify(rt.alipay, params)) {
    console.error('[mcp] 支付宝通知验签失败', params.out_trade_no);
    return text(200, 'failure');
  }
  try {
    const o = await rt.billing.getOrder(String(params.out_trade_no || ''));
    const c = checkPaid(rt.alipay, params, o);
    if (c.ok) {
      const r = await fulfillTracked(rt, o.order_no, `alipay:${c.tradeNo}`);
      if (r === 'already' && o.status === 'rejected')
        console.error('[mcp] 已驳回订单收到支付宝付款，需人工退款', o.order_no);
    } else if (
      c.reason === 'amount_mismatch' ||
      c.reason === 'app_id_mismatch'
    ) {
      console.error('[mcp] 支付宝通知不可发货', c.reason, params.out_trade_no);
    }
    // 交易关闭、待付款等非成功状态也回 success：这条通知已处理完，不需要支付宝再推
    return text(200, 'success');
  } catch (e: any) {
    // 库暂时不可用：回 failure 让支付宝稍后重推
    console.error('[mcp] 支付宝通知处理失败', e?.message);
    return text(200, 'failure');
  }
}

export async function handleSelfServe(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  rt: McpRuntime,
  body: Buffer,
  method: string
) {
  const path = url.pathname.replace(/\/+$/, '');
  const now = rt.now ? rt.now() : new Date();
  if (path === '/mcp/pricing' && method === 'GET') {
    const p = url.searchParams.get('product');
    return send(res, 200, {
      success: true,
      data: pricing(
        now,
        !!rt.alipay,
        rt.alipay?.maxCents || 0,
        isProduct(p) ? p : null
      ),
    });
  }

  const userId = await rt.userIdOf(req.headers as any);
  if (!userId) return send(res, 401, { success: false, message: '请先登录' });
  const data = method === 'POST' ? parse(body) : {};
  if (data === null)
    return send(res, 400, { success: false, message: '请求体不是合法 JSON' });

  try {
    // 后台总览：账户、Key、最近流水与订单。未开通时 account 为 null，前端引导点「开通」。
    if (path === '/mcp/me' && method === 'GET') {
      const account = await rt.billing.getAccount(userId);
      const tier = effectiveTier(account);
      const [keys, ledger, orders, admin] = await Promise.all([
        rt.store.listByUser(userId),
        account ? rt.billing.ledgerOf(userId, 30) : Promise.resolve([]),
        rt.billing.ordersOf(userId),
        rt.alipay
          ? rt.isAdmin(req.headers as any).catch(() => false)
          : Promise.resolve(false),
      ]);
      return send(res, 200, {
        success: true,
        data: {
          phase: currentPhase(now),
          activated: !!account,
          account: account
            ? {
                points: account.points,
                tier,
                tierName: TIERS[tier].name,
                tierExpireAt: account.active ? account.tier_expire_at : null,
                nextGrantAt: account.active ? account.next_grant_at : null,
                monthlyPoints: account.active ? account.monthly_points : 0,
                maxKeys: TIERS[tier].maxKeys,
                dailyLimit: TIERS[tier].dailyLimit,
              }
            : null,
          keys: keys.map(k => ({
            id: k.id,
            prefix: k.key_prefix,
            name: k.note,
            status: k.status,
            createdAt: k.created_at,
            lastUsedAt: k.last_used_at,
            connectedAt: k.connected_at || null,
            // 'oauth'＝在客户端里授权登录自动发的，不占手动建 Key 名额
            via: k.kind === 'oauth' ? 'oauth' : 'manual',
          })),
          ledger,
          orders: orders.map(orderView),
          // 管理员可下 1 分钱支付宝测试单（正式收费前验证收银台与到账通知）
          canTestPay: admin,
        },
      });
    }

    if (path === '/mcp/me/activate' && method === 'POST') {
      const { created } = await rt.billing.activate(userId);
      await trackActivation(rt, userId, created, 'activate');
      return send(res, 200, {
        success: true,
        data: { created, trialPoints: created ? TRIAL_POINTS : 0 },
        message: created
          ? `已开通，赠送 ${TRIAL_POINTS} 点体验额度`
          : '已开通过',
      });
    }

    if (path === '/mcp/me/keys' && method === 'POST') {
      const account = await rt.billing.getAccount(userId);
      if (!account)
        return send(res, 400, {
          success: false,
          message: '请先开通开发者服务',
        });
      const tier = effectiveTier(account);
      const n = await rt.store.countActiveByUser(userId);
      if (n >= TIERS[tier].maxKeys) {
        return send(res, 400, {
          success: false,
          message: `${TIERS[tier].name}档最多 ${
            TIERS[tier].maxKeys
          } 个有效 Key，请先吊销不用的${tier === 'free' ? '或开通会员' : ''}`,
        });
      }
      const created = await rt.store.create({
        scope: 'all',
        owner: `user:${userId}`,
        note: String(data.name || '').slice(0, 60) || '我的 Key',
        dailyLimit: TIERS[tier].dailyLimit,
        userId,
      });
      await track(rt, {
        event: 'key_created',
        userId,
        props: { tier, activeKeys: n + 1 },
      });
      return send(res, 200, {
        success: true,
        data: { key: created.key, prefix: created.prefix },
        message: 'Key 只显示这一次，请立即复制保存',
      });
    }

    if (path === '/mcp/me/keys/revoke' && method === 'POST') {
      const ok = await rt.store.revokeOwn(Number(data.id), userId);
      if (ok)
        await track(rt, {
          event: 'key_revoked',
          userId,
          props: { keyId: Number(data.id) },
        });
      return send(res, ok ? 200 : 404, {
        success: ok,
        message: ok ? '已吊销' : 'Key 不存在',
      });
    }

    if (path === '/mcp/me/orders' && method === 'POST') {
      const sku = findSellableSku(String(data.sku || ''));
      if (!sku)
        return send(res, 400, { success: false, message: '商品不存在' });
      const phase = currentPhase(now);
      if (phase.id === 'free')
        return send(res, 400, {
          success: false,
          message: phase.next
            ? `公测免费期内调用不扣点，无需购买。${phase.next.from} 起${phase.next.name}。`
            : '公测免费期内调用不扣点，无需购买。',
        });
      const act = await rt.billing.activate(userId); // 下单即视为开通
      await trackActivation(rt, userId, !!act?.created, 'order');
      const amount = phasePrice(sku, phase.id);
      if (soldOut(amount, !!rt.alipay, rt.alipay?.maxCents || 0))
        return send(res, 400, {
          success: false,
          code: 'sold_out',
          message: SOLD_OUT_MESSAGE,
        });
      const site = siteParam(data);
      const entry = sanitizeEntry(data.entry);
      const o = await rt.billing.createOrder(userId, sku, amount);
      await track(rt, {
        event: 'order_created',
        userId,
        product: site,
        anonId: entry?.anonId || null,
        props: {
          orderNo: o.order_no,
          sku: sku.sku,
          amountCents: Number(o.amount_cents),
          listCents: sku.listCents,
          phase: phase.id,
          reused: !!o.reused,
          site,
          ...entryProps(entry),
        },
      });
      const payUrl = alipayUrlOf(rt, o, site, data.returnPath);
      if (payUrl)
        await track(rt, {
          event: 'pay_link_issued',
          userId,
          props: { orderNo: o.order_no, channel: 'alipay' },
        });
      return send(res, 200, {
        success: true,
        data: {
          ...orderView({ ...o, created_at: o.created_at || null }),
          alipayUrl: payUrl,
          ...(WECHAT_QR_ENABLED
            ? {
                qr: PAY_QR,
                howToPay: `微信扫码支付 ¥${(
                  Number(o.amount_cents) / 100
                ).toFixed(2)}，转账备注填写 ${payCode(
                  o.order_no
                )}，付完点「我已支付」。`,
              }
            : {}),
        },
      });
    }

    if (path === '/mcp/me/orders/paid' && method === 'POST') {
      if (!WECHAT_QR_ENABLED)
        return send(res, 410, {
          success: false,
          code: 'wechat_closed',
          message: '微信收款已关闭，请用支付宝付款',
        });
      const orderNo = String(data.orderNo || '');
      const ok = await rt.billing.reportPaid(orderNo, userId);
      if (!ok) {
        const o = await rt.billing.getOrder(orderNo);
        if (!o || o.user_id !== userId)
          return send(res, 404, { success: false, message: '订单不存在' });
        return send(res, 200, {
          success: true,
          data: orderView(o),
          message: '订单状态已更新过',
        });
      }
      await track(rt, {
        event: 'order_reported',
        userId,
        props: { orderNo, channel: 'wechat_qr' },
      });
      const reported = await rt.billing.getOrder(orderNo);
      if (reported) {
        const src = await orderSource(rt, orderNo);
        await notifySafely(rt.payNotify, {
          ...payEventOf(reported, 'reported', 'wechat'),
          source: describeEntry(src?.entry),
        });
      }
      if (rt.autoFulfill) await fulfillTracked(rt, orderNo, 'auto');
      const o = await rt.billing.getOrder(orderNo);
      return send(res, 200, {
        success: true,
        data: orderView(o),
        message: rt.autoFulfill
          ? '已到账发放'
          : '已收到你的支付声明，核对到账后自动发放（通常 12 小时内）',
      });
    }

    // 点「支付宝付款」时现取一条新签的链接（同一订单号重复付款支付宝会关联到原单，不会扣两次）
    if (path === '/mcp/me/orders/alipay' && method === 'POST') {
      if (!rt.alipay)
        return send(res, 400, { success: false, message: '支付宝收款未开通' });
      const o = await rt.billing.getOrder(String(data.orderNo || ''));
      if (!o || o.user_id !== userId)
        return send(res, 404, { success: false, message: '订单不存在' });
      const url = alipayUrlOf(rt, o, siteParam(data), data.returnPath);
      if (!url)
        return send(res, 400, {
          success: false,
          data: orderView(o),
          message:
            PAYABLE.includes(o.status) && alipayOverLimit(rt, o)
              ? `该笔 ¥${(Number(o.amount_cents) / 100).toFixed(
                  2
                )} 超过支付宝单笔限额 ¥${(rt.alipay!.maxCents / 100).toFixed(
                  0
                )}，${WECHAT_QR_ENABLED ? '请改用微信扫码' : '暂时缺货'}`
              : '订单已处理，无需再付款',
        });
      await track(rt, {
        event: 'pay_link_issued',
        userId,
        props: { orderNo: o.order_no, sku: o.sku, channel: 'alipay' },
      });
      return send(res, 200, { success: true, data: { alipayUrl: url } });
    }

    // 管理员专用：下一笔 ¥0.01 支付宝测试单（不受免费期限制、不发点、不计营收），
    // 付款后与正式订单走同一条通知 / 查单 / 发货链路。
    if (path === '/mcp/me/orders/alipay/test' && method === 'POST') {
      if (!rt.alipay)
        return send(res, 400, { success: false, message: '支付宝收款未开通' });
      if (!(await rt.isAdmin(req.headers as any)))
        return send(res, 403, {
          success: false,
          message: '仅管理员可下测试单',
        });
      await rt.billing.activate(userId);
      const o = await rt.billing.createOrder(
        userId,
        PAY_TEST_SKU,
        PAY_TEST_SKU.listCents
      );
      return send(res, 200, {
        success: true,
        data: {
          ...orderView({ ...o, created_at: o.created_at || null }),
          alipayUrl: alipayUrlOf(rt, o),
        },
      });
    }

    // 付完跳回官网时调用：主动向支付宝查单，到账即发货（不依赖异步通知是否已到）
    if (path === '/mcp/me/orders/alipay/sync' && method === 'POST') {
      if (!rt.alipay)
        return send(res, 400, { success: false, message: '支付宝收款未开通' });
      const o = await rt.billing.getOrder(String(data.orderNo || ''));
      if (!o || o.user_id !== userId)
        return send(res, 404, { success: false, message: '订单不存在' });
      if (o.status === 'paid')
        return send(res, 200, { success: true, data: orderView(o) });
      const r = PAYABLE.includes(o.status)
        ? await syncAlipay(rt, o)
        : { paid: false, reason: o.status };
      const now = await rt.billing.getOrder(o.order_no);
      return send(res, 200, {
        success: true,
        data: orderView(now),
        message: r.paid ? '已到账发放' : '暂未查到付款，付完稍等几秒再刷新',
      });
    }

    if (path === '/mcp/me/orders' && method === 'GET') {
      return send(res, 200, {
        success: true,
        data: (await rt.billing.ordersOf(userId)).map(orderView),
      });
    }
  } catch (e: any) {
    return send(res, 500, {
      success: false,
      message: (e && e.message) || '内部错误',
    });
  }
  return send(res, 404, { success: false, message: 'not found' });
}

/** 管理端计费接口；不是计费路径时返回 null 交回 handleAdmin。调用方已校验 admin。 */
export async function handleBillingAdmin(
  path: string,
  method: string,
  url: URL,
  data: any,
  rt: McpRuntime,
  req: IncomingMessage
): Promise<{ status: number; body: any } | null> {
  const actor = () =>
    rt.adminIdOf ? rt.adminIdOf(req.headers as any) : Promise.resolve('admin');
  if (path === '/mcp/admin/orders' && method === 'GET') {
    const status = url.searchParams.get('status') || undefined;
    const rows = await rt.billing.listOrders(
      status,
      Number(url.searchParams.get('limit') || 100)
    );
    return {
      status: 200,
      body: {
        success: true,
        data: rows.map((o: any) => ({
          ...orderView(o),
          userId: o.user_id,
          handledBy: o.handled_by,
          note: o.note,
        })),
      },
    };
  }
  if (path === '/mcp/admin/orders/confirm' && method === 'POST') {
    const r = await fulfillTracked(
      rt,
      String(data.orderNo || ''),
      await actor()
    );
    const msg = {
      ok: '已确认到账并发放',
      already: '该订单已处理过，未重复发放',
      not_found: '订单不存在',
    }[r];
    return {
      status: r === 'not_found' ? 404 : 200,
      body: { success: r !== 'not_found', result: r, message: msg },
    };
  }
  // 收款提醒自检：用一张假订单走一遍短信 / 邮件通道（标【测试】，不碰订单表）
  if (path === '/mcp/admin/pay-notify/test' && method === 'POST') {
    if (!rt.payNotify)
      return {
        status: 200,
        body: { success: false, message: '收款提醒未装配' },
      };
    const r = await rt.payNotify.notify({
      kind: data.kind === 'reported' ? 'reported' : 'paid',
      channel: data.kind === 'reported' ? 'wechat' : 'alipay',
      orderNo: 'SELFTEST',
      sku: 'pay_test',
      skuName: '收款提醒自检',
      amountCents: 1,
      userId: null,
    });
    return { status: 200, body: { success: true, data: r } };
  }
  if (path === '/mcp/admin/orders/reject' && method === 'POST') {
    const ok = await rt.billing.reject(
      String(data.orderNo || ''),
      await actor(),
      data.note
    );
    if (ok)
      await track(rt, {
        event: 'order_rejected',
        props: { orderNo: String(data.orderNo || '') },
      });
    return {
      status: ok ? 200 : 404,
      body: { success: ok, message: ok ? '已驳回' : '订单不存在或已处理' },
    };
  }
  // 管理员赠送会员（2026-11-03 owner：自己的账号也走真实会员，不再靠「管理员视为会员」旁路）。
  // 走与付费开通同一个 applyPlan（顺延/新开同口径、发月度点数），不建订单＝不进收入统计。
  if (path === '/mcp/admin/member/grant' && method === 'POST') {
    const userId = String(data.userId || '').trim();
    const months = Math.trunc(Number(data.months));
    const base = findSku('member_month');
    if (!userId || !base || !(months >= 1 && months <= 120)) {
      return {
        status: 400,
        body: { success: false, message: '需要 userId 与 months（1~120）' },
      };
    }
    await rt.billing.applyPlan(
      userId,
      { ...base, months },
      `admin_grant:${await actor()}${
        data.note ? `:${String(data.note).slice(0, 40)}` : ''
      }`
    );
    return {
      status: 200,
      body: { success: true, data: await rt.billing.getAccount(userId) },
    };
  }
  if (path === '/mcp/admin/points/grant' && method === 'POST') {
    const userId = String(data.userId || '').trim();
    const points = Math.trunc(Number(data.points));
    if (!userId || !points || Math.abs(points) > 100000) {
      return {
        status: 400,
        body: {
          success: false,
          message: '需要 userId 与非零 points（绝对值 ≤100000）',
        },
      };
    }
    await rt.billing.addPoints(
      userId,
      points,
      'admin',
      await actor(),
      String(data.note || '管理员调整')
    );
    return {
      status: 200,
      body: { success: true, data: await rt.billing.getAccount(userId) },
    };
  }
  if (path === '/mcp/admin/stats' && method === 'GET') {
    return {
      status: 200,
      body: {
        success: true,
        data: await rt.billing.stats(
          Number(url.searchParams.get('days') || 30)
        ),
      },
    };
  }
  return null;
}
