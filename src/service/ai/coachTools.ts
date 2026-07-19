import { Provide, Inject } from '@midwayjs/core';
import { RetrieveService } from './retrieve';
import { ArticleContentService, ContentHit } from '../content/articleContent';
import { ArticleService } from '../article';
import { OssService } from '../content/oss';
import { sanitizeForPrompt } from './sanitize';
import { ALL_MODULES } from '../content/modules';

/** 一条引用（回答末尾「延伸阅读」候选）。 */
export interface Citation {
  module: string;
  articleKey: string;
  title: string;
}

/** 单次会话内的工具执行上下文（loop 持有并透传）。 */
export interface ToolContext {
  userId: string;
  /** 当前所在模块（文章页场景），检索默认域 */
  module?: string;
  /** 读过/检索过的文章：loop 据此产出 citations 帧。key = module:articleKey */
  citations: Map<string, Citation>;
}

const CONTENT_MODULES = ALL_MODULES; // ['interview','knowledge','firstclass']

/**
 * 教练 agentic 工具层（PRD-04 F4 / 检索设计 §2）。
 * 模仿 Claude Code 的 Glob/Grep/Read 三件套，按知识库场景适配为 4 个工具。
 * 所有工具结果为「给模型读的紧凑文本」；文章正文进上下文前一律过 sanitize。
 */
@Provide()
export class CoachToolsService {
  @Inject()
  retrieveService: RetrieveService;

  @Inject()
  articleContentService: ArticleContentService;

  @Inject()
  articleService: ArticleService;

  /** OpenAI function-calling 格式的工具定义。传 whitelist 则只返回其中的工具。 */
  getToolDefs(whitelist?: string[]): any[] {
    const all = this.allToolDefs();
    if (!whitelist || !whitelist.length) {
      // 默认（qa 模式）不含 ask_question
      return all.filter((t) => t.function.name !== 'ask_question');
    }
    return all.filter((t) => whitelist.includes(t.function.name));
  }

