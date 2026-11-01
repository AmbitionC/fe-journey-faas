import type { IncomingMessage, ServerResponse } from 'http';
import { handleMessage, RpcError, ServerSpec } from './protocol';
import {
  McpStore,
  ApiKeyRow,
  Product,
  KeyScope,
  extractKey,
  scopeAllows,
} from './store';
import { agentServer, AgentDeps, AGENT_MODULES } from './tools/agent';
import { investServer, InvestDeps } from './tools/invest';
import {
  BillingStore,
  TIERS,
  currentPhase,
  effectiveTier,
  toolCost,
  creditExhaustedMessage,
  RECHARGE_URL,
} from './billing';
import {
  handleSelfServe,
  handleBillingAdmin,
  handleAlipayNotify,
} from './selfServe';
import { AlipayConfig, loadAlipayConfig } from './alipay';

/**
 * MCP 的 HTTP 适配层（server.js 在 Midway 之外直接分流 /mcp/* 到这里）。
 *
 * 端点：
 * - POST /mcp/agent   Agent Journey 工具（Streamable HTTP 无状态模式，只回 application/json）
 * - POST /mcp/invest  Invest Journey 工具
 * - /mcp/pricing      公开价目表
 * - /mcp/me/*         自助后台：开通、Key、下单、余额与流水（平台用户登录态）
 * - /mcp/admin/*      管理端：发 Key / 吊销 / 用量 / 订单确认 / 加点 / 经营看板（平台 admin 登录态）
 * - POST /mcp/pay/alipay/notify  支付宝异步通知（验签后自动发货，无登录态）
 *
 * 为什么绕开 Midway：MCP 客户端要求精确的状态码语义（202 / 405 / 401），
 * 且 /invest/* 的鉴权中间件要求平台 admin，与 API Key 鉴权是两套体系，单独一路最干净。
 */

export interface McpRuntime {
  store: McpStore;
  agentDeps(row: ApiKeyRow): AgentDeps;
  investDeps(row: ApiKeyRow): InvestDeps;
  isAdmin(headers: Record<string, any>): Promise<boolean>;
  billing: BillingStore;
  /** 平台登录态 → userId；未登录返回 null */
  userIdOf(headers: Record<string, any>): Promise<string | null>;
  /** 管理员标识（确认订单留痕用） */
  adminIdOf?(headers: Record<string, any>): Promise<string>;
  /** 用户点「我已支付」后是否直接发货（默认否：等管理员确认到账） */
  autoFulfill?: boolean;
  /** 当前时间（决定收费阶段）；单测注入 */
  now?: () => Date;
  /** 支付宝网页收款配置；未配置为 null，只走微信收款码 */
  alipay?: AlipayConfig | null;
}

const SPECS: Record<Product, ServerSpec<any>> = {
  agent: agentServer,
  invest: investServer,
};
const MAX_BODY = 1024 * 1024;
const KEY_HELP =
  '缺少或无效的 API Key：请在请求头带 Authorization: Bearer jk_xxx（登录 https://www.agent-journey.cn/developer 开通并创建 Key）。';

function setCors(res: ServerResponse) {
  // 纯 Bearer 鉴权、不用 Cookie，放开任意来源（浏览器内的 MCP 客户端也能连）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type,Authorization,X-API-Key,Accept,Mcp-Session-Id,Mcp-Protocol-Version,token'
  );
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res: ServerResponse, status: number, body: any) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function rpcErr(code: number, message: string, id: any = null) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function productOf(pathname: string): Product | null {
  const p = pathname.replace(/\/+$/, '');
  if (p === '/mcp/agent') return 'agent';
  if (p === '/mcp/invest') return 'invest';
  return null;
}

