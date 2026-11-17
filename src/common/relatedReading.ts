import type { ArticleQuestions } from './interviewTopics';

/**
 * 文末「接着看」（owner 2026-11-17 定的站内营销第一批）：读完一篇，按考点把知识点和面经连起来。
 *   - 知识点 → 问过这个考点的面经（带一句面试官原话，让人看到「真会被这么问」）；
 *   - 面经 → 这篇里的题对应的知识点（第一次出现的顺序，跳过简历 / 反问这类非技术考点）。
 * 只放纯函数；取数在 function/interviewTopics.ts。
 */
export const RELATED_LIMIT = 3;

export interface RelatedInterview {
  articleKey: string;
  title: string;
  company: string;
  question: string;
}

export interface RelatedKnowledge {
  key: string;
  title: string;
  question: string;
}

/** 问过这个知识点的面经：总篇数 + 前几篇（同一家公司只取一篇，看起来不重样） */
export function interviewsAskingKnowledge(
  index: ArticleQuestions[],
  knowledgeKey: string,
  limit = RELATED_LIMIT
): { total: number; items: RelatedInterview[] } {
  let total = 0;
  const items: RelatedInterview[] = [];
  const companies = new Set<string>();
  const backup: RelatedInterview[] = [];
  for (const a of index) {
    const q = a.questions.find(x => x.key === knowledgeKey);
    if (!q) continue;
    total += 1;
    const row = {
      articleKey: a.articleKey,
      title: a.title,
      company: a.company,
      question: q.question,
    };
    if (items.length < limit && !companies.has(a.company)) {
      companies.add(a.company);
      items.push(row);
    } else if (backup.length < limit) {
      backup.push(row);
    }
  }
  while (items.length < limit && backup.length) items.push(backup.shift()!);
  return { total, items };
}

/** 这篇面经考到的知识点（按出现顺序去重） */
export function knowledgeInInterview(
  index: ArticleQuestions[],
  articleKey: string,
  knowledgeTitles: Map<string, { title: string }>,
  skipKeys: Set<string> = new Set(),
  limit = RELATED_LIMIT
): RelatedKnowledge[] {
  const article = index.find(a => a.articleKey === articleKey);
  if (!article) return [];
  const out: RelatedKnowledge[] = [];
  const seen = new Set<string>();
  for (const q of article.questions) {
    if (seen.has(q.key) || skipKeys.has(q.key)) continue;
    const title = knowledgeTitles.get(q.key)?.title;
    if (!title) continue;
    seen.add(q.key);
    out.push({ key: q.key, title, question: q.question });
    if (out.length >= limit) break;
  }
  return out;
}
