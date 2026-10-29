import { ToolDef, ToolError, ServerSpec } from '../protocol';

/**
 * Agent Journey 的 MCP 工具（第一版：只读）。
 *
 * 定位（owner 2026-10-28）：Iris 不对外；对外只给「基础能力和服务」——知识点内容、
 * 面经数据、题卡与验收标准、自测题。AI 在用户自己的 Agent 里，我们只供料。
 *
 * 只开放 knowledge / interview 两个模块；firstclass（付费课程）不经 MCP 透出。
 */

export const AGENT_MODULES = ['knowledge', 'interview'];

/** 工具依赖的服务（由 http.ts 从 Midway 容器取；单测传假实现）。 */
export interface AgentDeps {
  getNavList(module: string): Promise<{ navData: any[] }>;
  searchContent(
    query: string,
    opts: { module?: string; limit?: number }
  ): Promise<any[]>;
  retrieve(
    query: string,
    opts: { module?: string; topK?: number }
  ): Promise<any[]>;
  getContent(module: string, articleKey: string): Promise<any | null>;
  searchInterviews(p: {
    keyword?: string;
    page: number;
    pageSize: number;
  }): Promise<{ list: any[]; total: number }>;
  getInterview(id: number): Promise<any | null>;
  listMissions(tier?: string): Promise<any[]>;
  getMission(slug: string): Promise<any | null>;
  listQuiz(module: string, articleKey: string): Promise<any[]>;
  usage(): Promise<any>;
}

const MAX_ARTICLE_CHARS = 60_000;
const SOURCE = 'Agent Journey（https://www.agent-journey.cn）';

function checkModule(m: any): string {
  if (!AGENT_MODULES.includes(m))
    throw new ToolError(`module 只能是 ${AGENT_MODULES.join(' / ')}`);
  return m;
}

/** 导航树瘦身：只留目录结构与文章 key，去掉前端渲染字段。 */
export function slimTree(nodes: any[], depth = 0, maxDepth = 6): any[] {
  if (!Array.isArray(nodes) || depth > maxDepth) return [];
  return nodes.map(n => {
    const out: any = { title: n.label || n.key };
    if (n.isLeaf === true) {
      out.articleKey = n.key;
      if (Array.isArray(n.tags) && n.tags.length) out.tags = n.tags;
    } else if (Array.isArray(n.children) && n.children.length) {
      out.children = slimTree(n.children, depth + 1, maxDepth);
    }
    return out;
  });
}

const moduleProp = {
  type: 'string',
  enum: AGENT_MODULES,
  description: 'knowledge＝前端/AI 知识点体系；interview＝面试题解',
};

