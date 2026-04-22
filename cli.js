#!/usr/bin/env node
/**
 * OpenClaw Guard CLI 入口文件
 * 
 * 用法:
 *   node cli.js --run          # 前台运行（默认）
 *   node cli.js --install      # 安装为系统服务
 *   node cli.js --uninstall    # 卸载系统服务
 *   node cli.js --start        # 启动服务
 *   node cli.js --stop         # 停止服务
 *   node cli.js --restart      # 重启服务
 *   node cli.js --status       # 查看服务状态
 */

const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const DAEMON_PATH = path.join(__dirname, 'service', 'daemon.js');
const SERVICE_NAME = 'openclaw-guard-cli';

// 解析命令行参数
const args = process.argv.slice(2);
const command = args[0] || '--run';

function runDaemon() {
  console.log('[CLI] 启动 Daemon...');
  
  const daemon = spawn('node', [DAEMON_PATH], {
    stdio: 'inherit',
    detached: false
  });
  
  daemon.on('exit', (code) => {
    console.log(`[CLI] Daemon 退出，code=${code}`);
    process.exit(code);
  });
  
  daemon.on('error', (err) => {
    console.error(`[CLI] Daemon 启动失败: ${err.message}`);
    process.exit(1);
  });
}

function installService() {
  console.log('[CLI] 安装系统服务...');
  
  const platform = process.platform;
  
  if (platform === 'win32') {
    // Windows: 使用 node-windows
    try {
      const Service = require('node-windows').Service;
      const svc = new Service({
        name: SERVICE_NAME,
        description: 'OpenClaw Guard CLI Client',
        script: DAEMON_PATH,
        nodeOptions: ['--harmony', '--max_old_space_size=4096']
      });
      
      svc.on('install', () => {
        console.log('[CLI] 服务安装成功');
        svc.start();
      });
      
      svc.on('error', (err) => {
        console.error(`[CLI] 服务安装失败: ${err.message}`);
      });
      
      svc.install();
    } catch (err) {
      console.error(`[CLI] 安装失败: ${err.message}`);
      console.log('请先安装 node-windows: npm install node-windows --save');
    }
  } else if (platform === 'linux') {
    // Linux: systemd
    const serviceFile = `/etc/systemd/system/${SERVICE_NAME}.service`;
    const serviceContent = `[Unit]
Description=OpenClaw Guard CLI Client
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node ${DAEMON_PATH}
Restart=always
RestartSec=10
WorkingDirectory=${path.dirname(DAEMON_PATH)}

[Install]
WantedBy=multi-user.target
`;
    
    fs.writeFileSync(serviceFile, serviceContent);
    exec('systemctl daemon-reload && systemctl enable ' + SERVICE_NAME, (err) => {
      if (err) {
        console.error(`[CLI] 安装失败: ${err.message}`);
      } else {
        console.log('[CLI] 服务安装成功');
        exec('systemctl start ' + SERVICE_NAME);
      }
    });
  } else if (platform === 'darwin') {
    // macOS: launchd
    const plistFile = `/Library/LaunchDaemons/${SERVICE_NAME}.plist`;
    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>${DAEMON_PATH}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>`;
    
    fs.writeFileSync(plistFile, plistContent);
    exec(`launchctl load ${plistFile} && launchctl start ${SERVICE_NAME}`, (err) => {
      if (err) {
        console.error(`[CLI] 安装失败: ${err.message}`);
      } else {
        console.log('[CLI] 服务安装成功');
      }
    });
  }
}

function uninstallService() {
  console.log('[CLI] 卸载系统服务...');
  
  const platform = process.platform;
  
  if (platform === 'win32') {
    try {
      const Service = require('node-windows').Service;
      const svc = new Service({
        name: SERVICE_NAME,
        script: DAEMON_PATH
      });
      
      svc.on('uninstall', () => {
        console.log('[CLI] 服务卸载成功');
      });
      
      svc.uninstall();
    } catch (err) {
      console.error(`[CLI] 卸载失败: ${err.message}`);
    }
  } else if (platform === 'linux') {
    exec(`systemctl stop ${SERVICE_NAME} && systemctl disable ${SERVICE_NAME} && rm -f /etc/systemd/system/${SERVICE_NAME}.service && systemctl daemon-reload`, (err) => {
      if (err) {
        console.error(`[CLI] 卸载失败: ${err.message}`);
      } else {
        console.log('[CLI] 服务卸载成功');
      }
    });
  } else if (platform === 'darwin') {
    const plistFile = `/Library/LaunchDaemons/${SERVICE_NAME}.plist`;
    exec(`launchctl stop ${SERVICE_NAME} && launchctl unload ${plistFile} && rm -f ${plistFile}`, (err) => {
      if (err) {
        console.error(`[CLI] 卸载失败: ${err.message}`);
      } else {
        console.log('[CLI] 服务卸载成功');
      }
    });
  }
}

function controlService(action) {
  const platform = process.platform;
  let cmd;
  
  if (platform === 'win32') {
    cmd = `net ${action === 'start' ? 'start' : action === 'stop' ? 'stop' : 'restart'} ${SERVICE_NAME}`;
  } else if (platform === 'linux') {
    cmd = `systemctl ${action} ${SERVICE_NAME}`;
  } else if (platform === 'darwin') {
    if (action === 'restart') {
      cmd = `launchctl stop ${SERVICE_NAME} && launchctl start ${SERVICE_NAME}`;
    } else {
      cmd = `launchctl ${action} ${SERVICE_NAME}`;
    }
  }
  
  exec(cmd, (err, stdout) => {
    if (err) {
      console.error(`[CLI] ${action} 失败: ${err.message}`);
    } else {
      console.log(`[CLI] ${action} 成功`);
      if (stdout) console.log(stdout);
    }
  });
}

function checkStatus() {
  const platform = process.platform;
  let cmd;
  
  if (platform === 'win32') {
    cmd = `sc query ${SERVICE_NAME}`;
  } else if (platform === 'linux') {
    cmd = `systemctl status ${SERVICE_NAME}`;
  } else if (platform === 'darwin') {
    cmd = `launchctl list | grep ${SERVICE_NAME}`;
  }
  
  exec(cmd, (err, stdout) => {
    if (err) {
      console.error(`[CLI] 查询状态失败: ${err.message}`);
    } else {
      console.log(stdout);
    }
  });
}

// 主逻辑
switch (command) {
  case '--install':
    installService();
    break;
  case '--uninstall':
    uninstallService();
    break;
  case '--start':
    controlService('start');
    break;
  case '--stop':
    controlService('stop');
    break;
  case '--restart':
    controlService('restart');
    break;
  case '--status':
    checkStatus();
    break;
  case '--run':
  default:
    runDaemon();
    break;
}
