/** 从模型输出中提取 JSON 对象；找不到返回 null。 */
function extractJson(text) {
  try {
    return JSON.parse(text.trim());
  } catch {
    return null;
  }
}
module.exports = { extractJson };
