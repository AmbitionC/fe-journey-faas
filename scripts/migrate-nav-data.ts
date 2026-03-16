/**
 * 数据迁移脚本：将前端 constants 中的导航数据写入 nav_config 表
 *
 * 使用方式：
 *   1. 将前端三个 constants 文件中的数组数据分别复制到下方对应变量中
 *   2. 运行: npx ts-node scripts/migrate-nav-data.ts
 *
 * 或者直接在 MySQL 中执行生成的 SQL 语句
 */
import * as mysql from 'mysql2/promise';

const DB_CONFIG = {
  host: 'rm-bp18fm5u5c7uk47558o.mysql.rds.aliyuncs.com',
  port: 3306,
  user: 'ch17394940726',
  password: 'Ch823147833',
  database: 'fe-journey',
};

// ============================================================
// 请将前端 constants 数据粘贴到这里
// 从 front-end-journey/src/pages/Interview/constants.tsx 复制 INTERVIEW_NAV_LIST
// 从 front-end-journey/src/pages/Knowledge/constants.tsx 复制 KNOWLEDGE_NAV_LIST
// 从 front-end-journey/src/pages/FirstClass/constants.tsx 复制 CLASS_NAV_LIST
// ============================================================

const INTERVIEW_NAV_LIST = [
  {
    label: '腾讯',
    key: 'Tencent',
    children: [
      {
        label: '总部',
        key: 'tencent-base',
        children: [
          { label: '腾讯实习一面', key: 'tencent-base-1', isLeaf: true, filePath: 'tencent/base' },
        ],
      },
      {
        label: '云与智慧产业CSIG',
        key: 'tencent-csig',
        children: [
          { label: '腾讯云智前端一面', key: 'tencent-csig-1', isLeaf: true, filePath: 'tencent/csig' },
          { label: '腾讯云智前端一面', key: 'tencent-csig-2', isLeaf: true, filePath: 'tencent/csig' },
          { label: '腾讯云智前端二面', key: 'tencent-csig-3', isLeaf: true, filePath: 'tencent/csig' },
        ],
      },
      {
        label: '平台与内容PCG',
        key: 'tencent-pcg',
        children: [
          { label: '腾讯QQ日常实习三面', key: 'tencent-pcg-1', isLeaf: true, filePath: 'tencent/pcg' },
        ],
      },
    ],
  },
  {
    label: '字节跳动',
    key: 'Bytedance',
    children: [
      {
        label: '总部',
        key: 'bytedance-base',
        children: [
          { label: '字节前端二面', key: 'bytedance-base-1', isLeaf: true, filePath: 'bytedance/base' },
          { label: '字节前端实习', key: 'bytedance-base-2', isLeaf: true, filePath: 'bytedance/base' },
          { label: '字节跳动前端一面', key: 'bytedance-base-3', isLeaf: true, filePath: 'bytedance/base' },
          { label: '字节跳动前端二面', key: 'bytedance-base-4', isLeaf: true, filePath: 'bytedance/base' },
        ],
      },
      {
        label: '抖音',
        key: 'bytedance-douyin',
        children: [
          { label: '字节抖音前端一面', key: 'bytedance-douyin-1', isLeaf: true, filePath: 'bytedance/douyin' },
        ],
      },
      {
        label: '智创',
        key: 'bytedance-create',
        children: [
          { label: '字节智创前端二面', key: 'bytedance-create-1', isLeaf: true, filePath: 'bytedance/create' },
        ],
      },
    ],
  },
  {
    label: '阿里巴巴',
    key: 'Alibaba',
    children: [
      {
        label: '淘天集团',
        key: 'alibaba-taotian',
        children: [
          { label: '阿里淘天前端一面', key: 'alibaba-taotian-1', isLeaf: true, filePath: 'alibaba/taotian' },
        ],
      },
      {
        label: '阿里云',
        key: 'alibaba-cloud',
        children: [
          { label: '阿里云前端秋招一面', key: 'alibaba-cloud-1', isLeaf: true, filePath: 'alibaba/cloud' },
          { label: '阿里云前端实习一面', key: 'alibaba-cloud-2', isLeaf: true, filePath: 'alibaba/cloud' },
        ],
      },
      {
        label: '本地生活',
        key: 'alibaba-local',
        children: [
          { label: '阿里飞猪前端实习二面', key: 'alibaba-local-1', isLeaf: true, filePath: 'alibaba/local' },
          { label: '阿里飞猪前端实习一面', key: 'alibaba-local-2', isLeaf: true, filePath: 'alibaba/local' },
          { label: '阿里饿了么前端一面', key: 'alibaba-local-3', isLeaf: true, filePath: 'alibaba/local' },
        ],
      },
    ],
  },
  {
    label: '蚂蚁金服',
    value: 'Antfin',
    children: [
      {
        label: '总部',
        key: 'antfin-base',
        children: [
          { label: '蚂蚁前端秋招一面', key: 'antfin-base-1', isLeaf: true, filePath: 'antfin/base' },
        ],
      },
    ],
  },
  {
    label: '美团',
    value: 'Meituan',
    children: [
      {
        label: '总部',
        key: 'meituan-base',
        children: [
          { label: '美团前端实习一面', key: 'meituan-base-1', isLeaf: true, filePath: 'meituan/base' },
          { label: '美团前端实习一面', key: 'meituan-base-2', isLeaf: true, filePath: 'meituan/base' },
          { label: '美团前端一面', key: 'meituan-base-3', isLeaf: true, filePath: 'meituan/base' },
          { label: '美团大前端一面', key: 'meituan-base-4', isLeaf: true, filePath: 'meituan/base' },
        ],
      },
      {
        label: '美团SaaS',
        key: 'meituan-saas',
        children: [
          { label: '美团SaaS前端一面', key: 'meituan-saas-1', isLeaf: true, filePath: 'meituan/saas' },
          { label: '美团SaaS前端实习一面', key: 'meituan-saas-2', isLeaf: true, filePath: 'meituan/saas' },
        ],
      },
    ],
  },
  {
    label: '小红书',
    value: 'Redbook',
    children: [
      {
        label: '总部',
        key: 'redbook-base',
        children: [
          { label: '小红书日常实习一面', key: 'redbook-base-1', isLeaf: true, filePath: 'redbook/base' },
          { label: '小红书日常实习二面', key: 'redbook-base-2', isLeaf: true, filePath: 'redbook/base' },
          { label: '小红书前端一面', key: 'redbook-base-3', isLeaf: true, filePath: 'redbook/base' },
          { label: '小红书前端二面', key: 'redbook-base-4', isLeaf: true, filePath: 'redbook/base' },
        ],
      },
    ],
  },
  {
    label: '滴滴',
    value: 'Didi',
    children: [
      {
        label: '总部',
        key: 'didi-base',
        children: [
          { label: '滴滴前端一面', key: 'didi-base-1', isLeaf: true, filePath: 'didi/base' },
        ],
      },
    ],
  },
  {
    label: '携程',
    value: 'Ctrip',
    children: [
      {
        label: '总部',
        key: 'ctrip-base',
        children: [
          { label: '携程前端一面', key: 'ctrip-base-1', isLeaf: true, filePath: 'ctrip/base' },
          { label: '携程前端二面', key: 'ctrip-base-2', isLeaf: true, filePath: 'ctrip/base' },
        ],
      },
    ],
  },
  {
    label: 'OPPO',
    key: 'OPPO',
    children: [
      {
        label: '总部',
        key: 'oppo-base',
        children: [
          { label: 'OPPO前端暑期实习一面', key: 'oppo-base-1', isLeaf: true, filePath: 'oppo/base' },
        ],
      },
    ],
  },
  {
    label: '蔚来',
    key: 'Nio',
    children: [
      {
        label: '总部',
        key: 'nio-base',
        children: [
          { label: '蔚来前端日常实习', key: 'nio-base-1', isLeaf: true, filePath: 'nio/base' },
        ],
      },
    ],
  },
  {
    label: '金山',
    key: 'Kingsoft',
    children: [
      {
        label: '总部',
        key: 'kingsoft-base',
        children: [
          { label: '金山前端面试总结', key: 'kingsoft-base-1', isLeaf: true, filePath: 'kingsoft/base' },
        ],
      },
    ],
  },
];

