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
          {
            label: '腾讯实习一面',
            key: 'tencent-base-1',
            isLeaf: true,
            filePath: 'tencent/base',
          },
        ],
      },
      {
        label: '云与智慧产业CSIG',
        key: 'tencent-csig',
        children: [
          {
            label: '腾讯云智前端一面',
            key: 'tencent-csig-1',
            isLeaf: true,
            filePath: 'tencent/csig',
          },
          {
            label: '腾讯云智前端一面',
            key: 'tencent-csig-2',
            isLeaf: true,
            filePath: 'tencent/csig',
          },
          {
            label: '腾讯云智前端二面',
            key: 'tencent-csig-3',
            isLeaf: true,
            filePath: 'tencent/csig',
          },
        ],
      },
      {
        label: '平台与内容PCG',
        key: 'tencent-pcg',
        children: [
          {
            label: '腾讯QQ日常实习三面',
            key: 'tencent-pcg-1',
            isLeaf: true,
            filePath: 'tencent/pcg',
          },
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
          {
            label: '字节前端二面',
            key: 'bytedance-base-1',
            isLeaf: true,
            filePath: 'bytedance/base',
          },
          {
            label: '字节前端实习',
            key: 'bytedance-base-2',
            isLeaf: true,
            filePath: 'bytedance/base',
          },
          {
            label: '字节跳动前端一面',
            key: 'bytedance-base-3',
            isLeaf: true,
            filePath: 'bytedance/base',
          },
          {
            label: '字节跳动前端二面',
            key: 'bytedance-base-4',
            isLeaf: true,
            filePath: 'bytedance/base',
          },
        ],
      },
      {
        label: '抖音',
        key: 'bytedance-douyin',
        children: [
          {
            label: '字节抖音前端一面',
            key: 'bytedance-douyin-1',
            isLeaf: true,
            filePath: 'bytedance/douyin',
          },
        ],
      },
      {
        label: '智创',
        key: 'bytedance-create',
        children: [
          {
            label: '字节智创前端二面',
            key: 'bytedance-create-1',
            isLeaf: true,
            filePath: 'bytedance/create',
          },
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
          {
            label: '阿里淘天前端一面',
            key: 'alibaba-taotian-1',
            isLeaf: true,
            filePath: 'alibaba/taotian',
          },
        ],
      },
      {
        label: '阿里云',
        key: 'alibaba-cloud',
        children: [
          {
            label: '阿里云前端秋招一面',
            key: 'alibaba-cloud-1',
            isLeaf: true,
            filePath: 'alibaba/cloud',
          },
          {
            label: '阿里云前端实习一面',
            key: 'alibaba-cloud-2',
            isLeaf: true,
            filePath: 'alibaba/cloud',
          },
        ],
      },
      {
        label: '本地生活',
        key: 'alibaba-local',
        children: [
          {
            label: '阿里飞猪前端实习二面',
            key: 'alibaba-local-1',
            isLeaf: true,
            filePath: 'alibaba/local',
          },
          {
            label: '阿里飞猪前端实习一面',
            key: 'alibaba-local-2',
            isLeaf: true,
            filePath: 'alibaba/local',
          },
          {
            label: '阿里饿了么前端一面',
            key: 'alibaba-local-3',
            isLeaf: true,
            filePath: 'alibaba/local',
          },
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
          {
            label: '蚂蚁前端秋招一面',
            key: 'antfin-base-1',
            isLeaf: true,
            filePath: 'antfin/base',
          },
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
          {
            label: '美团前端实习一面',
            key: 'meituan-base-1',
            isLeaf: true,
            filePath: 'meituan/base',
          },
          {
            label: '美团前端实习一面',
            key: 'meituan-base-2',
            isLeaf: true,
            filePath: 'meituan/base',
          },
          {
            label: '美团前端一面',
            key: 'meituan-base-3',
            isLeaf: true,
            filePath: 'meituan/base',
          },
          {
            label: '美团大前端一面',
            key: 'meituan-base-4',
            isLeaf: true,
            filePath: 'meituan/base',
          },
        ],
      },
      {
        label: '美团SaaS',
        key: 'meituan-saas',
        children: [
          {
            label: '美团SaaS前端一面',
            key: 'meituan-saas-1',
            isLeaf: true,
            filePath: 'meituan/saas',
          },
          {
            label: '美团SaaS前端实习一面',
            key: 'meituan-saas-2',
            isLeaf: true,
            filePath: 'meituan/saas',
          },
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
          {
            label: '小红书日常实习一面',
            key: 'redbook-base-1',
            isLeaf: true,
            filePath: 'redbook/base',
          },
          {
            label: '小红书日常实习二面',
            key: 'redbook-base-2',
            isLeaf: true,
            filePath: 'redbook/base',
          },
          {
            label: '小红书前端一面',
            key: 'redbook-base-3',
            isLeaf: true,
            filePath: 'redbook/base',
          },
          {
            label: '小红书前端二面',
            key: 'redbook-base-4',
            isLeaf: true,
            filePath: 'redbook/base',
          },
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
          {
            label: '滴滴前端一面',
            key: 'didi-base-1',
            isLeaf: true,
            filePath: 'didi/base',
          },
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
          {
            label: '携程前端一面',
            key: 'ctrip-base-1',
            isLeaf: true,
            filePath: 'ctrip/base',
          },
          {
            label: '携程前端二面',
            key: 'ctrip-base-2',
            isLeaf: true,
            filePath: 'ctrip/base',
          },
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
          {
            label: 'OPPO前端暑期实习一面',
            key: 'oppo-base-1',
            isLeaf: true,
            filePath: 'oppo/base',
          },
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
          {
            label: '蔚来前端日常实习',
            key: 'nio-base-1',
            isLeaf: true,
            filePath: 'nio/base',
          },
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
          {
            label: '金山前端面试总结',
            key: 'kingsoft-base-1',
            isLeaf: true,
            filePath: 'kingsoft/base',
          },
        ],
      },
    ],
  },
];

