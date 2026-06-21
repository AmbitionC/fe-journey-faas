/**
 * 站内内容检索——词法召回纯函数（PRD-02 F1-1 的第一期实现）。
 *
 * 说明：当前无向量库/嵌入服务凭证，先用「标题/路径/标签」词法打分召回，
 * 接口与 RetrieveService 解耦，后续可平滑替换为向量检索（见 PRD-07）。
 */

export interface SearchableLeaf {
  module: string;
  articleKey: string;
  title: string;
  /** 额外可检索文本：路径、标签等 */
  extra?: string;
}

export interface RetrievedItem {
  module: string;
  articleKey: string;
  title: string;
  score: number;
}

const CJK = /[一-龥]/;

/** 把查询切成 token：英文按词，中文按字 + 相邻二元组。 */
export function tokenize(q: string): string[] {
  const text = String(q || '').toLowerCase();
  const tokens = new Set<string>();
  // 英文/数字词
  for (const w of text.match(/[a-z0-9]+/g) || []) {
    if (w.length >= 2) tokens.add(w);
  }
  // 中文：单字 + 二元组
  const cjk = text.match(/[一-龥]+/g) || [];
  for (const seg of cjk) {
    for (let i = 0; i < seg.length; i++) {
      tokens.add(seg[i]);
      if (i + 1 < seg.length) tokens.add(seg.slice(i, i + 2));
    }
  }
  return [...tokens];
}

function leafText(leaf: SearchableLeaf): string {
  return `${leaf.title} ${leaf.extra || ''}`.toLowerCase();
}

/**
 * 对候选叶子打分并返回 Top-K。无匹配项不返回。
 * 评分：标题命中权重高于额外文本；整串命中给额外加成；二元组优于单字。
 */
export function lexicalSearch(
  query: string,
  leaves: SearchableLeaf[],
  topK = 3
): RetrievedItem[] {
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  const ql = String(query || '').toLowerCase().trim();

  const scored: RetrievedItem[] = [];
  for (const leaf of leaves) {
    const title = leaf.title.toLowerCase();
    const full = leafText(leaf);
    let score = 0;
    for (const t of tokens) {
      const w = CJK.test(t) ? (t.length > 1 ? 2 : 0.5) : t.length >= 4 ? 2 : 1;
      if (title.includes(t)) score += w * 2;
      else if (full.includes(t)) score += w;
    }
    // 整个查询子串命中标题：强信号
    if (ql.length >= 2 && title.includes(ql)) score += 8;
    if (score > 0) {
      scored.push({
        module: leaf.module,
        articleKey: leaf.articleKey,
        title: leaf.title,
        score: Math.round(score * 100) / 100,
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
