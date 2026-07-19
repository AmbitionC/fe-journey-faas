import { Provide, Config } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import fetch from 'node-fetch';
import { ContentEmbeddingEntity } from '../../entity/contentEmbedding';
import { QuestionClusterEntity } from '../../entity/questionCluster';
import { ArticleContentEntity } from '../../entity/articleContent';
import { R } from '../../common/base.error.utils';

interface CachedVec {
  module: string;
  articleKey: string;
  title: string;
  vec: Float32Array;
  norm: number;
}

/**
 * Embedding 服务（PRD-09 决策 8，阶段 2）。text-embedding-v4 自存向量 + FC 内存余弦，
 * 不引入向量数据库。三用途：检索语义第三路、面经题聚类、行为化推荐。
 */
@Provide()
export class EmbeddingService {
  @InjectEntityModel(ContentEmbeddingEntity)
  embModel: Repository<ContentEmbeddingEntity>;

  @InjectEntityModel(QuestionClusterEntity)
  clusterModel: Repository<QuestionClusterEntity>;

  @InjectEntityModel(ArticleContentEntity)
  contentModel: Repository<ArticleContentEntity>;

  @Config('embedding')
  embConfig: { baseUrl: string; apiKey: string; model: string };

  @Config('journey')
  journeyConfig: { embeddingEnabled: boolean };

  /** 内存向量缓存（Midway 服务默认单例，实例字段可跨请求复用）。 */
  private cache: CachedVec[] | null = null;
  private cacheAt = 0;
  private static CACHE_TTL = 5 * 60 * 1000;

  enabled(): boolean {
    return !!this.journeyConfig?.embeddingEnabled && !!this.embConfig?.apiKey;
  }

