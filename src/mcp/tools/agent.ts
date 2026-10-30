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

/** 导航树索引：articleKey → 正式标题与目录路径（正文库里的 title 多为空或取错，一律以导航树为准）。 */
export function navIndex(
  navData: any[]
): Map<string, { title: string; path: string }> {
  const out = new Map<string, { title: string; path: string }>();
  const walk = (nodes: any[], path: string[]) => {
    if (!Array.isArray(nodes)) return;
    for (const n of nodes) {
      const label = n.label || n.key || '';
      if (n.isLeaf === true)
        out.set(n.key, { title: label, path: path.join(' / ') });
      else if (Array.isArray(n.children)) walk(n.children, [...path, label]);
    }
  };
  walk(navData || [], []);
  return out;
}

/** 问句里的虚词不参与检索：「区别」「怎么实现」会把标题含「区别」的无关文章顶上来。 */
const QUERY_NOISE =
  /是什么|有哪些|有什么|怎么样|怎么|如何|为什么|区别|对比|原理|实现|方法|介绍|一下|请问|讲讲|说说|吗|呢|的|和|与|及|或/g;
export function cleanQuery(q: string): string {
  const cleaned = q.replace(QUERY_NOISE, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length >= 2 ? cleaned : q;
}

/** 片段去掉网页标签与实体：正文截断位置可能落在标签中间，前后残缺的半个标签也要去掉。 */
export function cleanSnippet(s?: string): string | undefined {
  if (!s) return s;
  let t = s;
  const firstGt = t.indexOf('>');
  const firstLt = t.indexOf('<');
  if (firstGt >= 0 && (firstLt < 0 || firstGt < firstLt))
    t = t.slice(firstGt + 1);
  t = t
    .replace(/<[^>]*>/g, ' ')
    .replace(/<[^>]*$/, ' ')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^[…\s]*$/.test(t)) return undefined;
  return s.startsWith('…') && !t.startsWith('…') ? `…${t}` : t;
}

/** 「字节全栈最喜欢问什么」里只有公司和岗位有用。 */
const TOPIC_NOISE =
  /最喜欢|喜欢|经常|常常|常见|高频|考点|面试题|面试|面经|岗位|职位|方向|问题|哪些|什么|会问|爱问|常问|问/g;
export function topicTerms(keyword: string): string[] {
  return cleanQuery(keyword)
    .replace(TOPIC_NOISE, ' ')
    .split(/\s+/)
    .map(x => x.trim())
    .filter(Boolean);
}

/** 公司简称：标题与目录里两种写法都有。 */
const COMPANY_ALIAS: Record<string, string> = {
  字节跳动: '字节',
  bytedance: '字节',
  阿里巴巴: '阿里',
  腾讯: '腾讯',
};

const KNOWN_COMPANIES =
  '字节 阿里 腾讯 美团 百度 京东 快手 拼多多 小红书 蚂蚁 oppo vivo 华为 米哈游 网易'.split(
    ' '
  );

/**
 * 按导航树标题 + 公司部门路径筛面经：每个词都要出现。
 * 「字节全栈」这类连写的词拆不开时，按已知公司名前缀切一刀再匹配。
 */
export function matchInterviews(
  nav: Map<string, { title: string; path: string }>,
  terms: string[]
): string[] {
  const norm = (x: string) => {
    const l = x.toLowerCase();
    return COMPANY_ALIAS[l] || l;
  };
  const split: string[] = [];
  for (const raw of terms) {
    const t = norm(raw);
    const hit = [...nav.values()].some(v =>
      `${v.title} ${v.path}`.toLowerCase().includes(t)
    );
    const prefix = hit
      ? null
      : KNOWN_COMPANIES.find(c => t.startsWith(c) && t.length > c.length);
    if (prefix) split.push(prefix, t.slice(prefix.length));
    else split.push(t);
  }
  return [...nav.entries()]
    .filter(([, v]) => {
      const hay = `${v.title} ${v.path}`.toLowerCase();
      return split.every(t => hay.includes(t));
    })
    .map(([k]) => k);
}