const CLASS_NAV_LIST = [
  {
    title: '导读',
    articles: [
      {
        subTitle: '从小白到一名合格的前端开发者',
        description: '我的求职历程和这门课程的框架',
        readTime: '8 mins',
        readCounts: 2314,
        key: 'intro-1',
        status: 'FINISHED',
      },
    ],
  },
  {
    title: '目标与心态',
    articles: [
      {
        subTitle: '如何制定适合自己的目标？',
        description: '确定合适的目标',
        readTime: '5 mins',
        readCounts: 1684,
        key: 'goal-1',
        status: 'FINISHED',
      },
      {
        subTitle: '如何调整好心态？',
        description: '调整好心态，轻装上阵',
        readTime: '6 mins',
        readCounts: 1563,
        key: 'goal-2',
        status: 'FINISHED',
      },
    ],
  },
  {
    title: '学习路径规划',
    articles: [
      {
        subTitle: '如何制定学习路径？',
        description: '我们应该怎么样制定学习计划？',
        readTime: '10 mins',
        readCounts: 2130,
        key: 'plan-1',
        status: 'FINISHED',
      },
      {
        subTitle: '如何高效地准备面试？',
        description: '如何针对面试进行有效学习？',
        readTime: '6 mins',
        readCounts: 2351,
        key: 'plan-2',
        status: 'FINISHED',
      },
    ],
  },
  {
    title: '前端知识体系',
    articles: [
      {
        subTitle: '计算机系统与网络',
        description: '计算机系统与网络相关知识点',
        readTime: '15 mins',
        readCounts: 1278,
        key: 'system-1',
        status: 'FINISHED',
      },
      {
        subTitle: 'HTML&CSS',
        description: 'HTML&CSS相关知识点',
        readTime: '13 mins',
        readCounts: 2193,
        key: 'system-2',
        status: 'FINISHED',
      },
      {
        subTitle: 'JavaScript/ES6/TypeScript',
        description: 'JS那些你必须要知道的知识',
        readTime: '20 mins',
        readCounts: 3567,
        key: 'system-3',
        status: 'FINISHED',
      },
      {
        subTitle: '前端框架',
        description: '前端框架相关知识点',
        readTime: '18 mins',
        readCounts: 4277,
        key: 'system-4',
        status: 'FINISHED',
      },
      {
        subTitle: '数据结构与算法',
        description: '数据结构与算法知识点',
        readTime: '18 mins',
        readCounts: 2357,
        key: 'system-5',
        status: 'FINISHED',
      },
      {
        subTitle: '前端纵向领域',
        description: '工程化、组件体系、数据可视化、AIGC相关拓展',
        readTime: '18 mins',
        readCounts: 2334,
        key: 'system-6',
        status: 'FINISHED',
      },
    ],
  },
  {
    title: '简历与项目',
    articles: [
      {
        subTitle: '如何写出一份高质量的简历？',
        description: '写简历必须要知道的雷区和重点',
        readTime: '15 mins',
        readCounts: 3578,
        key: 'resume-1',
        status: 'FINISHED',
      },
      {
        subTitle: '简历的项目部分应该怎么写？',
        description: '怎么样让自己的项目脱颖而出',
        readTime: '15 mins',
        readCounts: 5235,
        key: 'resume-2',
        status: 'FINISHED',
      },
    ],
  },
  {
    title: '面试技巧',
    articles: [
      {
        subTitle: '如何准备技术面试？',
        description: '技术面应该怎么准备',
        readTime: '12 mins',
        readCounts: 2357,
        key: 'interview-1',
        status: 'FINISHED',
      },
      {
        subTitle: '如何回答HR的一些问题？',
        description: 'HR面会有哪些问题，如何高情商回复',
        readTime: '15 mins',
        readCounts: 833,
        key: 'interview-2',
        status: 'FINISHED',
      },
    ],
  },
  {
    title: 'offer选择',
    articles: [
      {
        subTitle: '如何选择合适的offer',
        description: '如何选中理想中的offer',
        readTime: '12 mins',
        readCounts: 4234,
        key: 'offer-1',
        status: 'FINISHED',
      },
    ],
  },
];

