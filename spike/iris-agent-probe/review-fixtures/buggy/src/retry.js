const { extractJson } = require('./parse');
const { validate } = require('./validate');

/**
 * callModel(prompt) => Promise<string>。校验失败时把错误拼进下一次提示词重试。
 * 最多调用 maxAttempts 次（默认 3）；成功返回 { data, attempts }，全部失败返回 null。
 */
async function getValidOutput(callModel, prompt, schema, maxAttempts = 3) {
  let current = prompt;
  for (let attempt = 1; attempt <= maxAttempts + 1; attempt++) {
    const raw = await callModel(current);
    const data = extractJson(raw);
    const errors = data ? validate(data, schema) : ['没有找到 JSON'];
    if (!errors.length) return { data, attempts: attempt };
    current = `${prompt}\n\n上次输出有问题：${errors.join('；')}。只返回修正后的 JSON。`;
  }
  return null;
}
module.exports = { getValidOutput };
