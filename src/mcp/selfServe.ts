import type { IncomingMessage, ServerResponse } from 'http';
import type { McpRuntime } from './http';
import {
  SKUS,
  TIERS,
  TRIAL_POINTS,
  currentPhase,
  phasePrice,
  PRICING_PHASES,
  TOOL_COST,
  effectiveTier,
  findSku,
  findSellableSku,
  payCode,
} from './billing';
import { checkPaid, pagePayUrl, queryTrade, verifyNotify } from './alipay';

/**
 * 自助开通与购买（/mcp/pricing、/mcp/me/*），以及管理端的订单/点数/看板（/mcp/admin/* 的计费部分）。
 *
 * 收款方式：
 * - 支付宝网页收款（配置了 ALIPAY_* 时）：下单即带付款链接，异步通知验签后自动发货，
 *   用户跳回时再主动查一次单兜底（见 ./alipay.ts）。
 * - 个人微信收款码（兜底）：用户自报「我已支付」+ 管理员人工确认到账后发货。
 * 两条路都只调 fulfill（幂等），handled_by 记 `alipay:<支付宝交易号>` 或管理员标识，后台据此区分渠道。
 */

const PAY_QR = 'https://www.agent-journey.cn/payment.png';

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

export function pricing(now = new Date(), alipay = false) {
  const phase = currentPhase(now);
  return {
    payChannels: alipay ? ['alipay', 'wechat_qr'] : ['wechat_qr'],
    currency: 'CNY',
    phase,
    phases: PRICING_PHASES,
    promo: phase.note,
    unit: '1 点 ≈ ¥0.1，Agent 与 Invest 两个服务共用余额',
    trialPoints: TRIAL_POINTS,
    tiers: Object.entries(TIERS).map(([id, t]) => ({ id, ...t })),
    skus: SKUS.map(s => ({
      sku: s.sku,
      name: s.name,
      kind: s.kind,
      tier: s.tier || null,
      months: s.months || null,
      points: s.points,
      // 当前阶段的售价；免费期为 0 且不开放购买（purchasable=false）
      price: phasePrice(s, phase.id) / 100,
      listPrice: s.listCents / 100,
      halfPrice: phasePrice(s, 'half') / 100,
      purchasable: phase.id !== 'free',
      desc: s.desc,
    })),
    toolCost: TOOL_COST,
    defaultToolCost: 1,
    chargeCalls: phase.id !== 'free',
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

function alipayUrlOf(rt: McpRuntime, o: any): string | null {
  if (!rt.alipay || !PAYABLE.includes(o.status)) return null;
  const sku = findSku(o.sku);
  return pagePayUrl(rt.alipay, {
    orderNo: o.order_no,
    amountCents: Number(o.amount_cents),
    subject: `Journey 开发者服务 · ${sku?.name || o.sku}`,
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
  await rt.billing.fulfill(o.order_no, `alipay:${c.tradeNo}`);
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
      const r = await rt.billing.fulfill(o.order_no, `alipay:${c.tradeNo}`);
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
  if (path === '/mcp/pricing' && method === 'GET')
    return send(res, 200, {
      success: true,
      data: pricing(now, !!rt.alipay),
    });

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
      const [keys, ledger, orders] = await Promise.all([
        rt.store.listByUser(userId),
        account ? rt.billing.ledgerOf(userId, 30) : Promise.resolve([]),
        rt.billing.ordersOf(userId),
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
          })),
          ledger,
          orders: orders.map(orderView),
        },
      });
    }

    if (path === '/mcp/me/activate' && method === 'POST') {
      const { created } = await rt.billing.activate(userId);
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
      return send(res, 200, {
        success: true,
        data: { key: created.key, prefix: created.prefix },
        message: 'Key 只显示这一次，请立即复制保存',
      });
    }

    if (path === '/mcp/me/keys/revoke' && method === 'POST') {
      const ok = await rt.store.revokeOwn(Number(data.id), userId);
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
      await rt.billing.activate(userId); // 下单即视为开通
      const amount = phasePrice(sku, phase.id);
      const o = await rt.billing.createOrder(userId, sku, amount);
      return send(res, 200, {
        success: true,
        data: {
          ...orderView({ ...o, created_at: o.created_at || null }),
          alipayUrl: alipayUrlOf(rt, o),
          qr: PAY_QR,
          howToPay: `微信扫码支付 ¥${(Number(o.amount_cents) / 100).toFixed(
            2
          )}，转账备注填写 ${payCode(o.order_no)}，付完点「我已支付」。`,
        },
      });
    }

    if (path === '/mcp/me/orders/paid' && method === 'POST') {
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
      if (rt.autoFulfill) await rt.billing.fulfill(orderNo, 'auto');
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
      const url = alipayUrlOf(rt, o);
      if (!url)
        return send(res, 400, {
          success: false,
          data: orderView(o),
          message: '订单已处理，无需再付款',
        });
      return send(res, 200, { success: true, data: { alipayUrl: url } });
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
    const r = await rt.billing.fulfill(
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
  if (path === '/mcp/admin/orders/reject' && method === 'POST') {
    const ok = await rt.billing.reject(
      String(data.orderNo || ''),
      await actor(),
      data.note
    );
    return {
      status: ok ? 200 : 404,
      body: { success: ok, message: ok ? '已驳回' : '订单不存在或已处理' },
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
