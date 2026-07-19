/**
 * AI 评测集——人工标注样例（PRD-02 F2-3）。
 * 规模小、可手工维护；离线 runner 按此跑指标。
 */

export interface GradeEvalCase {
  id: string;
  stem: string;
  keyPoints: string[];
  userAnswer: string;
  expectedVerdict: '对' | '部分对' | '错';
}

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
