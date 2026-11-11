/** schema: { field: 'string' | 'number' | 'boolean' | 'array' }，全部必填。返回错误数组，空数组表示通过。 */
function validate(obj, schema) {
  const errors = [];
  if (!obj || typeof obj !== 'object') return ['不是对象'];
  for (const [key, type] of Object.entries(schema)) {
    if (!(key in obj)) {
      errors.push(`缺少字段 ${key}`);
      continue;
    }
    const v = obj[key];
    const ok = type === 'array' ? Array.isArray(v) : typeof v === type;
    if (!ok) errors.push(`字段 ${key} 应为 ${type}`);
  }
  return errors;
}
module.exports = { validate };
