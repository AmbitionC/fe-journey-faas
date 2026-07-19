import { Provide } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { ArticleContentEntity } from '../../entity/articleContent';
import { tokenize } from '../ai/lexicalSearch';
import { ALL_MODULES } from './modules';

/** search 返回项：正文命中的文章 + 片段。 */
export interface ContentHit {
  module: string;
  articleKey: string;
  title: string;
  filePath: string;
  snippet: string;
  score: number;
}

/**
 * 文章正文索引服务（教练地基 P0）。
 *
 * 职责：正文入库（供检索）、ngram 全文检索、全量回填、FULLTEXT 索引自愈。
 * 设计要点见 `docs/superpowers/specs/2026-07-19-coach-foundation-build-plan.md` §3.1/3.2。
 */
@Provide()
export class ArticleContentService {
  @InjectEntityModel(ArticleContentEntity)
  contentModel: Repository<ArticleContentEntity>;

  /** 进程内缓存：FULLTEXT 索引是否已确认存在，避免每次 search 都 SHOW INDEX。 */
  private ftEnsured = false;

  private static readonly FT_INDEX = 'ft_article_content_content';

  /**
   * 幂等自愈创建 ngram FULLTEXT 索引。
   * TypeORM 装饰器不支持 WITH PARSER ngram，synchronize 也可能不认/误删 FULLTEXT，
   * 故不声明在实体上，改为懒惰确保：先查存在性，缺失才 ALTER。redeploy 后新进程
   * 首次 search 自愈；失败不抛（由 search 降级 LIKE 兜底）。
   */
  async ensureFulltextIndex(): Promise<boolean> {
    if (this.ftEnsured) return true;
    try {
      const rows: any[] = await this.contentModel.query(
        `SHOW INDEX FROM article_content WHERE Key_name = ?`,
        [ArticleContentService.FT_INDEX]
      );
      if (!rows || rows.length === 0) {
        await this.contentModel.query(
          `ALTER TABLE article_content ADD FULLTEXT INDEX ${ArticleContentService.FT_INDEX} (content) WITH PARSER ngram`
        );
      }
      this.ftEnsured = true;
      return true;
    } catch {
      // 索引创建失败（权限/表未就绪）：不缓存成功，交由 search 走 LIKE 兜底。
      return false;
    }
  }

  /** 写入/更新一篇正文（按 module+articleKey 唯一）。 */
  async upsert(
    module: string,
    filePath: string,
    articleKey: string,
    title: string,
    content: string
  ): Promise<void> {
    if (!module || !articleKey) return;
    const existing = await this.contentModel.findOne({ where: { module, articleKey } });
    if (existing) {
      existing.filePath = filePath || '';
      if (title) existing.title = title;
      existing.content = content || '';
      existing.syncedAt = new Date();
      await this.contentModel.save(existing);
    } else {
      await this.contentModel.save(
        this.contentModel.create({
          module,
          articleKey,
          filePath: filePath || '',
          title: title || '',
          content: content || '',
          syncedAt: new Date(),
        })
      );
    }
  }

  /** 删除一篇正文。 */
  async remove(module: string, articleKey: string): Promise<void> {
    try {
      await this.contentModel.delete({ module, articleKey });
    } catch {
      /* 删除失败不阻断同步主流程 */
    }
  }

  /** 取单篇正文（read_article 工具用；返回 null 表示未入库）。 */
  async get(module: string, articleKey: string): Promise<ArticleContentEntity | null> {
    try {
      return await this.contentModel.findOne({ where: { module, articleKey } });
    } catch {
      return null;
    }
  }

  /** 已入库文章数（回填/健康检查用）。 */
  async count(): Promise<number> {
    try {
      return await this.contentModel.count();
    } catch {
      return 0;
    }
  }

  /**
   * ngram 全文检索（正文级召回）。失败自动降级 LIKE。
   * @returns 命中文章列表（含片段与相关度分），无匹配返回 []。
   */
  async search(query: string, opts: { module?: string; limit?: number } = {}): Promise<ContentHit[]> {
    const limit = Math.max(1, Math.min(50, opts.limit ?? 10));
    // ngram 需要 ≥2 长度的 token：英文词 + 中文二元组（单字被 ngram 忽略）。
    const terms = tokenize(query).filter((t) => t.length >= 2);
    if (!terms.length) return [];

    const ftReady = await this.ensureFulltextIndex();
    if (ftReady) {
      try {
        return await this.searchFulltext(terms, opts.module, limit);
      } catch {
        /* 落 LIKE 兜底 */
      }
    }
    return this.searchLike(terms, opts.module, limit);
  }