/** 从一篇面经里抽「知识点 key → 原题」：每道题是 <details data-knowledge-key> + <summary>。 */
export function extractQuestions(
  content: string
): { key: string; question: string }[] {
  const out: { key: string; question: string }[] = [];
  const re =
    /<details[^>]*data-knowledge-key="([^"]+)"[^>]*>\s*<summary>([\s\S]*?)<\/summary>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    let q = cleanSnippet(m[2]) || '';
    // 「背景学习入口」作者注明不计专题频次
    if (/^（\d+）\s*背景学习入口/.test(q)) continue;
    q = q
      .replace(/^（\d+）\s*/, '')
      .replace(/^同一原问的复习入口（[^）]*）：/, '')
      .replace(/^[一二三四五]面：/, '')
      .trim();
    if (q) out.push({ key: m[1], question: q });
  }
  return out;
}

/**
 * 标题/目录召回与正文全文召回做倒数排名融合（RRF）。
 * 标题命中更精确，权重 2；正文命中补长尾，权重 1；两路都命中的排最前。
 * 标题路只保留有实质命中的（lexicalSearch 分数 ≥2，即至少命中一个词或二字词，单字不算）。
 */
export function fuseHits(
  titleHits: any[],
  contentHits: any[],
  limit: number
): { module: string; articleKey: string; snippet?: string }[] {
  const K = 10;
  type Fused = {
    module: string;
    articleKey: string;
    snippet?: string;
    score: number;
  };
  const acc = new Map<string, Fused>();
  const add = (h: any, rank: number, w: number) => {
    const id = `${h.module}:${h.articleKey}`;
    const cur: Fused = acc.get(id) || {
      module: h.module,
      articleKey: h.articleKey,
      score: 0,
    };
    cur.score += w / (K + rank);
    if (h.snippet && !cur.snippet) cur.snippet = h.snippet;
    acc.set(id, cur);
  };
  titleHits
    .filter(h => (h.score ?? 2) >= 2)
    .forEach((h, i) => add(h, i + 1, 2));
  contentHits.forEach((h, i) => add(h, i + 1, 1));
  return [...acc.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score: _s, ...rest }) => rest);
}

async function navMaps(d: AgentDeps, modules: string[]) {
  const maps: Record<string, Map<string, { title: string; path: string }>> = {};
  await Promise.all(
    modules.map(async m => {
      try {
        maps[m] = navIndex((await d.getNavList(m)).navData || []);
      } catch {
        maps[m] = new Map();
      }
    })
  );
  return maps;
}

