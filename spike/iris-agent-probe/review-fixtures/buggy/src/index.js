const OpenAI = require('openai');
const { getValidOutput } = require('./retry');

const client = new OpenAI({ baseURL: process.env.OPENAI_BASE_URL, apiKey: process.env.OPENAI_API_KEY });
const callModel = async (prompt) => {
  const r = await client.chat.completions.create({ model: process.env.LLM_MODEL, messages: [{ role: 'user', content: prompt }] });
  return r.choices[0].message.content;
};

getValidOutput(callModel, '从这段简历里抽取 name(string)、years(number)、skills(array)：张三，5 年前端，会 React 和 Node', {
  name: 'string',
  years: 'number',
  skills: 'array',
}).then((r) => console.log(JSON.stringify(r)));