export async function handleMcpHttp(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  rt: McpRuntime,
  body: Buffer
): Promise<void> {
  setCors(res);
  const method = (req.method || 'GET').toUpperCase();
  if (method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (url.pathname.replace(/\/+$/, '') === '/mcp/pay/alipay/notify')
    return handleAlipayNotify(res, rt, body, method);
  if (url.pathname.startsWith('/mcp/admin/'))
    return handleAdmin(req, res, url, rt, body, method);
  if (url.pathname === '/mcp/pricing' || url.pathname.startsWith('/mcp/me'))
    return handleSelfServe(req, res, url, rt, body, method);

  const product = productOf(url.pathname);
  if (!product)
    return sendJson(res, 404, {
      error: 'not found，可用端点：/mcp/agent、/mcp/invest',
    });

  if (method !== 'POST') {
    // 无状态模式不提供 GET SSE 流，也没有会话可删
    res.setHeader('Allow', 'POST, OPTIONS');
    return sendJson(
      res,
      405,
      rpcErr(
        RpcError.INVALID_REQUEST,
        'Method Not Allowed：本服务只接受 POST（无状态 Streamable HTTP）'
      )
    );
  }
  if (body.length > MAX_BODY)
    return sendJson(res, 413, rpcErr(RpcError.INVALID_REQUEST, '请求体过大'));

  const key = extractKey(req.headers as any);
  if (!key)
    return sendJson(res, 401, rpcErr(RpcError.INVALID_REQUEST, KEY_HELP));
  let row: ApiKeyRow | null;
  try {
    row = await rt.store.findActive(key);
  } catch {
    return sendJson(
      res,
      503,
      rpcErr(RpcError.INTERNAL, '鉴权服务暂不可用，请稍后重试')
    );
  }
  if (!row)
    return sendJson(res, 401, rpcErr(RpcError.INVALID_REQUEST, KEY_HELP));
  if (!scopeAllows(row.scope as KeyScope, product)) {
    return sendJson(
      res,
      403,
      rpcErr(RpcError.INVALID_REQUEST, `该 Key 未开通 ${product} 服务`)
    );
  }

  let payload: any;
  try {
    payload = JSON.parse(body.toString('utf8') || '');
  } catch {
    return sendJson(res, 400, rpcErr(RpcError.PARSE, 'Parse error'));
  }

  const spec = SPECS[product];
  const deps = product === 'agent' ? rt.agentDeps(row) : rt.investDeps(row);
  const keyRow = row;
  const userId = keyRow.user_id || null;
  const toolError = (id: any, text: string) => ({
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text }], isError: true },
  });
  const one = async (msg: any) => {
    let charged = 0;
    let chargedTool = '';
    if (
      msg &&
      msg.method === 'tools/call' &&
      msg.id !== undefined &&
      msg.id !== null
    ) {
      // 自助 Key：按档位定每日上限 + 按次扣点；管理员手发的 Key 不扣点
      let limit: number | undefined;
      if (userId) {
        try {
          const acct = await rt.billing.getAccount(userId);
          limit = TIERS[effectiveTier(acct)].dailyLimit;
        } catch {
          return toolError(msg.id, '计费服务暂不可用，请稍后重试');
        }
      }
      const q = await rt.store.countCall(keyRow, new Date(), limit);
      const free = currentPhase(rt.now ? rt.now() : new Date()).id === 'free';
      if (q.over) {
        return toolError(
          msg.id,
          `今日调用已达上限（${q.limit} 次），北京时间零点重置。` +
            (free ? '' : '开通会员可提高上限。')
        );
      }
      const name = msg.params?.name;
      // 按次扣点（2026-10-31 公测免费那一天除外）；点数用完返回带充值链接的错误。用量照常进调用日志
      if (userId && !free && spec.tools.some(t => t.name === name)) {
        const cost = toolCost(name);
        if (cost > 0) {
          let left: number | null;
          try {
            left = await rt.billing.charge(userId, cost, name);
          } catch {
            return toolError(msg.id, '计费服务暂不可用，请稍后重试');
          }
          if (left === null) {
            const balance = await rt.billing
              .getAccount(userId)
              .then(a => a?.points ?? 0)
              .catch(() => 0);
            return toolError(
              msg.id,
              creditExhaustedMessage(
                cost,
                balance,
                rt.now ? rt.now() : new Date()
              )
            );
          }
          charged = cost;
          chargedTool = name;
        }
      }
    }
    const out = await handleMessage(msg, spec, deps, rec =>
      rt.store.log({
        keyId: Number(keyRow.id),
        product,
        tool: rec.tool,
        ok: rec.ok,
        latencyMs: rec.latencyMs,
        error: rec.error,
      })
    );
    // 工具失败（参数错、上游报错）不收费
    if (charged && userId && (!out || out.error || out.result?.isError)) {
      await rt.billing.refund(userId, charged, chargedTool).catch(() => {});
    }
    return out;
  };

  if (Array.isArray(payload)) {
    if (!payload.length)
      return sendJson(
        res,
        400,
        rpcErr(RpcError.INVALID_REQUEST, 'Invalid Request')
      );
    const out = (await Promise.all(payload.map(one))).filter(x => x !== null);
    if (!out.length) {
      res.statusCode = 202;
      res.end();
      return;
    }
    return sendJson(res, 200, out);
  }
  const out = await one(payload);
  if (out === null) {
    res.statusCode = 202;
    res.end();
    return;
  }
  return sendJson(res, 200, out);
}