const KNOWLEDGE_NAV_LIST: any[] = [
  {
    label: '导语',
    key: 'intro',
    children: [
      { label: '导语', key: 'introduce', isLeaf: true, filePath: 'intro' },
    ],
  },
  {
    label: 'JavaScript/ES6/TypeScript',
    key: 'js-es6-ts',
    children: [
      {
        label: 'JavaScript',
        key: 'js',
        children: [
          {
            label: '事件循环机制',
            key: 'event-loop',
            isLeaf: true,
            filePath: 'js-es6-ts/js',
          },
          {
            label: '宏任务与微任务',
            key: 'macro-micro-task',
            isLeaf: true,
            filePath: 'js-es6-ts/js',
          },
          {
            label: 'setTimeout产生误差原因',
            key: 'setTimeout-error',
            isLeaf: true,
            filePath: 'js-es6-ts/js',
          },
          {
            label: '如何判断数据类型',
            key: 'data-type',
            isLeaf: true,
            filePath: 'js-es6-ts/js',
          },
          {
            label: 'Array常见的方法',
            key: 'array-function',
            isLeaf: true,
            filePath: 'js-es6-ts/js',
          },
          {
            label: 'String常见的方法',
            key: 'string-function',
            isLeaf: true,
            filePath: 'js-es6-ts/js',
          },
          {
            label: 'Object常见的方法',
            key: 'object-function',
            isLeaf: true,
            filePath: 'js-es6-ts/js',
          },
          {
            label: 'map和reduce方法',
            key: 'map-reduce',
            isLeaf: true,
            filePath: 'js-es6-ts/js',
          },
          {
            label: '浏览器输入URL过程',
            key: 'input-url',
            isLeaf: true,
            filePath: 'js-es6-ts/js',
          },
          {
            label: 'Array.sort实现原理',
            key: 'array-sort',
            isLeaf: true,
            filePath: 'js-es6-ts/js',
          },
          {
            label: '深拷贝和浅拷贝的区别',
            key: 'deep-clone',
            isLeaf: true,
            filePath: 'js-es6-ts/js',
          },
          {
            label: 'JS的垃圾回收机制',
            key: 'js-trunk',
            isLeaf: true,
            filePath: 'js-es6-ts/js',
          },
          {
            label: '作用域和作用域链、执行期上下文',
            key: 'js-scope',
            isLeaf: true,
            filePath: 'js-es6-ts/js',
          },
          {
            label: '防抖和节流',
            key: 'debounce-throttle',
            isLeaf: true,
            filePath: 'js-es6-ts/js',
          },
          {
            label: '原型和原型链',
            key: 'prototype',
            isLeaf: true,
            filePath: 'js-es6-ts/js',
          },
          {
            label: '回流（Reflow）和重绘（Repaints）',
            key: 'reflow-repaints',
            isLeaf: true,
            filePath: 'js-es6-ts/js',
          },
          {
            label: '"=="和"==="的区别',
            key: 'equals',
            isLeaf: true,
            filePath: 'js-es6-ts/js',
          },
          {
            label: '继承的实现方式及差异',
            key: 'extends',
            isLeaf: true,
            filePath: 'js-es6-ts/js',
          },
          {
            label: '闭包及其作用',
            key: 'closure',
            isLeaf: true,
            filePath: 'js-es6-ts/js',
          },
          {
            label: 'JS的arguments',
            key: 'arguments',
            isLeaf: true,
            filePath: 'js-es6-ts/js',
          },
          {
            label: 'new一个类的原理',
            key: 'new-class',
            isLeaf: true,
            filePath: 'js-es6-ts/js',
          },
          {
            label: 'DOM常见的操作方式',
            key: 'dom-function',
            isLeaf: true,
            filePath: 'js-es6-ts/js',
          },
          {
            label: 'addEventListener和onClick的区别',
            key: 'eventListener',
            isLeaf: true,
            filePath: 'js-es6-ts/js',
          },
          {
            label: 'Ajax请求的过程',
            key: 'ajax-request',
            isLeaf: true,
            filePath: 'js-es6-ts/js',
          },
          {
            label: 'bind/call/apply的区别',
            key: 'bind-call',
            isLeaf: true,
            filePath: 'js-es6-ts/js',
          },
          {
            label: '原始值和引用值的区别',
            key: 'origin-link-address',
            isLeaf: true,
            filePath: 'js-es6-ts/js',
          },
          {
            label: '如何正确判断this指向',
            key: 'this-pointer',
            isLeaf: true,
            filePath: 'js-es6-ts/js',
          },
          {
            label: 'new和Object.create的区别',
            key: 'new-object',
            isLeaf: true,
            filePath: 'js-es6-ts/js',
          },
          {
            label: 'BOM属性对象方法',
            key: 'bom-function',
            isLeaf: true,
            filePath: 'js-es6-ts/js',
          },
          {
            label: '函数柯里化及其通用封装',
            key: 'curry',
            isLeaf: true,
            filePath: 'js-es6-ts/js',
          },
          {
            label: 'prototype和__proto__的区别',
            key: 'prototype-proto',
            isLeaf: true,
            filePath: 'js-es6-ts/js',
          },
          {
            label: 'DOM的location对象',
            key: 'dom-location',
            isLeaf: true,
            filePath: 'js-es6-ts/js',
          },
          {
            label: '类数组与数组的区别与转换',
            key: 'array-like-object',
            isLeaf: true,
            filePath: 'js-es6-ts/js',
          },
        ],
      },
      {
        label: 'ES6',
        key: 'es6',
        children: [
          {
            label: '变量的结构赋值',
            key: 'es6-deconstruction',
            isLeaf: true,
            filePath: 'js-es6-ts/es6',
          },
          {
            label: '箭头函数与this指向',
            key: 'es6-arrow',
            isLeaf: true,
            filePath: 'js-es6-ts/es6',
          },
          {
            label: 'Promise概念',
            key: 'promise',
            isLeaf: true,
            filePath: 'js-es6-ts/es6',
          },
          {
            label: 'Promise的API',
            key: 'promise-api',
            isLeaf: true,
            filePath: 'js-es6-ts/es6',
          },
          {
            label: '几种异步方式的比较',
            key: 'async-compare',
            isLeaf: true,
            filePath: 'js-es6-ts/es6',
          },
          {
            label: 'CommonJS和ESModule区别',
            key: 'commonjs-esmodule',
            isLeaf: true,
            filePath: 'js-es6-ts/es6',
          },
          {
            label: 'Iterator的实现',
            key: 'iterator',
            isLeaf: true,
            filePath: 'js-es6-ts/es6',
          },
          {
            label: 'class基本语法与继承',
            key: 'class',
            isLeaf: true,
            filePath: 'js-es6-ts/es6',
          },
          {
            label: '循环的比较和使用场景',
            key: 'es6-loop',
            isLeaf: true,
            filePath: 'js-es6-ts/es6',
          },
          {
            label: 'let/const和var的区别',
            key: 'let-const',
            isLeaf: true,
            filePath: 'js-es6-ts/es6',
          },
          {
            label: '变量提升和暂时性死区',
            key: 'hoisting-tdz',
            isLeaf: true,
            filePath: 'js-es6-ts/es6',
          },
          {
            label: 'Set和Map的区别',
            key: 'set-map',
            isLeaf: true,
            filePath: 'js-es6-ts/es6',
          },
          {
            label: 'async函数概念',
            key: 'async',
            isLeaf: true,
            filePath: 'js-es6-ts/es6',
          },
          {
            label: 'Proxy的概念与使用',
            key: 'proxy',
            isLeaf: true,
            filePath: 'js-es6-ts/es6',
          },
          {
            label: 'Symbol的概念与使用',
            key: 'symbol',
            isLeaf: true,
            filePath: 'js-es6-ts/es6',
          },
          {
            label: 'Generator的概念与使用',
            key: 'generator',
            isLeaf: true,
            filePath: 'js-es6-ts/es6',
          },
          {
            label: 'Reflect的概念与使用',
            key: 'reflect',
            isLeaf: true,
            filePath: 'js-es6-ts/es6',
          },
        ],
      },
      {
        label: 'TypeScript',
        key: 'ts',
        children: [
          {
            label: 'TypeScript与JavaScript 的主要区别是什么',
            key: 'ts-js-difference',
            isLeaf: true,
            filePath: 'js-es6-ts/ts',
          },
          {
            label: 'TypeScript的类型系统',
            key: 'type-system',
            isLeaf: true,
            filePath: 'js-es6-ts/ts',
          },
          {
            label: 'TypeScript中的泛型有什么用途',
            key: 'ts-generics',
            isLeaf: true,
            filePath: 'js-es6-ts/ts',
          },
          {
            label: 'TypeScript中的装饰器是什么',
            key: 'ts-decorator',
            isLeaf: true,
            filePath: 'js-es6-ts/ts',
          },
          {
            label: 'TypeScript中的枚举是什么',
            key: 'ts-enums',
            isLeaf: true,
            filePath: 'js-es6-ts/ts',
          },
          {
            label: '如何在TypeScript中实现封装',
            key: 'ts-class-interface',
            isLeaf: true,
            filePath: 'js-es6-ts/ts',
          },
          {
            label: 'TypeScript的编译过程',
            key: 'ts-compile',
            isLeaf: true,
            filePath: 'js-es6-ts/ts',
          },
          {
            label: 'TypeScript中的类和构造函数',
            key: 'ts-consturctor',
            isLeaf: true,
            filePath: 'js-es6-ts/ts',
          },
          {
            label: '如何集成 TS 到现有的 JS 项目中',
            key: 'ts-refactor-js',
            isLeaf: true,
            filePath: 'js-es6-ts/ts',
          },
          {
            label: 'TypeScript 中的接口和类型别名有什么区别？',
            key: 'ts-interface-class',
            isLeaf: true,
            filePath: 'js-es6-ts/ts',
          },
          {
            label: 'TypeScript支持哪些高级类型操作',
            key: 'ts-operation',
            isLeaf: true,
            filePath: 'js-es6-ts/ts',
          },
          {
            label: '如何在TypeScript中处理异步编程',
            key: 'ts-async',
            isLeaf: true,
            filePath: 'js-es6-ts/ts',
          },
          {
            label: 'TypeScript 中的模块和命名空间',
            key: 'ts-modules',
            isLeaf: true,
            filePath: 'js-es6-ts/ts',
          },
        ],
      },
    ],
  },
  {
    label: 'HTML&CSS',
    key: 'html-css',
    children: [
      {
        label: 'HTML',
        key: 'html',
        children: [
          {
            label: 'H5语义化标签及其作用',
            key: 'h5-semantic-tag',
            isLeaf: true,
            filePath: 'html-css/html',
          },
          {
            label: 'HTML5的新特性',
            key: 'html-new-feature',
            isLeaf: true,
            filePath: 'html-css/html',
          },
          {
            label: '<a></a>标签的作用有哪些',
            key: 'html-tag-a',
            isLeaf: true,
            filePath: 'html-css/html',
          },
          {
            label: 'HTML元素种类的划分',
            key: 'html-type',
            isLeaf: true,
            filePath: 'html-css/html',
          },
          {
            label: 'SEO概念及实现',
            key: 'seo-concept',
            isLeaf: true,
            filePath: 'html-css/html',
          },
        ],
      },
      {
        label: 'CSS',
        key: 'css',
        children: [
          {
            label: '未知宽高的元素水平垂直居中',
            key: 'align-center',
            isLeaf: true,
            filePath: 'html-css/css',
          },
          {
            label: 'CSS权重机制',
            key: 'css-weight',
            isLeaf: true,
            filePath: 'html-css/css',
          },
          {
            label: 'CSS引入方式',
            key: 'css-import',
            isLeaf: true,
            filePath: 'html-css/css',
          },
          {
            label: 'Less、Sass和CSS的区别',
            key: 'less-sass-css',
            isLeaf: true,
            filePath: 'html-css/css',
          },
          {
            label: '如何实现响应式布局',
            key: 'responsive-layout',
            isLeaf: true,
            filePath: 'html-css/css',
          },
          {
            label: 'CSS定位方式及其区别',
            key: 'css-position',
            isLeaf: true,
            filePath: 'html-css/css',
          },
          {
            label: 'CSS定位属性',
            key: 'css-position-property',
            isLeaf: true,
            filePath: 'html-css/css',
          },
          {
            label: '常见CSS3及动画',
            key: 'css3-animate',
            isLeaf: true,
            filePath: 'html-css/css',
          },
          {
            label: 'px/em/rem的区别',
            key: 'px-em-rem',
            isLeaf: true,
            filePath: 'html-css/css',
          },
          {
            label: 'vh与vw的使用',
            key: 'vh-vw',
            isLeaf: true,
            filePath: 'html-css/css',
          },
          {
            label: 'display及其相关属性',
            key: 'display-property',
            isLeaf: true,
            filePath: 'html-css/css',
          },
          {
            label: '圣杯布局的实现',
            key: 'grail-grid',
            isLeaf: true,
            filePath: 'html-css/css',
          },
          {
            label: '双飞翼布局的实现',
            key: 'delphinium-grid',
            isLeaf: true,
            filePath: 'html-css/css',
          },
          {
            label: 'IFC与BFC',
            key: 'ifc-bfc',
            isLeaf: true,
            filePath: 'html-css/css',
          },
          {
            label: '盒模型概念',
            key: 'box-model',
            isLeaf: true,
            filePath: 'html-css/css',
          },
          {
            label: 'flex布局的应用',
            key: 'flex-display',
            isLeaf: true,
            filePath: 'html-css/css',
          },
          {
            label: '浮动模型及清除浮动的方法',
            key: 'float-model',
            isLeaf: true,
            filePath: 'html-css/css',
          },
          {
            label: 'margin塌陷及合并问题',
            key: 'margin-collapse',
            isLeaf: true,
            filePath: 'html-css/css',
          },
          {
            label: '用CSS画一个三角形',
            key: 'css-triangle',
            isLeaf: true,
            filePath: 'html-css/css',
          },
        ],
      },
    ],
  },
  {
    label: '计算机网络',
    key: 'network',
    children: [
      {
        label: 'HTTP协议',
        key: 'http',
        children: [
          {
            label: 'HTTP与HTTPS之间的区别？',
            key: 'http-https',
            isLeaf: true,
            filePath: 'network/http',
          },
          {
            label: 'HTTP的报文结构是什么？',
            key: 'http-message',
            isLeaf: true,
            filePath: 'network/http',
          },
          {
            label: 'HTTP的状态码有哪些？',
            key: 'http-status-code',
            isLeaf: true,
            filePath: 'network/http',
          },
          {
            label: 'HTTP常见响应状态码？',
            key: 'http-response-code',
            isLeaf: true,
            filePath: 'network/http',
          },
          {
            label: 'HTTP通用首部字段有哪些？',
            key: 'http-header-key',
            isLeaf: true,
            filePath: 'network/http',
          },
          {
            label: 'GET和POST请求的区别？',
            key: 'http-get-post',
            isLeaf: true,
            filePath: 'network/http',
          },
          {
            label: 'HTTP协议1.0、1.1和2.0有哪些特点？',
            key: 'http-v1-v2',
            isLeaf: true,
            filePath: 'network/http',
          },
          {
            label: 'HTTP长连接、短连接和持久连接的区别和应用场景？',
            key: 'http-long-short',
            isLeaf: true,
            filePath: 'network/http',
          },
          {
            label: 'Cookie和Session的区别？',
            key: 'http-cookie-session',
            isLeaf: true,
            filePath: 'network/http',
          },
          {
            label: 'HTTPS连接建立的过程？',
            key: 'http-https-connect',
            isLeaf: true,
            filePath: 'network/http',
          },
          {
            label: '永久性重定向和暂时性重定向的区别？',
            key: 'http-redirect',
            isLeaf: true,
            filePath: 'network/http',
          },
          {
            label: 'HTTP报文首部有哪些？',
            key: 'http-header',
            isLeaf: true,
            filePath: 'network/http',
          },
          {
            label: 'HTTP请求首部字段、响应首部字段、实体首部字段有哪些？',
            key: 'http-header-content',
            isLeaf: true,
            filePath: 'network/http',
          },
          {
            label: '什么是对称加密算法？',
            key: 'http-symmetric-cryptography',
            isLeaf: true,
            filePath: 'network/http',
          },
          {
            label: '什么是非对称加密算法？',
            key: 'http-none-symmetric-cryptography',
            isLeaf: true,
            filePath: 'network/http',
          },
          {
            label: '重定向和转发的区别？',
            key: 'http-redirect-transfer',
            isLeaf: true,
            filePath: 'network/http',
          },
          {
            label: 'Cookie相关首部字段？',
            key: 'http-cookie',
            isLeaf: true,
            filePath: 'network/http',
          },
          {
            label: '基于HTTP的功能追加协议有哪些？',
            key: 'http-trace-proxy',
            isLeaf: true,
            filePath: 'network/http',
          },
          {
            label: '网络如何保证不丢包？',
            key: 'http-no-lose',
            isLeaf: true,
            filePath: 'network/http',
          },
        ],
      },
      {
        label: 'TCP/IP协议',
        key: 'tcpIp',
        children: [
          {
            label: 'TCP/IP协议分层结构？',
            key: 'tcpIp-protocal',
            isLeaf: true,
            filePath: 'network/tcpIp',
          },
          {
            label: 'TCP三次握手过程？',
            key: 'tcp-handshake',
            isLeaf: true,
            filePath: 'network/tcpIp',
          },
          {
            label: 'TCP为什么是三次握手，为什么两次不行？',
            key: 'tcp-three-shakehand',
            isLeaf: true,
            filePath: 'network/tcpIp',
          },
          {
            label: 'TCP四次挥手过程',
            key: 'tcp-wave-hand',
            isLeaf: true,
            filePath: 'network/tcpIp',
          },
          {
            label: 'TCP与UDP的区别与场景？',
            key: 'tcp-udp',
            isLeaf: true,
            filePath: 'network/tcpIp',
          },
          {
            label: '常见的网络服务分层？',
            key: 'network-level',
            isLeaf: true,
            filePath: 'network/tcpIp',
          },
          {
            label: 'TCP如何做到滑动窗口和拥塞控制？',
            key: 'tcp-window-control',
            isLeaf: true,
            filePath: 'network/tcpIp',
          },
          {
            label: 'TCP粘包的原因和解决办法？',
            key: 'tcp-sticky',
            isLeaf: true,
            filePath: 'network/tcpIp',
          },
          {
            label: 'TCP的报文格式？',
            key: 'tcp-content',
            isLeaf: true,
            filePath: 'network/tcpIp',
          },
          {
            label: 'UDP的报文格式？',
            key: 'udp-content',
            isLeaf: true,
            filePath: 'network/tcpIp',
          },
          {
            label: 'OSI和TCP/IP模型是什么？',
            key: 'tcpIp-model',
            isLeaf: true,
            filePath: 'network/tcpIp',
          },
          {
            label: 'TIME-WAIT和CLOSE_WAIT是什么？',
            key: 'time-wait-close-wait',
            isLeaf: true,
            filePath: 'network/tcpIp',
          },
          {
            label: 'TIME-WAIT过多出现原因和解决方法？',
            key: 'time-wait',
            isLeaf: true,
            filePath: 'network/tcpIp',
          },
          {
            label: '视频传输是用TCP还是UDP，丢包如何解决？',
            key: 'video-transfer',
            isLeaf: true,
            filePath: 'network/tcpIp',
          },
        ],
      },
      {
        label: '网络安全',
        key: 'security',
        children: [
          {
            label: '常见的Web攻击分类',
            key: 'web-attack',
            isLeaf: true,
            filePath: 'network/security',
          },
          {
            label: 'XSS攻击及防御',
            key: 'xss',
            isLeaf: true,
            filePath: 'network/security',
          },
          {
            label: 'CSRF攻击及防御',
            key: 'csrf',
            isLeaf: true,
            filePath: 'network/security',
          },
        ],
      },
      {
        label: '其他',
        key: 'others',
        children: [
          {
            label: '浏览器输入URL过程',
            key: 'other-input-url',
            isLeaf: true,
            filePath: 'network/others',
          },
          {
            label: 'LocalStorage、SessionStorage和Cookie的区别',
            key: 'localStorage-sessionStorage',
            isLeaf: true,
            filePath: 'network/others',
          },
          {
            label: 'Web服务器及其组成',
            key: 'web-service',
            isLeaf: true,
            filePath: 'network/others',
          },
          {
            label: 'DNS解析时有什么算法和方式减少重复操作?',
            key: 'dns-analysis',
            isLeaf: true,
            filePath: 'network/others',
          },
        ],
      },
    ],
  },
  {
    label: '前端框架',
    key: 'framework',
    children: [
      {
        label: 'React',
        key: 'react',
        children: [
          {
            label: 'React生命周期',
            key: 'react-lifecycle',
            isLeaf: true,
            filePath: 'framework/react',
          },
          {
            label: 'React Hooks的作用及原理',
            key: 'react-hooks',
            isLeaf: true,
            filePath: 'framework/react',
          },
          {
            label: 'useCallback和useMemo性能优化',
            key: 'useCallback-useMemo',
            isLeaf: true,
            filePath: 'framework/react',
          },
          {
            label: 'React的Diff算法',
            key: 'react-diff',
            isLeaf: true,
            filePath: 'framework/react',
          },
          {
            label: 'Virtual DOM',
            key: 'virtual-dom',
            isLeaf: true,
            filePath: 'framework/react',
          },
          {
            label: 'Flux的架构模式',
            key: 'react-flux',
            isLeaf: true,
            filePath: 'framework/react',
          },
          {
            label: 'Redux设计思路',
            key: 'react-redux',
            isLeaf: true,
            filePath: 'framework/react',
          },
          {
            label: '高阶组件的定义',
            key: 'enhance-component',
            isLeaf: true,
            filePath: 'framework/react',
          },
          {
            label: 'React Fiber架构',
            key: 'react-fiber',
            isLeaf: true,
            filePath: 'framework/react',
          },
          {
            label: 'Pure Component与shouldComponentUpdate关系',
            key: 'pure-component',
            isLeaf: true,
            filePath: 'framework/react',
          },
          {
            label: '受控组件与非受控组件',
            key: 'controlled-component',
            isLeaf: true,
            filePath: 'framework/react',
          },
          {
            label: 'React和Vue的异同',
            key: 'react-vue-diff',
            isLeaf: true,
            filePath: 'framework/react',
          },
          {
            label: 'React有哪些特点',
            key: 'react-properties',
            isLeaf: true,
            filePath: 'framework/react',
          },
        ],
      },
      {
        label: 'Vue',
        key: 'vue',
        children: [
          {
            label: 'Vue的核心概念有哪些',
            key: 'vue-core',
            isLeaf: true,
            filePath: 'framework/vue',
          },
          {
            label: 'Vue的响应式系统如何实现',
            key: 'vue-responsive',
            isLeaf: true,
            filePath: 'framework/vue',
          },
          {
            label: 'Vue的生命周期Hooks并举例说明',
            key: 'vue-lifecycle',
            isLeaf: true,
            filePath: 'framework/vue',
          },
          {
            label: '如何优化Vue应用的性能',
            key: 'vue-performance',
            isLeaf: true,
            filePath: 'framework/vue',
          },
          {
            label: 'Vue Router是如何与Vue.js集成的',
            key: 'vue-router',
            isLeaf: true,
            filePath: 'framework/vue',
          },
          {
            label: 'Vuex的概念与作用',
            key: 'vue-vuex',
            isLeaf: true,
            filePath: 'framework/vue',
          },
          {
            label: 'Vue的计算属性和侦听器',
            key: 'vue-computed-listener',
            isLeaf: true,
            filePath: 'framework/vue',
          },
          {
            label: 'Vue的v-model如何实现双向数据绑定',
            key: 'vue-vmodel',
            isLeaf: true,
            filePath: 'framework/vue',
          },
        ],
      },
    ],
  },
  {
    label: '数据结构与算法',
    key: 'data-structure',
    children: [
      {
        label: '算法',
        key: 'alogrithm',
        children: [
          {
            label: '数据结构-数组',
            key: 'algorithm-array',
            isLeaf: true,
            filePath: 'data-structure/algorithm',
          },
          {
            label: '数据结构-字符串',
            key: 'algorithm-string',
            isLeaf: true,
            filePath: 'data-structure/algorithm',
          },
          {
            label: '数据结构-树',
            key: 'algorithm-tree',
            isLeaf: true,
            filePath: 'data-structure/algorithm',
          },
          {
            label: '二分查找',
            key: 'algorithm-binary',
            isLeaf: true,
            filePath: 'data-structure/algorithm',
          },
          {
            label: '哈希表的应用',
            key: 'algorithm-hash',
            isLeaf: true,
            filePath: 'data-structure/algorithm',
          },
          {
            label: '动态规划',
            key: 'algorithm-dynamic',
            isLeaf: true,
            filePath: 'data-structure/algorithm',
          },
          {
            label: '递归与分治',
            key: 'algorithm-loop',
            isLeaf: true,
            filePath: 'data-structure/algorithm',
          },
        ],
      },
    ],
  },
  {
    label: '前端纵向领域',
    key: 'fe',
    children: [
      {
        label: '工程化',
        key: 'project',
        children: [
          {
            label: '前端工程化流程',
            key: 'project-flow',
            isLeaf: true,
            filePath: 'fe/project',
          },
          {
            label: 'Webpack概念与配置',
            key: 'project-webpack',
            isLeaf: true,
            filePath: 'fe/project',
          },
          {
            label: 'SSR实现及优缺点',
            key: 'project-ssr',
            isLeaf: true,
            filePath: 'fe/project',
          },
          {
            label: 'SPA及其优缺点',
            key: 'project-spa',
            isLeaf: true,
            filePath: 'fe/project',
          },
          {
            label: '基础设计模式',
            key: 'project-model',
            isLeaf: true,
            filePath: 'fe/project',
          },
          {
            label: '如何在Webpack实现优化',
            key: 'project-webpack-performance',
            isLeaf: true,
            filePath: 'fe/project',
          },
          {
            label: 'loader与plugin原理与实现',
            key: 'project-loader-plugin',
            isLeaf: true,
            filePath: 'fe/project',
          },
        ],
      },
      {
        label: '组件体系',
        key: 'design',
        children: [
          {
            label: '如何确保组件的复用性',
            key: 'design-common',
            isLeaf: true,
            filePath: 'fe/design',
          },
          {
            label: '如何实现组件的状态管理',
            key: 'design-state',
            isLeaf: true,
            filePath: 'fe/design',
          },
          {
            label: '如何实现组件间的通信',
            key: 'design-communication',
            isLeaf: true,
            filePath: 'fe/design',
          },
          {
            label: '如何设计一个高度封装的组件',
            key: 'design-components',
            isLeaf: true,
            filePath: 'fe/design',
          },
          {
            label: '前端组件性能优化如何实现',
            key: 'design-performance',
            isLeaf: true,
            filePath: 'fe/design',
          },
        ],
      },
      {
        label: '数据可视化',
        key: 'visualization',
        children: [
          {
            label: 'Canvas和SVG的区别',
            key: 'canvas-svg',
            isLeaf: true,
            filePath: 'fe/visualization',
          },
          {
            label: '设计可视化图表时，Canvas和SVG如何取舍',
            key: 'canvas-svg-select',
            isLeaf: true,
            filePath: 'fe/visualization',
          },
          {
            label: '常见可视化组件库',
            key: 'visual-projects',
            isLeaf: true,
            filePath: 'fe/visualization',
          },
          {
            label: 'ECharts的设计思路',
            key: 'echarts-design',
            isLeaf: true,
            filePath: 'fe/visualization',
          },
          {
            label: '如何将可视化组件库与前端框架结合',
            key: 'visual-components',
            isLeaf: true,
            filePath: 'fe/visualization',
          },
        ],
      },
      {
        label: 'Node',
        key: 'node',
        children: [
          {
            label: 'NodeJS基本概念与特点',
            key: 'node-knowledge',
            isLeaf: true,
            filePath: 'fe/node',
          },
          {
            label: 'Node的内存控制',
            key: 'node-memory',
            isLeaf: true,
            filePath: 'fe/node',
          },
          {
            label: 'Node的进程',
            key: 'node-process',
            isLeaf: true,
            filePath: 'fe/node',
          },
          {
            label: 'CommonJS规范、核心模块',
            key: 'commonjs',
            isLeaf: true,
            filePath: 'fe/node',
          },
          {
            label: 'Node如何构建网络服务',
            key: 'node-web-service',
            isLeaf: true,
            filePath: 'fe/node',
          },
          {
            label: 'Node的异步I/O机制',
            key: 'node-async-io',
            isLeaf: true,
            filePath: 'fe/node',
          },
        ],
      },
      {
        label: 'AIGC',
        key: 'aigc',
        children: [
          {
            label: '如何集成大模型到前端应用',
            key: 'aigc-application',
            isLeaf: true,
            filePath: 'fe/aigc',
          },
          {
            label: '如何调用GPT的OpenAPI',
            key: 'aigc-openai',
            isLeaf: true,
            filePath: 'fe/aigc',
          },
          {
            label: '大模型和前端有哪些结合场景',
            key: 'aigc-frontend',
            isLeaf: true,
            filePath: 'fe/aigc',
          },
        ],
      },
    ],
  },
];

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

migrate().catch(err => {
  console.error('迁移失败:', err);
  process.exit(1);
});
