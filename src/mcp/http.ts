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

/**
 * MCP 的 HTTP 适配层（server.js 在 Midway 之外直接分流 /mcp/* 到这里）。
 *
 * 端点：
 * - POST /mcp/agent   Agent Journey 工具（Streamable HTTP 无状态模式，只回 application/json）
 * - POST /mcp/invest  Invest Journey 工具
 * - /mcp/admin/*      管理端发 Key / 吊销 / 看用量（平台 admin 登录态）
 *
 * 为什么绕开 Midway：MCP 客户端要求精确的状态码语义（202 / 405 / 401），
 * 且 /invest/* 的鉴权中间件要求平台 admin，与 API Key 鉴权是两套体系，单独一路最干净。
 */

export interface McpRuntime {
  store: McpStore;
  agentDeps(row: ApiKeyRow): AgentDeps;
  investDeps(row: ApiKeyRow): InvestDeps;
  isAdmin(headers: Record<string, any>): Promise<boolean>;
}

const SPECS: Record<Product, ServerSpec<any>> = {
  agent: agentServer,
  invest: investServer,
};
const MAX_BODY = 1024 * 1024;
const KEY_HELP =
  '缺少或无效的 API Key：请在请求头带 Authorization: Bearer jk_xxx（Key 申请见 Skill 仓库 README）。';

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

  if (url.pathname.startsWith('/mcp/admin/'))
    return handleAdmin(req, res, url, rt, body, method);

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
  const one = async (msg: any) => {
    if (
      msg &&
      msg.method === 'tools/call' &&
      msg.id !== undefined &&
      msg.id !== null
    ) {
      const q = await rt.store.countCall(keyRow);
      if (q.over) {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [
              {
                type: 'text',
                text: `今日调用已达上限（${q.limit} 次），北京时间零点重置。`,
              },
            ],
            isError: true,
          },
        };
      }
    }
    return handleMessage(msg, spec, deps, rec =>
      rt.store.log({
        keyId: Number(keyRow.id),
        product,
        tool: rec.tool,
        ok: rec.ok,
        latencyMs: rec.latencyMs,
        error: rec.error,
      })
    );
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

  const usageOf = (row: ApiKeyRow) => async () => ({
    keyPrefix: row.key_prefix,
    scope: row.scope,
    dailyLimit: Number(row.daily_limit),
    usedToday: await store.usedToday(row),
    note: '第一版不扣点，只计每日调用次数',
  });

  return {
    store,
    isAdmin: async headers => {
      const info = await resolveUserInfo({ headers }, redis);
      return !!info && info.role === 'admin';
    },
    agentDeps: row => ({
      getNavList: m => article.getNavList(m),
      searchContent: (q, o) => content.search(q, o),
      retrieve: (q, o) => retrieve.retrieve(q, o),
      getContent: (m, k) => content.get(m, k),
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