  private allToolDefs(): any[] {
    return [
      {
        type: 'function',
        function: {
          name: 'ask_question',
          description:
            '向用户提出一个结构化问题并给出可点选的选项（用于摸底/文章测一测/费曼追问）。' +
            '当你需要用户回答一个判断题/选择题来推进时调用它——调用后本轮结束、等待用户作答，不要同时给出答案。',
          parameters: {
            type: 'object',
            properties: {
              question: { type: 'string', description: '问题文本（中文，一次只问一个）' },
              options: {
                type: 'array',
                description: '2-4 个选项文本；也可为空表示开放作答',
                items: { type: 'string' },
              },
              allowFreeText: { type: 'boolean', description: '是否允许自由输入' },
            },
            required: ['question'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'search_articles',
          description:
            '在站内知识库按关键词检索文章（融合标题/标签词法召回 + 正文全文召回）。回答站内知识问题、需要找依据时优先用它。返回命中文章的 key、标题、正文片段。',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: '检索关键词或问题（中文）' },
              module: {
                type: 'string',
                description: '限定模块：knowledge(前端知识) / interview(面经) / firstclass(精选)。不确定就留空，跨全部模块检索。',
              },
            },
            required: ['query'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'read_article',
          description:
            '读取某篇站内文章的正文（或指定小节）。已知文章 key、需要原文细节来准确回答时用它。先用 search_articles 找到 key 再读。',
          parameters: {
            type: 'object',
            properties: {
              module: { type: 'string', description: '文章所属模块' },
              key: { type: 'string', description: '文章 key（来自 search_articles / get_catalog）' },
              section: { type: 'string', description: '可选：只读某个小节标题下的内容' },
            },
            required: ['module', 'key'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'get_catalog',
          description:
            '获取站内文章目录（key + 标题 + 标签）。想了解站内有哪些内容、做跨文章推荐时用它。可按模块过滤。',
          parameters: {
            type: 'object',
            properties: {
              module: { type: 'string', description: '限定模块，留空则返回全部模块目录' },
            },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'get_learner_state',
          description:
            '获取当前用户的学习画像（已学进度、最近在看、薄弱标签、待复习清单）。做个性化建议、判断从哪讲起时用它。游客无画像。',
          parameters: { type: 'object', properties: {} },
        },
      },
    ];
  }

  /** 执行一个工具，返回给模型读的紧凑文本。副作用：把读过/检索到的文章加入 ctx.citations。 */
  async execute(name: string, args: any, ctx: ToolContext): Promise<string> {
    switch (name) {
      case 'search_articles':
        return this.searchArticles(String(args?.query || ''), args?.module, ctx);
      case 'read_article':
        return this.readArticle(String(args?.module || ''), String(args?.key || ''), args?.section, ctx);
      case 'get_catalog':
        return this.getCatalog(args?.module);
      case 'get_learner_state':
        return this.getLearnerState(ctx);
      default:
        return `未知工具：${name}`;
    }
  }

  /** search_articles：融合词法（标题/标签）+ ngram（正文）两路召回。 */
  private async searchArticles(query: string, module: string | undefined, ctx: ToolContext): Promise<string> {
    if (!query.trim()) return '（未提供检索词）';
    const mod = module && CONTENT_MODULES.includes(module) ? module : undefined;

    const [lexical, content] = await Promise.all([
      this.retrieveService.retrieve(query, { module: mod, topK: 8 }).catch(() => []),
      this.articleContentService.search(query, { module: mod, limit: 8 }).catch(() => [] as ContentHit[]),
    ]);

    // 归一化后融合（正文命中略加权，因为它补的正是词法召回不到的部分）
    const maxLex = Math.max(1, ...lexical.map((h) => h.score));
    const maxCon = Math.max(1, ...content.map((h) => h.score));
    const merged = new Map<
      string,
      { module: string; articleKey: string; title: string; snippet: string; score: number }
    >();
    for (const h of lexical) {
      const k = `${h.module}:${h.articleKey}`;
      merged.set(k, {
        module: h.module,
        articleKey: h.articleKey,
        title: h.title,
        snippet: '',
        score: (h.score / maxLex) * 0.5,
      });
    }
    for (const h of content) {
      const k = `${h.module}:${h.articleKey}`;
      const prev = merged.get(k);
      const contentScore = (h.score / maxCon) * 0.6;
      if (prev) {
        prev.score += contentScore;
        prev.snippet = h.snippet;
        if (!prev.title) prev.title = h.title;
      } else {
        merged.set(k, {
          module: h.module,
          articleKey: h.articleKey,
          title: h.title,
          snippet: h.snippet,
          score: contentScore,
        });
      }
    }

    const ranked = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, 8);
    if (!ranked.length) return `站内未检索到与「${query}」相关的文章。`;

    // 命中文章进入引用候选
    for (const r of ranked) {
      ctx.citations.set(`${r.module}:${r.articleKey}`, {
        module: r.module,
        articleKey: r.articleKey,
        title: r.title,
      });
    }

    return ranked
      .map((r, i) => {
        const snip = r.snippet ? `\n   片段：${sanitizeForPrompt(r.snippet, 160)}` : '';
        return `${i + 1}. [${r.module}/${r.articleKey}] ${r.title}${snip}`;
      })
      .join('\n');
  }

  /** read_article：优先读检索库，缺失回退 OSS；可只读某小节；正文过 sanitize + 限长。 */
  private async readArticle(
    module: string,
    key: string,
    section: string | undefined,
    ctx: ToolContext
  ): Promise<string> {
    if (!module || !key) return '（缺少 module 或 key）';
    let content = '';
    let title = key;
    let filePath = '';

    const indexed = await this.articleContentService.get(module, key);
    if (indexed?.content) {
      content = indexed.content;
      title = indexed.title || key;
      filePath = indexed.filePath || '';
    } else {
      // 回退：从 nav 找 filePath 再读 OSS
      try {
        filePath = await this.findFilePath(module, key);
        const oss = new OssService();
        content = await oss.get(module, filePath, key);
      } catch {
        return `未找到文章 ${module}/${key}。`;
      }
    }

    ctx.citations.set(`${module}:${key}`, { module, articleKey: key, title });

    // 只读某小节
    if (section) {
      const sec = this.extractSection(content, section);
      if (sec) return `《${title}》· ${section}\n${sanitizeForPrompt(sec, 3500)}`;
    }

    // 超长文章：先给小节目录 + 开头，引导模型按需再读 section
    const headings = this.listHeadings(content);
    if (content.length > 4000 && headings.length > 1) {
      const head = sanitizeForPrompt(content.slice(0, 1800), 1800);
      return `《${title}》（较长，小节：${headings.join(' / ')}）\n开头：\n${head}\n\n如需某小节细节，用 read_article 指定 section 再读。`;
    }
    return `《${title}》\n${sanitizeForPrompt(content, 3800)}`;
  }

  /** get_catalog：紧凑目录（module + key + 标题 + 标签），限长防炸 token。 */
  private async getCatalog(module: string | undefined): Promise<string> {
    const mods = module && CONTENT_MODULES.includes(module) ? [module] : CONTENT_MODULES;
    const lines: string[] = [];
    for (const m of mods) {
      let navData: any[] = [];
      try {
        const res = await this.articleService.getNavList(m);
        navData = (res?.navData as any[]) || [];
      } catch {
        continue;
      }
      const leaves: string[] = [];
      const walk = (nodes: any[]): void => {
        if (!Array.isArray(nodes)) return;
        for (const n of nodes) {
          if (n.isLeaf === true && n.key) {
            const tags = Array.isArray(n.tags) && n.tags.length ? ` #${n.tags.join(' #')}` : '';
            leaves.push(`- [${n.key}] ${n.label || n.key}${tags}`);
          }
          if (Array.isArray(n.children) && n.children.length) walk(n.children);
        }
      };
      walk(navData);
      if (leaves.length) lines.push(`【${m}】\n${leaves.join('\n')}`);
    }
    const out = lines.join('\n\n');
    // 限长：目录过大时截断（提示可用 search 精确找）
    if (out.length > 4000) {
      return out.slice(0, 4000) + '\n…（目录较长已截断，用 search_articles 精确检索）';
    }
    return out || '（暂无目录数据）';
  }

  /** get_learner_state：学习画像摘要（游客返回空画像）。 */
  private async getLearnerState(ctx: ToolContext): Promise<string> {
    if (!ctx.userId || ctx.userId.startsWith('guest:')) {
      return '当前是游客，没有学习画像。给通用建议即可，可引导登录以获得个性化。';
    }
    const module = ctx.module && CONTENT_MODULES.includes(ctx.module) ? ctx.module : 'knowledge';
    try {
      const summary = await this.articleService.getProfileSummary(ctx.userId, module);
      const profile = await this.articleService.getLearnerProfile(ctx.userId, module).catch(() => null);
      const weak =
        profile?.weakTags?.length
          ? `薄弱标签：${profile.weakTags.slice(0, 5).map((w) => w.tag).join('、')}。`
          : '';
      const due =
        profile?.reviewDue?.length ? `待复习 ${profile.reviewDue.length} 篇。` : '';
      const text = `${summary || '暂无学习记录。'}${weak}${due}`.trim();
      return text || '暂无学习记录。';
    } catch {
      return '暂无学习记录。';
    }
  }

  // ---- 辅助 ----

  /** 从 nav 树按 key 找 filePath（read_article 回退 OSS 用）。 */
  private async findFilePath(module: string, key: string): Promise<string> {
    const { navData } = await this.articleService.getNavList(module);
    let found = '';
    const walk = (nodes: any[]): void => {
      if (!Array.isArray(nodes) || found) return;
      for (const n of nodes) {
        if (n.isLeaf === true && n.key === key) {
          found = n.filePath || '';
          return;
        }
        if (Array.isArray(n.children)) walk(n.children);
      }
    };
    walk((navData as any[]) || []);
    return found;
  }

  /** 列出 markdown 的一级/二级小节标题。 */
  private listHeadings(content: string): string[] {
    const out: string[] = [];
    for (const line of String(content || '').split('\n')) {
      const m = line.match(/^#{1,3}\s+(.+?)\s*$/);
      if (m) out.push(m[1].trim());
      if (out.length >= 20) break;
    }
    return out;
  }

  /** 抽取某个小节标题下、到下一个同级/更高级标题前的内容。 */
  private extractSection(content: string, section: string): string {
    const lines = String(content || '').split('\n');
    const target = section.trim().toLowerCase();
    let start = -1;
    let startLevel = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(#{1,6})\s+(.+?)\s*$/);
      if (m && m[2].trim().toLowerCase().includes(target)) {
        start = i;
        startLevel = m[1].length;
        break;
      }
    }
    if (start < 0) return '';
    const buf: string[] = [lines[start]];
    for (let i = start + 1; i < lines.length; i++) {
      const m = lines[i].match(/^(#{1,6})\s+/);
      if (m && m[1].length <= startLevel) break;
      buf.push(lines[i]);
    }
    return buf.join('\n').trim();
  }
}
