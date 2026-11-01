// 题卡（mission）首批种子：三张「前端转 Agent」实战题，按 ⚡小 / 🔨中 / 🏔大 各一张。
// 目的：Skill 与网站都在卖「实战题卡」，线上题库却是空的；先给出一批可做、可评审的真题。
// 幂等导入见 bootstrap/seedMissions.ts；后续题卡优先走管理后台维护，这里只保底。

export interface SeedMission {
  slug: string;
  title: string;
  tier: 'small' | 'medium' | 'large';
  estimate: string;
  difficulty: 1 | 2 | 3;
  summary: string;
  background: string;
  requirements: string[];
  constraints: string[];
  acceptanceCriteria: { id: string; text: string; mustPass?: boolean; weight?: number }[];
  prereqArticles: { module: 'knowledge'; key: string; title: string }[];
  sortOrder: number;
  status: 'published';
}

const K = (key: string, title: string) => ({ module: 'knowledge' as const, key, title });

export const MISSION_SEED: SeedMission[] = [
  {
    slug: 'structured-ticket-extractor',
    title: '把客服对话抽成结构化工单',
    tier: 'small',
    estimate: '2-4 小时',
    difficulty: 1,
    summary:
      '给一段客服聊天记录，让模型稳定输出符合 JSON Schema 的工单（问题类型、紧急度、涉及订单、下一步动作），并对非法输出做校验与重试。',
    background: [
      '## 业务背景',
      '',
      '客服团队每天要把几百条聊天记录手工整理成工单，字段固定但对话五花八门。',
      '你要做一个小工具：输入一段对话，输出一张结构化工单，供下游系统直接消费。',
      '',
      '难点不在「让模型吐 JSON」，而在于：模型偶尔会漏字段、编造订单号、把紧急度写成中文；',
      '下游系统一旦收到非法数据就会直接报错。',
    ].join('\n'),
    requirements: [
      '定义工单的 JSON Schema：category（枚举）、urgency（1-3）、orderIds（字符串数组，可为空）、nextAction（短句）、summary（不超过 60 字）。',
      '实现 extractTicket(dialog: string) 函数：调用模型并返回通过校验的工单对象。',
      '对模型输出做 Schema 校验；校验失败时携带错误信息重试一次，仍失败则抛出带原始输出的错误。',
      '对话里出现的订单号必须出现在原文中，不能由模型编造（用正则或字符串匹配做事实校验）。',
      '准备至少 8 条测试对话（含无订单号、多订单号、情绪激动、信息不全四类），全部跑通。',
    ],
    constraints: [
      '任意一家模型 API 均可，但 API Key 只能从环境变量读取，不得写进代码或提交到仓库。',
      '不得用正则从自然语言里「猜」字段，必须走结构化输出或工具调用。',
      '单次抽取的总耗时（含重试）不超过 20 秒。',
    ],
    acceptanceCriteria: [
      { id: 'schema', text: '输出对象能通过你定义的 JSON Schema 校验，且 8 条测试对话全部通过。', mustPass: true, weight: 3 },
      { id: 'grounding', text: '工单里的订单号都能在原对话中找到；测试集中包含「模型容易编造订单号」的用例并被拦下。', mustPass: true, weight: 3 },
      { id: 'retry', text: '校验失败有一次带错误信息的重试，二次失败时错误里带原始输出便于排查。', weight: 2 },
      { id: 'readme', text: 'README 说明 Schema 设计取舍、失败用例的处理方式，以及你认为还没解决的问题。', weight: 2 },
    ],
    prereqArticles: [
      K('prompt-structured-output', '结构化输出与 JSON Schema'),
      K('function-calling', 'Function Calling 与工具调用'),
      K('llm-error-retry-fallback', '超时、重试、Fallback 与错误处理'),
    ],
    sortOrder: 10,
    status: 'published',
  },
  {
    slug: 'docs-qa-with-citations',
    title: '给自己的文档库做一个带引用的问答',
    tier: 'medium',
    estimate: '1-2 天',
    difficulty: 2,
    summary:
      '把一组 Markdown 文档切块、向量化、建索引，做一个「先检索再回答、每句结论都带出处」的问答接口，并用一组固定问题评估召回与引用质量。',
    background: [
      '## 业务背景',
      '',
      '团队有几十篇内部文档（部署手册、接口说明、FAQ），新人提问时没人想翻。',
      '你要做一个问答服务：用户提问，系统只根据文档回答，并给出引用的文档与段落；',
      '文档里没有答案时要明确说「没找到」，而不是编一个。',
      '',
      '这题的坑在于「答案读起来不错」不等于「系统是对的」：引用错段落、检索对了生成却编造细节，都很常见。',
      '所以评估集是这题的一部分，不是附加题。',
    ].join('\n'),
    requirements: [
      '离线管线：读取 ≥20 篇 Markdown，按标题层级分块（保留文档名、标题路径、块序号），向量化后写入任意向量库或内存索引。',
      '在线接口 POST /ask：输入问题，返回 answer 与 citations（每条含文档名、标题路径、原文片段）。',
      '回答必须由检索到的片段支撑；检索结果相关度低于阈值时返回「文档中没有找到相关内容」。',
      '构造 ≥15 条评估问题（含 3 条文档里确实没有答案的问题），记录每条的命中片段、引用是否正确、是否拒答。',
      '写一份评估报告：Top-5 召回率、引用正确率、拒答正确率，以及你调过的一个参数（块长 / 重叠 / Top-K）前后对比。',
    ],
    constraints: [
      '不得把整篇文档塞进 prompt 绕过检索；单次问答送给模型的上下文不超过 4000 token。',
      '引用片段必须是原文，不允许由模型复述后当作引用。',
      '评估问题与期望答案在跑之前写好，不得事后按结果改题。',
    ],
    acceptanceCriteria: [
      { id: 'pipeline', text: '离线分块与索引可以一条命令重建，块里保留文档名与标题路径。', mustPass: true, weight: 2 },
      { id: 'citation', text: '每个回答都带原文引用，抽查 10 条引用片段均能在源文档中原样找到。', mustPass: true, weight: 3 },
      { id: 'refuse', text: '3 条「文档里没有答案」的问题至少 2 条正确拒答，没有编造。', mustPass: true, weight: 2 },
      { id: 'eval', text: '评估报告有数字（召回率 / 引用正确率 / 拒答正确率），且有一次参数调整的前后对比。', weight: 2 },
      { id: 'tradeoff', text: 'README 写清块长、Top-K、阈值的取舍理由，以及已知的失败案例。', weight: 1 },
    ],
    prereqArticles: [
      K('rag-pipeline', 'RAG 完整流程实战'),
      K('rag-chunking', '文本分块策略（Chunking）'),
      K('embedding-basics', 'Embedding 原理与向量相似度'),
      K('rag-citation-grounding', '引用溯源、Grounding 与事实一致性'),
      K('rag-evaluation', 'RAG 评估与优化'),
    ],
    sortOrder: 20,
    status: 'published',
  },
  {
    slug: 'issue-triage-agent',
    title: '做一个会自己查资料的 Issue 分诊 Agent',
    tier: 'large',
    estimate: '3-5 天',
    difficulty: 3,
    summary:
      '实现一个带工具的 Agent：读取一条 GitHub Issue，自行调用「搜代码」「查文档」「看历史 Issue」三个工具收集证据，给出归类、可能原因与复现步骤，带预算与终止条件，并有一套回放评测。',
    background: [
      '## 业务背景',
      '',
      '开源项目每天收到几十条 Issue，维护者要先分诊：是 bug 还是提问、哪个模块、能否复现、有没有重复。',
      '你要做一个分诊 Agent，它不能只「读一遍 Issue 就下结论」，而要像人一样去搜代码、翻文档、查历史 Issue，',
      '把证据攒够再下判断；证据不够时要说「需要提问者补充 X」。',
      '',
      '这题考的是 Agent 的工程骨架：工具契约怎么定、循环什么时候停、每一轮留下什么痕迹、怎么证明它比「直接问模型」更靠谱。',
    ].join('\n'),
    requirements: [
      '定义三个工具并写清契约（参数 Schema、返回结构、错误语义、副作用为零）：search_code、read_doc、find_similar_issues。工具可对本地仓库快照实现，不要求真连 GitHub API。',
      '实现 Agent 循环：每轮记录观察、决策、调用与结果（trace），设置最大轮数与 token 预算，超限时输出「已有证据 + 未解决问题」而不是硬给结论。',
      '输出结构固定：type（bug / question / feature / duplicate）、module、confidence、evidence（引用的代码/文档/Issue 列表）、reproSteps 或 needInfo。',
      '准备 ≥20 条历史 Issue（含已知答案）做回放评测：统计归类准确率、重复识别准确率、平均轮数与平均 token；与「不带工具直接问模型」的基线对比。',
      '对至少一种工具故障（超时 / 返回空）做处理，Agent 能降级而不是崩掉或无限重试。',
    ],
    constraints: [
      '工具只读，不允许任何写操作（评论、打标签）由 Agent 直接执行；输出只是建议。',
      '最大轮数 ≤ 8，单条 Issue 总成本要可统计并写进评测报告。',
      '评测集在实现前冻结，评测结果要能一条命令复现。',
    ],
    acceptanceCriteria: [
      { id: 'tools', text: '三个工具有明确契约，非法参数被工具侧拒绝而不是靠 prompt 约束。', mustPass: true, weight: 2 },
      { id: 'loop', text: '每条 Issue 的 trace 可查看每轮的决策与工具结果；超预算时有明确的「未完成」终态。', mustPass: true, weight: 3 },
      { id: 'evidence', text: '结论里的 evidence 都能定位到仓库快照中的真实文件或 Issue，抽查 10 条无编造。', mustPass: true, weight: 3 },
      { id: 'eval', text: '回放评测有与基线的对比数字（准确率 / 轮数 / token），并给出哪类 Issue 上 Agent 不如基线。', weight: 2 },
      { id: 'failure', text: '工具超时或返回空时 Agent 能降级完成，且 trace 里能看到降级原因。', weight: 1 },
    ],
    prereqArticles: [
      K('agent-tool-design', 'Agent 工具契约、Schema 与错误语义'),
      K('agent-run-loop', 'Agent Run Loop、轮次与终止条件'),
      K('agent-react', 'ReAct：推理与行动框架'),
      K('agent-memory', '短期记忆、长期记忆与检索'),
      K('agent-evaluation', '智能体性能评估'),
      K('llm-error-retry-fallback', '超时、重试、Fallback 与错误处理'),
    ],
    sortOrder: 30,
    status: 'published',
  },
];