  /** 调用 embedding API，返回向量数组（自动分批）。 */
  async embed(texts: string[]): Promise<number[][]> {
    if (!this.embConfig?.apiKey) throw R.error('embedding 未配置 API key');
    const out: number[][] = [];
    const BATCH = 10;
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH).map((t) => (t || '').slice(0, 2000));
      const res = await fetch(`${this.embConfig.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.embConfig.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: this.embConfig.model, input: batch }),
        timeout: 20000,
      } as any);
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw R.error(`embedding 请求失败 (${res.status})${t ? ': ' + t : ''}`);
      }
      const json = (await res.json()) as any;
      const data = Array.isArray(json?.data) ? json.data : [];
      for (const d of data) out.push(d.embedding || []);
    }
    return out;
  }

  /** 写入/更新一篇文章向量。 */
  async upsertContent(module: string, articleKey: string, title: string, text: string): Promise<void> {
    const [vec] = await this.embed([`${title}。${text}`.slice(0, 2000)]);
    if (!vec || !vec.length) return;
    const b64 = floatsToBase64(vec);
    const existing = await this.embModel.findOne({ where: { module, articleKey } });
    if (existing) {
      existing.vector = b64;
      existing.dim = vec.length;
      existing.title = title || existing.title;
      existing.model = this.embConfig.model;
      await this.embModel.save(existing);
    } else {
      await this.embModel.save(
        this.embModel.create({ module, articleKey, title: title || '', vector: b64, dim: vec.length, model: this.embConfig.model })
      );
    }
    this.cache = null; // 失效缓存
  }

  /** 全量回填：对 article_content 逐篇生成向量（阶段 2 手动触发）。 */
  async backfillContent(modules?: string[]): Promise<{ indexed: number; failed: number }> {
    const where = modules?.length ? modules.map((m) => ({ module: m })) : undefined;
    const rows = await this.contentModel.find({ where: where as any });
    let indexed = 0;
    let failed = 0;
    for (const r of rows) {
      try {
        await this.upsertContent(r.module, r.articleKey, r.title, r.content);
        indexed++;
      } catch {
        failed++;
      }
    }
    this.cache = null;
    return { indexed, failed };
  }

  private async loadVectors(): Promise<CachedVec[]> {
    if (this.cache && Date.now() - this.cacheAt < EmbeddingService.CACHE_TTL) return this.cache;
    const rows = await this.embModel.find();
    this.cache = rows.map((r) => {
      const vec = base64ToFloats(r.vector);
      return { module: r.module, articleKey: r.articleKey, title: r.title, vec, norm: norm(vec) };
    });
    this.cacheAt = Date.now();
    return this.cache;
  }

  /** 语义检索（第三路）：embed 查询 → 内存余弦 → top-k。 */
  async semanticSearch(
    query: string,
    opts: { module?: string; limit?: number } = {}
  ): Promise<{ module: string; articleKey: string; title: string; score: number }[]> {
    if (!this.enabled() || !query.trim()) return [];
    const limit = opts.limit ?? 8;
    let qvec: Float32Array;
    try {
      const [v] = await this.embed([query]);
      if (!v?.length) return [];
      qvec = Float32Array.from(v);
    } catch {
      return [];
    }
    const qnorm = norm(qvec);
    const vectors = await this.loadVectors();
    const scored = vectors
      .filter((c) => !opts.module || c.module === opts.module)
      .map((c) => ({
        module: c.module,
        articleKey: c.articleKey,
        title: c.title,
        score: cosine(qvec, qnorm, c.vec, c.norm),
      }))
      .filter((x) => x.score > 0.2)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return scored;
  }

  // ---- 面经题聚类（PRD-05 F13b） ----

  /**
   * 对一批问题做聚类（余弦阈值 + 并查集）。items 未传时默认取 interview 模块文章标题为语料。
   * 重跑幂等：清空旧簇后重建。
   */
  async clusterInterview(
    items?: { text: string; company?: string; articleKey?: string }[],
    threshold = 0.82
  ): Promise<{ clusters: number }> {
    let corpus = items;
    if (!corpus?.length) {
      const rows = await this.contentModel.find({ where: { module: 'interview' } as any });
      corpus = rows.map((r) => ({ text: r.title || '', articleKey: r.articleKey }));
    }
    corpus = corpus.filter((c) => c.text && c.text.trim().length >= 4).slice(0, 500);
    if (!corpus.length) return { clusters: 0 };

    const vecs = await this.embed(corpus.map((c) => c.text));
    const fvs = vecs.map((v) => Float32Array.from(v));
    const norms = fvs.map((v) => norm(v));

    // 并查集
    const parent = corpus.map((_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    const union = (a: number, b: number) => {
      parent[find(a)] = find(b);
    };
    for (let i = 0; i < corpus.length; i++) {
      for (let j = i + 1; j < corpus.length; j++) {
        if (!fvs[i]?.length || !fvs[j]?.length) continue;
        if (cosine(fvs[i], norms[i], fvs[j], norms[j]) >= threshold) union(i, j);
      }
    }

    // 汇集簇
    const groups = new Map<number, number[]>();
    for (let i = 0; i < corpus.length; i++) {
      const root = find(i);
      (groups.get(root) || groups.set(root, []).get(root)!).push(i);
    }

    // 幂等：清空未人工确认的旧簇再重建（保留 curated）
    await this.clusterModel.delete({ curated: false });
    let count = 0;
    for (const idxs of groups.values()) {
      const texts = idxs.map((i) => corpus![i].text);
      const companies = [...new Set(idxs.map((i) => corpus![i].company).filter(Boolean))];
      const articleKeys = [...new Set(idxs.map((i) => corpus![i].articleKey).filter(Boolean))];
      await this.clusterModel.save(
        this.clusterModel.create({
          representative: texts[0].slice(0, 255),
          frequency: idxs.length,
          companies: companies.length ? companies : null,
          articleKeys: articleKeys.length ? articleKeys : null,
          variants: texts.slice(0, 8),
          curated: false,
        })
      );
      count++;
    }
    return { clusters: count };
  }

  /** 公司高频问题 TOP N（GET /interview/company-top）。 */
  async companyTop(company: string, n = 10): Promise<any> {
    const all = await this.clusterModel.find({ order: { frequency: 'DESC' } });
    const filtered = company
      ? all.filter((c) => Array.isArray(c.companies) && c.companies.some((x: string) => String(x).includes(company)))
      : all;
    return filtered.slice(0, n).map((c) => ({
      representative: c.representative,
      frequency: c.frequency,
      companies: c.companies || [],
      articleKeys: c.articleKeys || [],
    }));
  }
}

// ---- 向量工具 ----

function floatsToBase64(arr: number[]): string {
  const f32 = Float32Array.from(arr);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64');
}

function base64ToFloats(b64: string): Float32Array {
  const buf = Buffer.from(b64 || '', 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

function norm(v: Float32Array): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s) || 1;
}

function cosine(a: Float32Array, na: number, b: Float32Array, nb: number): number {
  const len = Math.min(a.length, b.length);
  if (!len) return 0;
  let dot = 0;
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot / (na * nb);
}
