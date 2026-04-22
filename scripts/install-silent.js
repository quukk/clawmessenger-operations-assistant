const { Service } = require('node-windows');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const LOG_FILE = path.join(ROOT, 'logs', 'install.log');

if (!fs.existsSync(path.dirname(LOG_FILE))) {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
}

const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, line);
  console.log(msg);
};

exec('net session', (err) => {
  if (err) {
    const msg = '错误：请以管理员身份运行此脚本';
    fs.writeFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
    console.error(msg);
    process.exit(1);
  }

  const svc = new Service({
    name: 'SilentNodeService',
    description: 'Node.js 静默后台服务（开机自启/崩溃自动恢复/自动更新）',
    script: path.join(ROOT, 'service', 'daemon.js'),
    wait: 2,
    grow: 0.5,
    abortOnError: false
  });

  svc.on('install', () => {
    log('服务安装成功，正在启动...');
    svc.start();

    const cmd = `sc failure "SilentNodeService" reset= 0 actions= restart/0/restart/0/restart/0`;
    exec(cmd, (err) => {
      if (err) log(`设置恢复策略失败: ${err.message}`);
      else log('恢复策略已设置：服务崩溃后系统自动无限重启');
    });

    exec(`sc config "SilentNodeService" start= auto`, (err) => {
      if (err) log(`设置自动启动失败: ${err.message}`);
      else log('启动类型已设为：自动');
    });
  });

  svc.on('alreadyinstalled', () => {
    log('服务已存在，尝试启动...');
    svc.start();
  });

  svc.on('start', () => {
    log('服务已启动');
  });

  svc.on('error', (err) => {
    log(`安装错误: ${err.message}`);
  });

  log('开始安装服务...');
  svc.install();
});