const CLASS_NAV_LIST = [
  {
    title: '导读',
    articles: [
      { subTitle: '从小白到一名合格的前端开发者', description: '我的求职历程和这门课程的框架', readTime: '8 mins', readCounts: 2314, key: 'intro-1', status: 'FINISHED' },
    ],
  },
  {
    title: '目标与心态',
    articles: [
      { subTitle: '如何制定适合自己的目标？', description: '确定合适的目标', readTime: '5 mins', readCounts: 1684, key: 'goal-1', status: 'FINISHED' },
      { subTitle: '如何调整好心态？', description: '调整好心态，轻装上阵', readTime: '6 mins', readCounts: 1563, key: 'goal-2', status: 'FINISHED' },
    ],
  },
  {
    title: '学习路径规划',
    articles: [
      { subTitle: '如何制定学习路径？', description: '我们应该怎么样制定学习计划？', readTime: '10 mins', readCounts: 2130, key: 'plan-1', status: 'FINISHED' },
      { subTitle: '如何高效地准备面试？', description: '如何针对面试进行有效学习？', readTime: '6 mins', readCounts: 2351, key: 'plan-2', status: 'FINISHED' },
    ],
  },
  {
    title: '前端知识体系',
    articles: [
      { subTitle: '计算机系统与网络', description: '计算机系统与网络相关知识点', readTime: '15 mins', readCounts: 1278, key: 'system-1', status: 'FINISHED' },
      { subTitle: 'HTML&CSS', description: 'HTML&CSS相关知识点', readTime: '13 mins', readCounts: 2193, key: 'system-2', status: 'FINISHED' },
      { subTitle: 'JavaScript/ES6/TypeScript', description: 'JS那些你必须要知道的知识', readTime: '20 mins', readCounts: 3567, key: 'system-3', status: 'FINISHED' },
      { subTitle: '前端框架', description: '前端框架相关知识点', readTime: '18 mins', readCounts: 4277, key: 'system-4', status: 'FINISHED' },
      { subTitle: '数据结构与算法', description: '数据结构与算法知识点', readTime: '18 mins', readCounts: 2357, key: 'system-5', status: 'FINISHED' },
      { subTitle: '前端纵向领域', description: '工程化、组件体系、数据可视化、AIGC相关拓展', readTime: '18 mins', readCounts: 2334, key: 'system-6', status: 'FINISHED' },
    ],
  },
  {
    title: '简历与项目',
    articles: [
      { subTitle: '如何写出一份高质量的简历？', description: '写简历必须要知道的雷区和重点', readTime: '15 mins', readCounts: 3578, key: 'resume-1', status: 'FINISHED' },
      { subTitle: '简历的项目部分应该怎么写？', description: '怎么样让自己的项目脱颖而出', readTime: '15 mins', readCounts: 5235, key: 'resume-2', status: 'FINISHED' },
    ],
  },
  {
    title: '面试技巧',
    articles: [
      { subTitle: '如何准备技术面试？', description: '技术面应该怎么准备', readTime: '12 mins', readCounts: 2357, key: 'interview-1', status: 'FINISHED' },
      { subTitle: '如何回答HR的一些问题？', description: 'HR面会有哪些问题，如何高情商回复', readTime: '15 mins', readCounts: 833, key: 'interview-2', status: 'FINISHED' },
    ],
  },
  {
    title: 'offer选择',
    articles: [
      { subTitle: '如何选择合适的offer', description: '如何选中理想中的offer', readTime: '12 mins', readCounts: 4234, key: 'offer-1', status: 'FINISHED' },
    ],
  },
];

