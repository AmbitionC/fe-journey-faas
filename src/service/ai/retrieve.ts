import { Provide, Inject } from '@midwayjs/core';
import { ArticleService } from '../article';
import {
  lexicalSearch,
  SearchableLeaf,
  RetrievedItem,
} from './lexicalSearch';

const DEFAULT_MODULES = ['knowledge', 'interview'];

/**
 * 站内内容检索服务（PRD-02 F1-1/F1-2）。
 * 基于各模块导航树的标题/路径/标签做词法召回，给 Iris 回答引用与 PRD-01 复习推荐用。
 */
@Provide()
export class RetrieveService {
  @Inject()
  articleService: ArticleService;

  private flattenLeaves(module: string, nodes: any[], path: string[] = []): SearchableLeaf[] {
    const out: SearchableLeaf[] = [];
    if (!Array.isArray(nodes)) return out;
    for (const node of nodes) {
      const label = node.label || node.key || '';
      if (node.isLeaf === true) {
        const tags = Array.isArray(node.tags) ? node.tags.join(' ') : '';
        out.push({
          module,
          articleKey: node.key,
          title: label,
          extra: `${path.join(' ')} ${(node.filePath || '').replace(/[/_-]/g, ' ')} ${tags}`,
        });
      }
      if (Array.isArray(node.children) && node.children.length) {
        out.push(...this.flattenLeaves(module, node.children, [...path, label]));
      }
    }
    return out;
  }

  private async leavesOf(module: string): Promise<SearchableLeaf[]> {
    try {
      const { navData } = await this.articleService.getNavList(module);
      return this.flattenLeaves(module, navData || []);
    } catch {
      return [];
    }
  }

  /**
   * 召回站内文章。指定 module 则只在该模块检索，否则跨全部模块。
   */
  async retrieve(
    query: string,
    opts: { module?: string; topK?: number } = {}
  ): Promise<RetrievedItem[]> {
    const modules = opts.module ? [opts.module] : DEFAULT_MODULES;
    const leavesArr = await Promise.all(modules.map((m) => this.leavesOf(m)));
    const leaves = leavesArr.flat();
    return lexicalSearch(query, leaves, opts.topK ?? 3);
  }
}