export const agentTools: ToolDef<AgentDeps>[] = [
  {
    name: 'knowledge_tree',
    title: '知识体系目录',
    description:
      '取 Agent Journey 某个模块的完整目录树（章节 → 文章，叶子带 articleKey）。' +
      '做学习规划、找知识点位置、判断覆盖范围时先调它。',
    inputSchema: {
      type: 'object',
      properties: { module: moduleProp },
      required: ['module'],
    },
    handler: async (a, d) => {
      const module = checkModule(a.module);
      const { navData } = await d.getNavList(module);
      return { module, tree: slimTree(navData || []) };
    },
  },
  {
    name: 'knowledge_search',
    title: '知识点检索',
    description:
      '在 Agent Journey 站内文章里按关键词或问题检索，返回命中文章（标题、articleKey、正文片段）。' +
      '回答技术问题前先检索，再用 knowledge_get 读全文；不要编造结果里没有的文章。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词或自然语言问题' },
        module: moduleProp,
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: '返回条数，默认 8',
        },
      },
      required: ['query'],
    },
    handler: async (a, d) => {
      const module = a.module ? checkModule(a.module) : undefined;
      const limit = Math.max(1, Math.min(20, a.limit || 8));
      const query = String(a.query).slice(0, 200);
      const hits = (await d.searchContent(query, { module, limit })).filter(h =>
        AGENT_MODULES.includes(h.module)
      );
      if (hits.length) {
        return {
          query,
          items: hits.map(h => ({
            module: h.module,
            articleKey: h.articleKey,
            title: h.title,
            snippet: h.snippet,
          })),
        };
      }
      // 正文索引没命中时退回标题/目录召回
      const titles = await d.retrieve(query, { module, topK: limit });
      return {
        query,
        items: titles.map(h => ({
          module: h.module,
          articleKey: h.articleKey,
          title: h.title,
        })),
        note: '正文无命中，以下为按标题与目录的召回',
      };
    },
  },
  {
    name: 'knowledge_get',
    title: '读取文章全文',
    description:
      '按 module + articleKey 读取一篇文章的 Markdown 全文（来自 knowledge_tree 或 knowledge_search）。',
    inputSchema: {
      type: 'object',
      properties: { module: moduleProp, articleKey: { type: 'string' } },
      required: ['module', 'articleKey'],
    },
    handler: async (a, d) => {
      const module = checkModule(a.module);
      const row = await d.getContent(module, String(a.articleKey));
      if (!row)
        throw new ToolError(
          '文章不存在或尚未入库，请先用 knowledge_search 确认 articleKey'
        );
      const content: string = row.content || '';
      return {
        module,
        articleKey: row.articleKey,
        title: row.title,
        source: SOURCE,
        truncated: content.length > MAX_ARTICLE_CHARS,
        content: content.slice(0, MAX_ARTICLE_CHARS),
      };
    },
  },
  {
    name: 'interview_search',
    title: '面经检索',
    description:
      '检索真实面经（来自牛客等平台、已整理），可按公司/岗位/技术关键词过滤，按时间倒序。' +
      '返回摘要；要看全文用 interview_get。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: '公司、岗位或技术关键词，如「字节 前端」「React 性能」',
        },
        page: { type: 'integer', minimum: 1 },
        pageSize: {
          type: 'integer',
          minimum: 1,
          maximum: 30,
          description: '默认 10',
        },
      },
    },
    handler: async (a, d) => {
      const page = Math.max(1, a.page || 1);
      const pageSize = Math.max(1, Math.min(30, a.pageSize || 10));
      const { list, total } = await d.searchInterviews({
        keyword: a.keyword ? String(a.keyword).slice(0, 60) : undefined,
        page,
        pageSize,
      });
      return {
        total,
        page,
        pageSize,
        items: list.map(r => ({
          id: Number(r.id),
          title: r.aiTitle || r.title,
          source: r.source,
          publishTime: r.publishTime || null,
          summary: String(r.aiContent || r.content || '').slice(0, 300),
        })),
      };
    },
  },
  {
    name: 'interview_get',
    title: '面经全文',
    description: '按 id 读取一篇面经：原文 + 整理后的题目与要点。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
    },
    handler: async (a, d) => {
      const r = await d.getInterview(Number(a.id));
      if (!r || r.status === 'deleted') throw new ToolError('面经不存在');
      return {
        id: Number(r.id),
        title: r.aiTitle || r.title,
        source: r.source,
        sourceUrl: r.url || null,
        publishTime: r.publishTime || null,
        organized: r.aiContent || null,
        original: r.content,
      };
    },
  },
  {
    name: 'mission_list',
    title: '实战题卡列表',
    description:
      '列出已发布的实战题卡（工程任务），含难度、预估耗时、简介。可按档位过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        tier: {
          type: 'string',
          description: '档位 small / medium / large；不传列全部',
        },
      },
    },
    handler: async (a, d) => {
      const list = await d.listMissions(a.tier ? String(a.tier) : undefined);
      return {
        items: list.map(m => ({
          slug: m.slug,
          title: m.title,
          tier: m.tier,
          difficulty: m.difficulty,
          estimate: m.estimate,
          summary: m.summary,
        })),
      };
    },
  },
  {
    name: 'mission_get',
    title: '题卡详情',
    description:
      '按 slug 读取一张题卡：背景、需求、约束、验收标准、前置文章。' +
      '适合让 Agent 按验收标准逐条自查用户的实现。',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string' } },
      required: ['slug'],
    },
    handler: async (a, d) => {
      const m = await d.getMission(String(a.slug));
      if (!m) throw new ToolError('题卡不存在');
      return {
        slug: m.slug,
        title: m.title,
        tier: m.tier,
        difficulty: m.difficulty,
        estimate: m.estimate,
        summary: m.summary,
        background: m.background,
        requirements: m.requirements,
        constraints: m.constraints,
        acceptanceCriteria: m.acceptanceCriteria,
        prereqArticles: m.prereqArticles,
      };
    },
  },
  {
    name: 'quiz_get',
    title: '文章自测题',
    description:
      '取某篇文章配套的自测题（只含题干和选项，不含答案），供 Agent 出题考用户。',
    inputSchema: {
      type: 'object',
      properties: { module: moduleProp, articleKey: { type: 'string' } },
      required: ['module', 'articleKey'],
    },
    handler: async (a, d) => {
      const module = checkModule(a.module);
      const items = await d.listQuiz(module, String(a.articleKey));
      return { module, articleKey: a.articleKey, items };
    },
  },
  {
    name: 'account_usage',
    title: '今日用量',
    description: '查看当前 API Key 的今日调用次数与每日上限。',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_a, d) => d.usage(),
  },
];

export const agentServer: ServerSpec<AgentDeps> = {
  name: 'agent-journey',
  version: '0.1.0',
  instructions:
    'Agent Journey 数据服务：前端/AI 工程知识体系、真实面经、实战题卡与自测题。' +
    '回答技术问题先 knowledge_search 再 knowledge_get，引用时附上文章标题与链接；' +
    '面试准备用 interview_search；做项目练习用 mission_list / mission_get 并按验收标准自查。',
  tools: agentTools,
};
