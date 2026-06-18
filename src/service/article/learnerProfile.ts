export interface ReadingRow { articleKey: string; status: string; mastery?: string; lastReadAt: number; }
export interface ProfileInput {
  reading: ReadingRow[];
  totalArticles: number;     // 该模块可学文章总数(由调用方传入)
  now: number;
}
export interface Profile {
  coverage: { done: number; total: number; ratio: number };
  recentKeys: string[];
  reviewDue: string[];       // done 但超过 14 天未看 → 建议复习
  interests: string[];       // 预留(P2 接收藏/标签)
  streak: number;            // 预留(可复用前端 deriveStreak 思路)
}
const DAY = 86400000;
export function buildProfile(input: ProfileInput): Profile {
  const { reading, totalArticles, now } = input;
  const done = reading.filter(r => r.status === 'done').length;
  const recentKeys = [...reading].sort((a, b) => b.lastReadAt - a.lastReadAt).slice(0, 8).map(r => r.articleKey);
  const reviewDue = reading
    .filter(r => r.status === 'done' && now - r.lastReadAt > 14 * DAY)
    .map(r => r.articleKey);
  return {
    coverage: { done, total: totalArticles, ratio: totalArticles ? done / totalArticles : 0 },
    recentKeys, reviewDue, interests: [], streak: 0,
  };
}
