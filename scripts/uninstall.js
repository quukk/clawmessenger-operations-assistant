const { Service } = require('node-windows');
const path = require('path');

const svc = new Service({
  name: 'SilentNodeService',
  script: path.join(__dirname, '..', 'service', 'daemon.js')
});

svc.on('uninstall', () => {
  console.log('服务已卸载完成');
  process.exit(0);
});

svc.on('error', (err) => {
  console.error('卸载错误:', err.message);
  process.exit(1);
});

console.log('正在卸载服务...');
svc.uninstall();