async function handleAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  rt: McpRuntime,
  body: Buffer,
  method: string
) {
  if (!(await rt.isAdmin(req.headers as any))) {
    return sendJson(res, 401, { success: false, message: '需要管理员权限' });
  }
  let data: any = {};
  if (method === 'POST') {
    try {
      data = JSON.parse(body.toString('utf8') || '{}');
    } catch {
      return sendJson(res, 400, {
        success: false,
        message: '请求体不是合法 JSON',
      });
    }
  }
  const path = url.pathname.replace(/\/+$/, '');
  try {
    if (path === '/mcp/admin/keys' && method === 'GET') {
      return sendJson(res, 200, { success: true, data: await rt.store.list() });
    }
    if (path === '/mcp/admin/keys' && method === 'POST') {
      const scope = data.scope || 'all';
      if (!['agent', 'invest', 'all'].includes(scope)) {
        return sendJson(res, 400, {
          success: false,
          message: 'scope 只能是 agent / invest / all',
        });
      }
      const owner = String(data.owner || '').trim();
      if (!owner)
        return sendJson(res, 400, {
          success: false,
          message: '缺少 owner（Key 归属人，如微信昵称/邮箱）',
        });
      const created = await rt.store.create({
        scope,
        owner,
        note: data.note,
        dailyLimit: data.dailyLimit,
      });
      return sendJson(res, 200, {
        success: true,
        data: { ...created, notice: '明文 Key 只显示这一次，请立即复制给用户' },
      });
    }
    if (path === '/mcp/admin/keys/revoke' && method === 'POST') {
      const ok = await rt.store.revoke(Number(data.id));
      return sendJson(res, ok ? 200 : 404, {
        success: ok,
        message: ok ? '已吊销' : 'Key 不存在',
      });
    }
    const billingOut = await handleBillingAdmin(
      path,
      method,
      url,
      data,
      rt,
      req
    );
    if (billingOut) return sendJson(res, billingOut.status, billingOut.body);
    if (path === '/mcp/admin/usage' && method === 'GET') {
      const days = Number(url.searchParams.get('days') || 7);
      return sendJson(res, 200, {
        success: true,
        data: await rt.store.usage(days),
      });
    }
  } catch (e: any) {
    return sendJson(res, 500, {
      success: false,
      message: (e && e.message) || '内部错误',
    });
  }
  return sendJson(res, 404, { success: false, message: 'not found' });
}

/**
 * 从 Midway 容器装配运行时（server.js 启动后调用一次，结果缓存）。
 * 服务实例都是单例，工具 deps 只是薄转发。
 */
