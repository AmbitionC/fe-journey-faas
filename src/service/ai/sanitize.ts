/**
 * 提示词注入防护（PRD-07 P3 / README 5.4）。
 * 文章正文、用户输入进入提示词上下文前做清洗：中和常见的指令注入，并限长。
 * 纯函数，便于单测。
 */

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(the\s+)?(previous|above|prior)\s+(instructions?|prompts?)/gi,
  /disregard\s+(all\s+)?(previous|above|prior)/gi,
  /忽略(以上|上面|之前|前面)(的)?(所有)?(指令|提示|规则|要求)/g,
  /(system|assistant)\s*[:：]\s*/gi,
  /<\/?(system|assistant|user)>/gi,
  /你现在是[^。\n]{0,20}(管理员|开发者|系统)/g,
  /role\s*play|越狱|jailbreak|DAN\s*mode/gi,
];

// 控制字符（保留 \n=000A \t=0009）
const CONTROL_CHARS = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]', 'g');

/** 中和注入片段（替换为占位），去控制字符，并截断到 maxLen。 */
export function sanitizeForPrompt(text: string, maxLen = 6000): string {
  let out = String(text ?? '');
  for (const re of INJECTION_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, '[已过滤]');
  }
  out = out.replace(CONTROL_CHARS, '');
  if (out.length > maxLen) out = out.slice(0, maxLen) + '…';
  return out;
}

/** 是否检测到疑似注入（用于埋点/告警）。 */
export function looksInjected(text: string): boolean {
  const t = String(text ?? '');
  return INJECTION_PATTERNS.some((re) => {
    re.lastIndex = 0;
    return re.test(t);
  });
}
