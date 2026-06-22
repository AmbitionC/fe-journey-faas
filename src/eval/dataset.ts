/**
 * AI 评测集——人工标注样例（PRD-02 F2-3）。
 * 规模小、可手工维护；离线 runner 按此跑指标。
 */

export interface HintEvalCase {
  id: string;
  title: string;
  description: string;
  level: 1 | 2 | 3 | 4;
  /** 不应出现在提示里的答案关键词（出现即判剧透） */
  answerKeywords: string[];
}

export interface GradeEvalCase {
  id: string;
  stem: string;
  keyPoints: string[];
  userAnswer: string;
  expectedVerdict: '对' | '部分对' | '错';
}

export const HINT_CASES: HintEvalCase[] = [
  {
    id: 'two-sum-l1',
    title: '两数之和',
    description: '给定数组和目标值，返回两个数的下标，使它们的和为目标值。',
    level: 1,
    answerKeywords: ['哈希表', 'hashmap', 'map.get', '复杂度 o(n)', '用一个 map'],
  },
  {
    id: 'reverse-list-l2',
    title: '反转链表',
    description: '反转一个单链表。',
    level: 2,
    answerKeywords: ['prev', 'cur.next = prev', '三指针', '迭代反转'],
  },
];

export const GRADE_CASES: GradeEvalCase[] = [
  {
    id: 'debounce-correct',
    stem: '请解释防抖（debounce）的作用与典型场景。',
    keyPoints: ['高频触发只在停止后执行一次', '用定时器延迟', '搜索输入/resize 等场景'],
    userAnswer:
      '防抖是把高频触发的操作延迟到停止触发一段时间后只执行一次，常用 setTimeout 实现，典型用于搜索框输入、窗口 resize。',
    expectedVerdict: '对',
  },
  {
    id: 'debounce-partial',
    stem: '请解释防抖（debounce）的作用与典型场景。',
    keyPoints: ['高频触发只在停止后执行一次', '用定时器延迟', '搜索输入/resize 等场景'],
    userAnswer: '防抖就是让函数少执行几次。',
    expectedVerdict: '部分对',
  },
  {
    id: 'closure-wrong',
    stem: '什么是闭包？',
    keyPoints: ['函数与其词法作用域的引用', '可访问外层变量', '常用于私有变量/柯里化'],
    userAnswer: '闭包就是把网页关闭。',
    expectedVerdict: '错',
  },
];