export async function createMcpRuntime(appCtx: any): Promise<McpRuntime> {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { TypeORMDataSourceManager } = require('@midwayjs/typeorm');
  const { RedisService } = require('@midwayjs/redis');
  const { ArticleService } = require('../service/article');
  const {
    ArticleContentService,
  } = require('../service/content/articleContent');
  const { RetrieveService } = require('../service/ai/retrieve');
  const { OssService } = require('../service/content/oss');
  const { InterviewService } = require('../service/interview');
  const { MissionService } = require('../service/mission');
  const { QuizService } = require('../service/quiz');
  const { InvestInsightService } = require('../service/invest/insight');
  const { resolveUserInfo } = require('../common/admin.guard');
  /* eslint-enable @typescript-eslint/no-var-requires */

  const dsm = await appCtx.getAsync(TypeORMDataSourceManager);
  const ds = dsm.getDataSource('default');
  let redis: any = null;
  try {
    redis = await appCtx.getAsync(RedisService);
  } catch {
    redis = null;
  }
  const store = new McpStore((sql, params) => ds.query(sql, params), redis);

  const article = await appCtx.getAsync(ArticleService);
  const content = await appCtx.getAsync(ArticleContentService);
  const retrieve = await appCtx.getAsync(RetrieveService);
  const interview = await appCtx.getAsync(InterviewService);
  const mission = await appCtx.getAsync(MissionService);
  const quiz = await appCtx.getAsync(QuizService);
  const insight = await appCtx.getAsync(InvestInsightService);

  const billing = new BillingStore((sql, params) => ds.query(sql, params));

  const usageOf = (row: ApiKeyRow) => async () => {
    const base = {
      keyPrefix: row.key_prefix,
      scope: row.scope,
      usedToday: await store.usedToday(row),
    };
    if (!row.user_id) {
      return {
        ...base,
        dailyLimit: Number(row.daily_limit),
        billing: '内部 Key，不扣点',
      };
    }
    const acct = await billing.getAccount(row.user_id);
    const tier = effectiveTier(acct);
    return {
      ...base,
      plan: TIERS[tier].name,
      planExpireAt: acct?.active ? acct.tier_expire_at : null,
      points: acct?.points ?? 0,
      dailyLimit: TIERS[tier].dailyLimit,
      manage: 'https://www.agent-journey.cn/developer',
      recharge: RECHARGE_URL,
    };
  };

  const userInfoOf = async (headers: Record<string, any>) => {
    const h = { ...headers };
    // 自助后台用平台登录 token；Authorization 留给 API Key，避免互相误认
    if (
      !h.token &&
      h.authorization &&
      !/^Bearer\s+jk_/i.test(h.authorization)
    ) {
      h.token = String(h.authorization).replace(/^Bearer\s+/i, '');
    }
    return resolveUserInfo({ headers: { token: h.token } }, redis);
  };

  return {
    store,
    billing,
    autoFulfill: process.env.MCP_ORDER_AUTO_FULFILL === '1',
    alipay: (() => {
      try {
        return loadAlipayConfig();
      } catch (e: any) {
        // 密钥格式错只关掉支付宝通道，不拖垮整个 MCP 服务
        console.error('[mcp] 支付宝配置无效，已停用支付宝收款:', e?.message);
        return null;
      }
    })(),
    isAdmin: async headers => {
      const info = await userInfoOf(headers);
      return !!info && info.role === 'admin';
    },
    userIdOf: async headers => {
      const info = await userInfoOf(headers);
      const id = info?.userId ? String(info.userId) : null;
      return id && !id.startsWith('guest:') ? id : null;
    },
    adminIdOf: async headers =>
      String((await userInfoOf(headers))?.userId || 'admin'),
    agentDeps: row => ({
      getNavList: m => article.getNavList(m),
      searchContent: (q, o) => content.search(q, o),
      retrieve: (q, o) => retrieve.retrieve(q, o),
      // 正文库缺行（同步时漏入库）时按导航树 filePath 直接读 OSS 原文，保证目录里有的文章都能读到
      getContent: async (m, k) => {
        const row = await content.get(m, k);
        if (row && row.content) return row;
        const leaf = await article.findLeafByKey(m, k);
        if (!leaf) return row;
        try {
          const text = await new OssService().get(m, leaf.filePath, k);
          return { articleKey: k, title: leaf.label, content: text };
        } catch {
          return row;
        }
      },
      searchInterviews: async ({ keyword, page, pageSize }) => {
        const qb = interview.interviewModel
          .createQueryBuilder('i')
          .select([
            'i.id',
            'i.title',
            'i.aiTitle',
            'i.aiContent',
            'i.content',
            'i.source',
            'i.publishTime',
            'i.createTime',
          ])
          .where("(i.status IS NULL OR i.status != 'deleted')");
        const words = String(keyword || '')
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 4);
        words.forEach((w, n) => {
          qb.andWhere(
            `(i.title LIKE :w${n} OR i.aiTitle LIKE :w${n} OR i.aiContent LIKE :w${n})`,
            {
              [`w${n}`]: `%${w.replace(/[%_\\]/g, c => '\\' + c)}%`,
            }
          );
        });
        qb.orderBy('i.createTime', 'DESC')
          .skip((page - 1) * pageSize)
          .take(pageSize);
        const [list, total] = await qb.getManyAndCount();
        return { list, total };
      },
      getInterview: id => interview.interviewModel.findOne({ where: { id } }),
      listMissions: tier => mission.list(tier, '', true),
      getMission: async slug => {
        try {
          const { mission: m } = await mission.detail(slug, '');
          return m && m.status === 'published' ? m : null;
        } catch {
          return null;
        }
      },
      listQuiz: (m, k) =>
        AGENT_MODULES.includes(m)
          ? quiz.listForTake(m, k)
          : Promise.resolve([]),
      usage: usageOf(row),
    }),
    investDeps: row => ({
      fearLatest: () => insight.fearLatest(),
      fearSeries: (s, e) => insight.fearSeries(s, e),
      bias: () => insight.bias(),
      broad: () => insight.broad(),
      macro: n => insight.macro(n),
      usage: usageOf(row),
    }),
  };
}