/** 混合检索：标题/目录 + 正文，结果统一用导航树标题与目录路径。 */
async function hybridSearch(
  d: AgentDeps,
  query: string,
  modules: string[],
  limit: number
) {
  const q = cleanQuery(query);
  const module = modules.length === 1 ? modules[0] : undefined;
  const [titleHits, contentHits, maps] = await Promise.all([
    d.retrieve(q, { module, topK: limit * 2 }).catch(() => []),
    d.searchContent(q, { module, limit: limit * 2 }).catch(() => []),
    navMaps(d, modules),
  ]);
  const inScope = (h: any) => modules.includes(h.module);
  return (
    fuseHits(titleHits.filter(inScope), contentHits.filter(inScope), limit)
      // 导航树里已下线的文章不返回（正文库可能残留）
      .filter(h => {
        const m = maps[h.module];
        return !m || !m.size || m.has(h.articleKey);
      })
      .map(h => {
        const nav = maps[h.module]?.get(h.articleKey);
        return {
          module: h.module,
          articleKey: h.articleKey,
          title: nav?.title || h.articleKey,
          path: nav?.path || undefined,
          snippet: cleanSnippet(h.snippet),
        };
      })
  );
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
      const modules = a.module ? [checkModule(a.module)] : AGENT_MODULES;
      const limit = Math.max(1, Math.min(20, a.limit || 8));
      const query = String(a.query).slice(0, 200);
      const items = await hybridSearch(d, query, modules, limit);
      return {
        query,
        items,
        ...(items.length
          ? {}
          : {
              note: '站内没有相关文章。请如实告诉用户本站未覆盖这个主题，不要编造出处。',
            }),
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
      const nav = (await navMaps(d, [module]))[module].get(row.articleKey);
      return {
        module,
        articleKey: row.articleKey,
        title: nav?.title || row.title || row.articleKey,
        path: nav?.path,
        url: `https://www.agent-journey.cn/${module}?activeKey=${encodeURIComponent(
          row.articleKey
        )}`,
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
      '检索站内整理过的真实面经（按公司 / 部门归档，含逐题解析），关键词可以是公司、部门、岗位或技术点，' +
      '如「字节 飞书」「美团」「React 性能」「RAG」。返回标题、公司部门路径与片段；看全文用 interview_get(articleKey)。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: '公司、部门、岗位或技术关键词',
        },
        pageSize: {
          type: 'integer',
          minimum: 1,
          maximum: 30,
          description: '默认 10',
        },
      },
    },
    handler: async (a, d) => {
      const pageSize = Math.max(1, Math.min(30, a.pageSize || 10));
      const keyword = String(a.keyword || '')
        .slice(0, 60)
        .trim();
      if (!keyword) {
        // 不给关键词：按目录列出（公司 / 部门 → 面经）
        const { navData } = await d.getNavList('interview');
        const items = [...navIndex(navData || []).entries()]
          .slice(0, pageSize)
          .map(([articleKey, v]) => ({
            articleKey,
            title: v.title,
            company: v.path,
          }));
        return { keyword: '', items };
      }
      const hits = await hybridSearch(d, keyword, ['interview'], pageSize);
      return {
        keyword,
        items: hits.map(h => ({
          articleKey: h.articleKey,
          title: h.title,
          company: h.path,
          snippet: h.snippet,
        })),
        ...(hits.length
          ? {}
          : {
              note: '没有匹配的面经。可以换成公司名或更通用的技术词再搜，或用 knowledge_tree(interview) 看全部公司目录。',
            }),
      };
    },
  },
  {
    name: 'interview_get',
    title: '面经全文',
    description:
      '按 articleKey（来自 interview_search）读取一篇面经：面试过程、逐题解析与关联知识点。',
    inputSchema: {
      type: 'object',
      properties: {
        articleKey: { type: 'string' },
        id: { type: 'integer', description: '旧版原始面经 id（兼容）' },
      },
    },
    handler: async (a, d) => {
      if (a.articleKey) {
        const key = String(a.articleKey);
        const row = await d.getContent('interview', key);
        if (!row)
          throw new ToolError(
            '面经不存在，请先用 interview_search 确认 articleKey'
          );
        const nav = (await navMaps(d, ['interview'])).interview.get(key);
        const content: string = row.content || '';
        return {
          articleKey: key,
          title: nav?.title || row.title || key,
          company: nav?.path,
          url: `https://www.agent-journey.cn/interview?activeKey=${encodeURIComponent(
            key
          )}`,
          source: SOURCE,
          truncated: content.length > MAX_ARTICLE_CHARS,
          content: content.slice(0, MAX_ARTICLE_CHARS),
        };
      }
      if (a.id === undefined) throw new ToolError('需要 articleKey');
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
    name: 'interview_topics',
    title: '面经高频考点',
    description:
      '按公司 / 部门 / 岗位统计站内面经里最常被问的考点，一次返回考点排行（出现在几篇面经里）和原题示例。' +
      '用户问「某公司某岗位最喜欢问什么」「高频考点」「重点准备什么」时直接调它，不必逐篇 interview_get。' +
      'keyword 写公司和岗位，用空格分开，如「字节 全栈」「美团 前端」「字节 飞书」。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: '公司、部门、岗位，空格分开，如「字节 全栈」',
        },
        topN: {
          type: 'integer',
          minimum: 1,
          maximum: 30,
          description: '返回多少个考点，默认 15',
        },
        maxArticles: {
          type: 'integer',
          minimum: 1,
          maximum: 40,
          description: '最多统计多少篇面经，默认 30',
        },
      },
      required: ['keyword'],
    },
    handler: async (a, d) => {
      const keyword = String(a.keyword || '')
        .slice(0, 60)
        .trim();
      if (!keyword) throw new ToolError('需要 keyword（公司 / 岗位）');
      const topN = Math.max(1, Math.min(30, a.topN || 15));
      const maxArticles = Math.max(1, Math.min(40, a.maxArticles || 30));
      const maps = await navMaps(d, ['interview', 'knowledge']);
      const nav = maps.interview;
      let keys = matchInterviews(nav, topicTerms(keyword));
      let matchedBy = 'title';
      if (!keys.length) {
        // 标题对不上（如只写了技术词）：退回全文检索
        keys = (await hybridSearch(d, keyword, ['interview'], maxArticles)).map(
          h => h.articleKey
        );
        matchedBy = 'search';
      }
      keys = keys.slice(0, maxArticles);
      if (!keys.length)
        return {
          keyword,
          articlesAnalyzed: 0,
          topics: [],
          note: '站内没有匹配的面经。请如实告诉用户本站暂无该公司或岗位的面经，可用 knowledge_tree(interview) 看已覆盖的公司。',
        };
      const rows = await Promise.all(
        keys.map(k => d.getContent('interview', k).catch(() => null))
      );
      type Topic = {
        articles: Set<string>;
        examples: { question: string; articleKey: string }[];
      };
      const acc = new Map<string, Topic>();
      const used: { articleKey: string; title: string; company?: string }[] =
        [];
      rows.forEach((row, i) => {
        const key = keys[i];
        const qs = extractQuestions(row?.content || '');
        if (!qs.length) return;
        used.push({
          articleKey: key,
          title: nav.get(key)?.title || key,
          company: nav.get(key)?.path,
        });
        for (const q of qs) {
          const t = acc.get(q.key) || { articles: new Set(), examples: [] };
          t.articles.add(key);
          if (
            t.examples.length < 3 &&
            !t.examples.some(
              e => e.question === q.question || e.articleKey === key
            )
          )
            t.examples.push({ question: q.question, articleKey: key });
          acc.set(q.key, t);
        }
      });
      const total = used.length;
      const topics = [...acc.entries()]
        .sort(
          (x, y) =>
            y[1].articles.size - x[1].articles.size ||
            y[1].examples.length - x[1].examples.length
        )
        .slice(0, topN)
        .map(([k, t]) => {
          const kn = maps.knowledge.get(k);
          return {
            topic: kn?.title || k,
            knowledgeKey: k,
            articles: t.articles.size,
            share: `${t.articles.size}/${total}`,
            examples: t.examples,
            ...(kn
              ? {
                  learnUrl: `https://www.agent-journey.cn/knowledge?activeKey=${encodeURIComponent(
                    k
                  )}`,
                }
              : {}),
          };
        });
      return {
        keyword,
        matchedBy,
        articlesAnalyzed: total,
        topics,
        articles: used,
        source: SOURCE,
        note:
          `统计口径：${total} 篇站内整理的面经里，每个考点出现在几篇中（同一篇只算一次）。` +
          '面经是候选人自述，样本有限，排行反映站内收录情况而非官方题库；回答时请说明样本数，深入某题用 interview_get 或 knowledge_get(knowledgeKey)。',
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
        ...(list.length
          ? {}
          : {
              note: '目前还没有已发布的实战题卡。可以改用 knowledge_search 找相关文章，按文章里的要点设计练习。',
            }),
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
      return {
        module,
        articleKey: a.articleKey,
        items,
        ...(items.length
          ? {}
          : {
              note: '这篇文章还没有配套自测题。可以先 knowledge_get 读全文，再基于文章内容自己出题，并注明是你出的题。',
            }),
      };
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
    '面试准备：问某公司 / 岗位高频考点用 interview_topics，查具体面经用 interview_search 再 interview_get(articleKey)；做项目练习用 mission_list / mission_get 并按验收标准自查。',
  tools: agentTools,
};