  /** BOOLEAN MODE 检索：token 以空格连接（OR 语义 + 相关度排序），召回优先。 */
  private async searchFulltext(
    terms: string[],
    module: string | undefined,
    limit: number
  ): Promise<ContentHit[]> {
    // BOOLEAN MODE：无 +/- 前缀时各 token 为可选项，命中越多分越高。
    // token 均为字母数字/中文（tokenize 产出），不含 BOOLEAN 操作符，安全。
    const boolExpr = terms.join(' ');
    const params: any[] = [boolExpr, boolExpr];
    let where = `MATCH(content) AGAINST(? IN BOOLEAN MODE)`;
    // 注意：AGAINST 在 SELECT 与 WHERE 各出现一次，占位符顺序对应 params。
    if (module) {
      where += ` AND module = ?`;
      params.push(module);
    }
    params.push(limit);
    const rows: any[] = await this.contentModel.query(
      `SELECT module, articleKey, title, filePath, content,
              MATCH(content) AGAINST(? IN BOOLEAN MODE) AS score
       FROM article_content
       WHERE ${where}
       ORDER BY score DESC
       LIMIT ?`,
      params
    );
    return (rows || []).map((r) => ({
      module: r.module,
      articleKey: r.articleKey,
      title: r.title || r.articleKey,
      filePath: r.filePath || '',
      snippet: this.makeSnippet(r.content || '', terms),
      score: Number(r.score) || 0,
    }));
  }

  /** LIKE 兜底：FULLTEXT 不可用时用前若干 token 模糊匹配，保证功能不崩。 */
  private async searchLike(
    terms: string[],
    module: string | undefined,
    limit: number
  ): Promise<ContentHit[]> {
    const picks = terms.slice(0, 4);
    const conds = picks.map(() => `content LIKE ?`).join(' OR ');
    const params: any[] = picks.map((t) => `%${t}%`);
    let where = `(${conds})`;
    if (module) {
      where += ` AND module = ?`;
      params.push(module);
    }
    params.push(limit);
    const rows: any[] = await this.contentModel.query(
      `SELECT module, articleKey, title, filePath, content
       FROM article_content
       WHERE ${where}
       LIMIT ?`,
      params
    );
    return (rows || []).map((r) => {
      const content: string = r.content || '';
      // 粗略打分：命中的不同 token 数
      const hit = picks.filter((t) => content.includes(t)).length;
      return {
        module: r.module,
        articleKey: r.articleKey,
        title: r.title || r.articleKey,
        filePath: r.filePath || '',
        snippet: this.makeSnippet(content, terms),
        score: hit,
      };
    }).sort((a, b) => b.score - a.score);
  }

  /** 从正文里截取首个命中 token 附近的片段，去掉多余空白。 */
  private makeSnippet(content: string, terms: string[], radius = 50): string {
    const text = content.replace(/\s+/g, ' ').trim();
    if (!text) return '';
    let idx = -1;
    for (const t of terms) {
      const p = text.indexOf(t);
      if (p >= 0) {
        idx = p;
        break;
      }
    }
    if (idx < 0) return text.slice(0, radius * 2) + (text.length > radius * 2 ? '…' : '');
    const start = Math.max(0, idx - radius);
    const end = Math.min(text.length, idx + radius);
    return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
  }

  /**
   * 全量回填：遍历各模块 nav 树，逐篇从 OSS 读取正文并入库。
   * 供 /content/reindex 调用；传入 getNavList / ossGet 以复用既有能力、避免循环依赖。
   */
  async backfillAll(
    getNavList: (module: string) => Promise<{ navData: any[] }>,
    ossGet: (module: string, filePath: string, key: string) => Promise<string>,
    opts: { modules?: string[] } = {}
  ): Promise<{ indexed: number; failed: number; errors: string[] }> {
    const modules = opts.modules?.length ? opts.modules : ALL_MODULES;
    const result = { indexed: 0, failed: 0, errors: [] as string[] };
    // 确保索引存在（回填后即可检索）
    await this.ensureFulltextIndex();

    for (const module of modules) {
      let leaves: { key: string; title: string; filePath: string }[] = [];
      try {
        const { navData } = await getNavList(module);
        leaves = this.flattenLeaves(navData || []);
      } catch (e: any) {
        result.errors.push(`nav ${module}: ${e?.message || e}`);
        continue;
      }
      for (const leaf of leaves) {
        try {
          const content = await ossGet(module, leaf.filePath, leaf.key);
          await this.upsert(module, leaf.filePath, leaf.key, leaf.title, content);
          result.indexed++;
        } catch (e: any) {
          result.failed++;
          if (result.errors.length < 20) {
            result.errors.push(`${module}/${leaf.key}: ${e?.message || e}`);
          }
        }
      }
    }
    return result;
  }

  /** 拍平 nav 树叶子，取 key/title/filePath（回填用）。 */
  private flattenLeaves(
    nodes: any[],
    acc: { key: string; title: string; filePath: string }[] = []
  ): { key: string; title: string; filePath: string }[] {
    if (!Array.isArray(nodes)) return acc;
    for (const node of nodes) {
      if (node.isLeaf === true && node.key) {
        acc.push({
          key: node.key,
          title: node.label || node.key,
          filePath: node.filePath || '',
        });
      }
      if (Array.isArray(node.children) && node.children.length) {
        this.flattenLeaves(node.children, acc);
      }
    }
    return acc;
  }
}
