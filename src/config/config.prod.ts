// load when NODE_ENV=production
import { MidwayConfig } from '@midwayjs/core';

export default {
  // test: 'test'
  token: {
    expire: 60 * 60 * 24 * 7,
  },
  typeorm: {
    dataSource: {
      default: {
        type: 'mysql',
        host: 'rm-bp18fm5u5c7uk47558o.mysql.rds.aliyuncs.com', // 数据库ip地址，本地就写localhost
        port: 3306,
        allowPublicKeyRetrieval: true,
        username: 'ch17394940726',
        password: 'Ch823147833',
        database: 'fe-journey', // 数据库名称
        synchronize: true, // 如果第一次使用，不存在表，有同步的需求可以写 true，注意会丢数据
        logging: true,
        entities: ['**/entity{.ts,.js}'],
      },
    },
  },
  redis: {
    client: {
      port: 6379,
      host: '112.124.56.156',
      password: '123456',
      db: 0,
    },
  },
} as MidwayConfig;
