
const { BootstrapStarter } = require('@midwayjs/fc-starter');
const starter = new BootstrapStarter();

module.exports = starter.start({
  appDir: __dirname,
  initializeMethodName: 'initializer',
});
