import { Provide, Inject } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { ArticleService } from '../article';
import { ArticleContentEntity } from '../../entity/articleContent';
import { navIndex } from '../../mcp/tools/agent';
import {
  ArticleQuestions,
  buildQuestionIndex,
  leafKeysUnder,
} from '../../common/interviewTopics';

/** 进程内缓存：题目索引按目录版本失效，最长 10 分钟。 */
const INDEX_TTL_MS = 10 * 60 * 1000;

export interface InterviewQuestionIndex {
  version: string;
  at: number;
  /** 每篇面经 → 公司 + 题目（带考点 key 与第一段答题思路） */
  index: ArticleQuestions[];
  /** 知识点 key → 标题与路径 */
  knowledge: Map<string, { title: string; path: string }>;
  /** 「项目与职业」分类下的知识点（简历、自我介绍、反问这类非技术考点） */
  careerKeys: Set<string>;
}

let cached: InterviewQuestionIndex | null = null;

/**
 * 面经题目索引：考点榜、题单、按目标公司模拟面试共用一份。
 * 一次 SQL 读出全部面经正文解析，按面经与知识库目录版本缓存。
 */
@Provide()
export class InterviewQuestionIndexService {
  @Inject()
  articleService: ArticleService;

  @InjectEntityModel(ArticleContentEntity)
  contentModel: Repository<ArticleContentEntity>;

  async load(): Promise<InterviewQuestionIndex> {
    const [interview, knowledge] = await Promise.all([
      this.articleService.getNavList('interview'),
      this.articleService
        .getNavList('knowledge')
        .catch(() => ({ navData: [], version: 0 })),
    ]);
    const version = `${interview.version}:${knowledge.version}`;
    if (
      cached &&
      cached.version === version &&
      Date.now() - cached.at < INDEX_TTL_MS
    )
      return cached;
    const rows = await this.contentModel.find({
      where: { module: 'interview' },
      select: ['articleKey', 'content'],
    });
    const contents = new Map<string, string>(
      rows.map(r => [r.articleKey, r.content || ''])
    );
    cached = {
      version,
      at: Date.now(),
      index: buildQuestionIndex(interview.navData || [], contents),
      knowledge: navIndex(knowledge.navData || []),
      careerKeys: leafKeysUnder(knowledge.navData || [], 'career'),
    };
    return cached;
  }
}
