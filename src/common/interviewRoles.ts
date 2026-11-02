/**
 * 面经岗位分类，与网站面经页同一套规则（front-end-journey
 * `src/components/CatalogExplorer/interviewDimensions.ts` 的 roleGroupOf）：
 * 只看 role 字段和标题前缀（「：」之前），同一段命中多组时取位置最靠前的。
 * 那边改了归组规则，这里要一起改，否则 Skill 统计的篇数会和网站筛出来的对不上。
 *
 * 2026-11 起 Agent 开发、AI 应用开发、AI 全栈 / 前端合并为「Agent 全栈研发」。
 */

export const AGENT_STACK = 'Agent 全栈研发';
export type RoleGroup = typeof AGENT_STACK | '后端' | '算法' | '其他';

const ROLE_GROUPS: RoleGroup[] = [AGENT_STACK, '后端', '算法', '其他'];
const LEGACY_ROLE_GROUP: Record<string, RoleGroup> = {
  'Agent 开发': AGENT_STACK,
  'AI 应用开发': AGENT_STACK,
  'AI 全栈与前端': AGENT_STACK,
};

const ROLE_PATTERNS: [RoleGroup, RegExp][] = [
  [
    '算法',
    /大模型算法|应用算法|agent ?算法|推荐算法|多模态算法|算法(?:岗|工程师|实习|研究员)/iu,
  ],
  [
    AGENT_STACK,
    /全栈|前端|agent|智能体|ai ?应用|aigc|大模型应用|大模型研发|llm ?应用|ai ?开发|ai ?研发/iu,
  ],
  ['其他', /测开|测试开发|测试工程|ai ?测试|运维|sre|质量方向/iu],
  ['后端', /后端|后台|服务端|java|golang|c\+\+/iu],
];

const ROLE_CATEGORY_FALLBACK: Record<string, RoleGroup> = {
  后端工程: '后端',
  'AI 全栈': AGENT_STACK,
  'Agent 与全栈工程': AGENT_STACK,
  测试开发: '其他',
};

function titlePrefix(label: string): string {
  const cut = label.search(/[:：]/u);
  return cut < 0 ? label : label.slice(0, cut);
}

function earliestRole(text: string): RoleGroup | undefined {
  let best: { group: RoleGroup; at: number } | undefined;
  for (const [group, pattern] of ROLE_PATTERNS) {
    const at = text.search(pattern);
    if (at >= 0 && (!best || at < best.at)) best = { group, at };
  }
  return best?.group;
}

export interface RoleSource {
  title: string;
  role?: string;
  roleCategory?: string;
  roleGroup?: string;
}

export function roleGroupOf(n: RoleSource): RoleGroup {
  const explicit = n.roleGroup;
  if (explicit && ROLE_GROUPS.includes(explicit as RoleGroup))
    return explicit as RoleGroup;
  if (explicit && LEGACY_ROLE_GROUP[explicit])
    return LEGACY_ROLE_GROUP[explicit];
  return (
    (n.role && earliestRole(n.role)) ||
    earliestRole(titlePrefix(n.title)) ||
    (n.roleCategory && ROLE_CATEGORY_FALLBACK[n.roleCategory]) ||
    '其他'
  );
}

/** 检索词里指「Agent 全栈研发」这一类岗位的写法（含合并前的三个旧名）。「全栈」单写也算。 */
const AGENT_STACK_TERM =
  /^(?:agent)?全栈(?:研发|开发)?$|^ai全栈(?:开发)?$|^ai应用(?:开发)?$|^agent开发$/;

export function isAgentStackTerm(term: string): boolean {
  return AGENT_STACK_TERM.test(term.toLowerCase().replace(/\s+/g, ''));
}

/**
 * 「Agent 全栈研发」「AI 应用开发」这类带空格的岗位名先并成一个词，不被拆成「agent」「开发」。
 * 只并到词尾为止的整段：「AI 全栈实习」不并（并了反而和标题「AI 全栈实习」对不上）。
 */
export function joinRolePhrases(text: string): string {
  return text.replace(
    /(?:agent\s*全栈\s*(?:研发|开发)?|ai\s*全栈\s*(?:开发)?|ai\s*应用\s*开发|agent\s+开发)(?=\s|$)/giu,
    m => m.replace(/\s+/g, '')
  );
}
