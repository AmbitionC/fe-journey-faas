const { join } = require('path');
const { BootstrapStarter } = require('@midwayjs/fc-starter');

const starter = new BootstrapStarter();

// 聚合部署单函数入口：整个 Midway 应用作为一个 FC 函数，
// 由框架按 HTTP path 内部路由到各 @ServerlessTrigger（onInit 会加载全部路由）。
// 规避 FC「单服务 50 函数」上限——所有接口共用这一个 main 函数。
module.exports = starter.start({
  appDir: __dirname,
  baseDir: join(__dirname, 'dist'),
  initializeMethodName: 'initializer',
  aggregationHandlerName: 'main.handler',
});
