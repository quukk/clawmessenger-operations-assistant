const { Service } = require('node-windows');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');

const ROOT = process.argv[2] || process.env.SILENT_SERVICE_DIR || path.join(__dirname, '..');
const SERVICE_NAME = 'SilentNodeService';
const platform = process.platform;

function done(code, label) {
  if (label) console.log(label);
  setTimeout(() => process.exit(code), 500);
}

if (platform === 'win32') {
  let completed = false;
  function finish(code, label) {
    if (!completed) {
      completed = true;
      done(code, label);
    }
  }

  // 兜底超时
  setTimeout(() => finish(1, '卸载操作超时'), 60000);

  const svc = new Service({
    name: SERVICE_NAME,
    script: path.join(ROOT, 'service', 'daemon.js')
  });

  svc.on('uninstall', () => {
    finish(0, '服务已卸载完成');
  });

  svc.on('error', (err) => {
    finish(1, `卸载错误: ${err.message}`);
  });

  console.log('正在卸载服务...');
  svc.uninstall();
} else if (platform === 'linux') {
  exec(`systemctl stop "${SERVICE_NAME}" && systemctl disable "${SERVICE_NAME}" && rm -f /etc/systemd/system/${SERVICE_NAME}.service && systemctl daemon-reload`, (err) => {
    if (err) {
      done(1, `卸载失败: ${err.message}`);
    } else {
      done(0, '服务已卸载');
    }
  });
} else if (platform === 'darwin') {
  const plistFile = `/Library/LaunchDaemons/${SERVICE_NAME}.plist`;
  exec(`launchctl stop "${SERVICE_NAME}" && launchctl unload "${plistFile}" && rm -f "${plistFile}"`, (err) => {
    if (err) {
      done(1, `卸载失败: ${err.message}`);
    } else {
      done(0, '服务已卸载');
    }
  });
} else {
  done(1, `不支持的平台: ${platform}`);
}
