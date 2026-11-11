import { Provide, Inject } from '@midwayjs/core';
import { RetrieveService } from './retrieve';
import { ArticleContentService, ContentHit } from '../content/articleContent';
import { ArticleService } from '../article';
import { EmbeddingService } from '../embedding';
import { OssService } from '../content/oss';
import { sanitizeForPrompt } from './sanitize';
import { ALL_MODULES } from '../content/modules';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { In, Repository } from 'typeorm';
import { MissionEntity } from '../../entity/mission';
import { MissionSubmissionEntity } from '../../entity/missionSubmission';
import { MissionReviewEntity } from '../../entity/missionReview';
import { InterviewQuestionIndexService } from '../interview/questionIndex';
import { codeRunnerConfigured, callCodeRunner } from './codeRunner';

export { codeRunnerConfigured };

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

const CONTENT_MODULES = ALL_MODULES; // ['interview','knowledge','firstclass','soe','civil']

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

  @Inject()
  embeddingService: EmbeddingService;

  @Inject()
  questionIndex: InterviewQuestionIndexService;

  @InjectEntityModel(MissionEntity)
  missionModel: Repository<MissionEntity>;

  @InjectEntityModel(MissionSubmissionEntity)
  submissionModel: Repository<MissionSubmissionEntity>;

  @InjectEntityModel(MissionReviewEntity)
  reviewModel: Repository<MissionReviewEntity>;

  /** OpenAI function-calling 格式的工具定义。传 whitelist 则只返回其中的工具。 */
  getToolDefs(whitelist?: string[]): any[] {
    // 运行函数没配好（本地 / 单测）就不把 run_code 交给模型，免得它调了只拿到「不可用」
    const all = this.allToolDefs().filter((t) => t.function.name !== 'run_code' || codeRunnerConfigured());
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
      {
        type: 'function',
        function: {
          name: 'get_mission_context',
          description:
            '获取用户正在做的实战题：题目需求、验收标准、当前进度，以及最近一次评审结论（逐条验收判定 + 补课清单）。用户问起自己的实战项目 / 作业 / 评审结果、或说卡住了时用它。不传 slug 则取最近在做的一道。',
          parameters: {
            type: 'object',
            properties: {
              slug: { type: 'string', description: '可选：题卡 slug；留空取用户最近在做的题' },
            },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'get_interview_bank',
          description:
            '从站内面经题库里按公司和/或考点关键词找真实面试题（附出处面经与答题思路要点）。用户要模拟面试、问某公司考什么、问某知识点在面试里怎么问时用它。',
          parameters: {
            type: 'object',
            properties: {
              company: { type: 'string', description: '可选：公司名，如 字节、阿里、腾讯' },
              topic: { type: 'string', description: '可选：考点关键词，如 RAG、Function Calling、防抖' },
              limit: { type: 'number', description: '返回题数，默认 6，最多 10' },
            },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'schedule_review',
          description:
            '把一篇站内文章加入用户的复习计划（间隔重复，已在计划里则不改动、只返回下次复习时间）。用户明确说要复习/记下来，或你判断他刚卡在这个知识点、值得过两天再巩固时用它。游客不可用。',
          parameters: {
            type: 'object',
            properties: {
              module: { type: 'string', description: '文章所属模块' },
              key: { type: 'string', description: '文章 key' },
            },
            required: ['module', 'key'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'run_code',
          description:
            '在隔离的运行环境里真正执行一段 JavaScript / TypeScript（Node 22，无网络、不能读写文件、最多 10 秒），返回输出和报错。' +
            '用来拿事实说话：验证用户贴来的代码在边界输入下的真实行为（自己补几行 console.log / assert 用例），' +
            '或核实某个语言行为（事件循环顺序、this 指向、类型转换等）。不要用它写成品代码给用户。',
          parameters: {
            type: 'object',
            properties: {
              language: { type: 'string', enum: ['javascript', 'typescript'], description: '默认 javascript' },
              code: { type: 'string', description: '完整可运行的代码（含你补的用例和 console.log 输出）' },
              stdin: { type: 'string', description: '可选：标准输入' },
            },
            required: ['code'],
          },
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
      case 'get_mission_context':
        return this.getMissionContext(args?.slug ? String(args.slug) : undefined, ctx);
      case 'get_interview_bank':
        return this.getInterviewBank(args?.company, args?.topic, args?.limit, ctx);
      case 'schedule_review':
        return this.scheduleReview(String(args?.module || ''), String(args?.key || ''), ctx);
      case 'run_code':
        return runCodeRemote(args);
      default:
        return `未知工具：${name}`;
    }
  }

  /** search_articles：融合词法（标题/标签）+ ngram（正文）两路召回。 */
  private async searchArticles(query: string, module: string | undefined, ctx: ToolContext): Promise<string> {
    if (!query.trim()) return '（未提供检索词）';
    const mod = module && CONTENT_MODULES.includes(module) ? module : undefined;

    const [lexical, content, semantic] = await Promise.all([
      this.retrieveService.retrieve(query, { module: mod, topK: 8 }).catch(() => []),
      this.articleContentService.search(query, { module: mod, limit: 8 }).catch(() => [] as ContentHit[]),
      // 第三路：embedding 语义召回（EMBEDDING_ENABLED 关闭时返回 []）
      this.embeddingService.semanticSearch(query, { module: mod, limit: 8 }).catch(() => []),
    ]);

    // 归一化后融合（正文命中略加权，因为它补的正是词法召回不到的部分）
    const maxLex = Math.max(1, ...lexical.map((h) => h.score));
    const maxCon = Math.max(1, ...content.map((h) => h.score));
    const maxSem = Math.max(0.01, ...semantic.map((h) => h.score));
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

    // 第三路：embedding 语义召回融合（语义相关但无字面命中的补齐）
    for (const h of semantic) {
      const k = `${h.module}:${h.articleKey}`;
      const semScore = (h.score / maxSem) * 0.55;
      const prev = merged.get(k);
      if (prev) {
        prev.score += semScore;
        if (!prev.title) prev.title = h.title;
      } else {
        merged.set(k, { module: h.module, articleKey: h.articleKey, title: h.title, snippet: '', score: semScore });
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

  /** get_mission_context：用户的实战题进度 + 验收标准 + 最近一次评审结论。 */
  private async getMissionContext(slug: string | undefined, ctx: ToolContext): Promise<string> {
    if (isGuest(ctx.userId)) return '当前是游客，没有实战题记录。可引导登录后领取实战题。';
    try {
      const where: any = { userId: ctx.userId, status: In(ACTIVE_SUBMISSION) };
      if (slug) where.missionSlug = slug;
      const subs = await this.submissionModel.find({ where, order: { updateTime: 'DESC' }, take: 3 });
      if (!subs.length) {
        return slug ? `用户没有在做 ${slug} 这道实战题。` : '用户目前没有进行中的实战题。';
      }
      const sub = subs[0];
      const mission = await this.missionModel.findOne({ where: { id: sub.missionId as any } });
      const lines: string[] = [];
      lines.push(`实战题：${mission?.title || sub.missionSlug}（slug=${sub.missionSlug}），状态：${SUBMISSION_STATUS[sub.status] || sub.status}，返工 ${sub.reworkCount || 0} 次。`);
      if (mission?.summary) lines.push(`简介：${sanitizeForPrompt(mission.summary, 200)}`);
      const reqs = asStringList(mission?.requirements);
      if (reqs.length) lines.push(`需求：\n${reqs.slice(0, 8).map((r, i) => `${i + 1}. ${sanitizeForPrompt(r, 160)}`).join('\n')}`);
      const criteria = Array.isArray(mission?.acceptanceCriteria) ? mission.acceptanceCriteria : [];
      if (criteria.length) {
        lines.push(
          `验收标准：\n${criteria
            .slice(0, 10)
            .map((c: any) => `- [${c.id}] ${sanitizeForPrompt(String(c.text || ''), 160)}${c.mustPass ? '（必过）' : ''}`)
            .join('\n')}`
        );
      }
      if (sub.planFeedback) lines.push(`方案审稿意见：${sanitizeForPrompt(sub.planFeedback, 400)}`);
      const review = await this.reviewModel.findOne({
        where: { submissionId: sub.id as any, userId: ctx.userId },
        order: { createTime: 'DESC' },
      });
      if (review) {
        lines.push(`最近一次评审：${REVIEW_VERDICT[review.verdict] || review.verdict}，总分 ${review.totalScore ?? '-'}。`);
        const items = Array.isArray(review.criteriaVerdicts) ? review.criteriaVerdicts : [];
        const notPassed = items.filter((it: any) => it && it.verdict && it.verdict !== 'pass');
        if (notPassed.length) {
          lines.push(
            `未通过的验收项：\n${notPassed
              .slice(0, 8)
              .map((it: any) => `- [${it.id}] ${sanitizeForPrompt(String(it.text || ''), 120)}：${sanitizeForPrompt(String(it.note || ''), 200)}`)
              .join('\n')}`
          );
        }
        const remedial = Array.isArray(review.makeupArticles) ? review.makeupArticles : [];
        if (remedial.length) {
          lines.push(`评审给的补课清单：${remedial.slice(0, 6).map((a: any) => `《${a.title}》(${a.module}/${a.key})`).join('、')}`);
          for (const a of remedial.slice(0, 6)) {
            if (a?.module && a?.key) ctx.citations.set(`${a.module}:${a.key}`, { module: a.module, articleKey: a.key, title: a.title || a.key });
          }
        }
      }
      for (const a of (Array.isArray(mission?.prereqArticles) ? mission.prereqArticles : []).slice(0, 4)) {
        if (a?.module && a?.key) ctx.citations.set(`${a.module}:${a.key}`, { module: a.module, articleKey: a.key, title: a.title || a.key });
      }
      if (subs.length > 1) lines.push(`另外还在做：${subs.slice(1).map((x) => x.missionSlug).join('、')}`);
      return lines.join('\n');
    } catch {
      return '读取实战题记录失败，按用户描述作答即可。';
    }
  }

  /** get_interview_bank：按公司 / 考点在面经题目索引里找真题。 */
  private async getInterviewBank(company: any, topic: any, limit: any, ctx: ToolContext): Promise<string> {
    const co = String(company || '').trim().toLowerCase();
    const tp = String(topic || '').trim().toLowerCase();
    const n = Math.min(Math.max(Number(limit) || 6, 1), 10);
    try {
      const { index } = await this.questionIndex.load();
      const pick = pickInterviewQuestions(index, co, tp, n);
      if (!pick.length) {
        return `面经题库里没找到${co ? `「${company}」` : ''}${tp ? `关于「${topic}」` : ''}的题。可以换个说法，或用 search_articles 搜相关知识点。`;
      }
      for (const p of pick) {
        ctx.citations.set(`interview:${p.articleKey}`, { module: 'interview', articleKey: p.articleKey, title: p.title });
      }
      return pick
        .map(
          (p, i) =>
            `${i + 1}. 【${p.company || '未知公司'}】${sanitizeForPrompt(p.question, 160)}\n   出处：《${p.title}》(interview/${p.articleKey})${
              p.answer ? `\n   答题思路要点：${sanitizeForPrompt(p.answer, 200)}` : ''
            }`
        )
        .join('\n');
    } catch {
      return '面经题库暂时读取失败。';
    }
  }

  /** schedule_review：幂等加入复习计划（已在计划里不改排程）。 */
  private async scheduleReview(module: string, key: string, ctx: ToolContext): Promise<string> {
    if (isGuest(ctx.userId)) return '游客没有复习计划，提示用户登录后可以加入复习。';
    if (!module || !key) return '（缺少 module 或 key）';
    if (!CONTENT_MODULES.includes(module)) return `未知模块 ${module}。`;
    try {
      const r = await this.articleService.ensureSchedule(ctx.userId, module, key);
      const when = new Date(r.dueAt + 8 * 3600 * 1000).toISOString().slice(5, 10).replace('-', '月') + '日';
      return r.created
        ? `已加入复习计划，${when}提醒复习。`
        : `这篇已经在复习计划里了，下次复习是${when}，没有改动。`;
    } catch {
      return '加入复习计划失败。';
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

const ACTIVE_SUBMISSION = ['claimed', 'plan_pending', 'building', 'submitted', 'reviewing', 'rework', 'passed'];

const SUBMISSION_STATUS: Record<string, string> = {
  claimed: '已领取',
  plan_pending: '指挥方案待审',
  building: '开发中',
  submitted: '已交作业',
  reviewing: '评审中',
  passed: '已通过',
  rework: '需返工',
};

const REVIEW_VERDICT: Record<string, string> = { pass: '通过', rework: '需返工', need_human: '待人工复核' };

function isGuest(userId?: string): boolean {
  return !userId || userId.startsWith('guest:');
}

function asStringList(v: any): string[] {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String(x?.text || ''))).filter(Boolean);
  return [];
}

/** 面经题挑选（纯函数，便于单测）：公司、考点都给时两者都要命中；同一篇面经最多取 2 题，避免一篇刷屏。 */
export function pickInterviewQuestions(
  index: { articleKey: string; title: string; company: string; questions: { key: string; question: string; answer: string }[] }[],
  company: string,
  topic: string,
  limit: number
): { articleKey: string; title: string; company: string; question: string; answer: string }[] {
  const co = company.toLowerCase();
  const tp = topic.toLowerCase();
  const out: { articleKey: string; title: string; company: string; question: string; answer: string }[] = [];
  for (const art of index) {
    if (co && !`${art.company} ${art.title}`.toLowerCase().includes(co)) continue;
    let taken = 0;
    for (const q of art.questions || []) {
      if (tp && !`${q.question} ${q.key}`.toLowerCase().includes(tp)) continue;
      out.push({ articleKey: art.articleKey, title: art.title, company: art.company, question: q.question, answer: q.answer });
      if (++taken >= 2 || out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// run_code：调用独立的 iris-code-runner 函数（runner/code-runner，见 s.yaml irisCodeRunner）

/** 运行器结果 → 给模型读的紧凑文本。去掉 Node 内部堆栈帧，留下真正的报错行。 */
export function formatRunResult(r: any): string {
  const lines: string[] = [];
  if (r?.timedOut) lines.push('结果：超时（超过时间上限被终止，可能有死循环）');
  else if (r?.signal) lines.push(`结果：进程被终止（${r.signal}，多半是内存超限）`);
  else lines.push(`结果：退出码 ${r?.exitCode}${r?.exitCode === 0 ? '（正常结束）' : '（出错）'}，耗时 ${r?.durationMs ?? '?'}ms`);
  const out = String(r?.stdout || '').trimEnd();
  lines.push(out ? `stdout：\n${out.slice(0, 2500)}` : 'stdout：（无输出）');
  const err = String(r?.stderr || '')
    .split('\n')
    .filter((l) => !/^\s+at (node:|.*\(node:)/.test(l) && !/^node:/.test(l) && !/^Node\.js v/.test(l))
    .join('\n')
    .trim();
  if (err) lines.push(`stderr：\n${err.slice(0, 1200)}`);
  if (r?.truncated) lines.push('（输出过长，已截断）');
  return lines.join('\n');
}

async function runCodeRemote(args: any): Promise<string> {
  if (!codeRunnerConfigured()) return '代码运行环境暂不可用，请直接根据代码推理作答，并说明没有实际运行。';
  const code = String(args?.code || '');
  if (!code.trim()) return '（未提供代码）';
  if (code.length > 20000) return '代码太长（超过 2 万字符），请只保留需要验证的部分。';
  try {
    const r = await callCodeRunner({
      language: args?.language === 'typescript' ? 'typescript' : 'javascript',
      code,
      stdin: args?.stdin ? String(args.stdin) : undefined,
    });
    return formatRunResult(r);
  } catch (e: any) {
    return `代码运行环境出错（${e?.name === 'TimeoutError' ? '超时' : e?.message || e}），这次没跑成。请根据代码推理作答，并说明没有实际运行。`;
  }
}