// Knowledge 数据量较大，请从前端 constants 文件中完整复制 KNOWLEDGE_NAV_LIST
// 这里放一个占位，运行前请替换为完整数据
const KNOWLEDGE_NAV_LIST: any[] = [];

async function migrate() {
  console.log('开始迁移导航数据...');

  const connection = await mysql.createConnection(DB_CONFIG);

  const modules = [
    { module: 'interview', data: INTERVIEW_NAV_LIST },
    { module: 'knowledge', data: KNOWLEDGE_NAV_LIST },
    { module: 'firstclass', data: CLASS_NAV_LIST },
  ];

  for (const item of modules) {
    if (item.data.length === 0) {
      console.log(`跳过 ${item.module}（数据为空，请填充数据后重新运行）`);
      continue;
    }

    const jsonData = JSON.stringify(item.data);

    // UPSERT: 存在则更新，不存在则插入
    await connection.execute(
      `INSERT INTO nav_config (module, navData, version)
       VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE navData = VALUES(navData), version = version + 1`,
      [item.module, jsonData]
    );

    console.log(`✓ ${item.module} 导航数据已写入`);
  }

  await connection.end();
  console.log('迁移完成！');
}

migrate().catch((err) => {
  console.error('迁移失败:', err);
  process.exit(1);
});
