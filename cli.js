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

const { spawn, exec, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const DAEMON_PATH = path.join(__dirname, 'service', 'daemon.js');
const SERVICE_NAME = 'claw-subagent-service';

// 解析命令行参数
const args = process.argv.slice(2);
const command = args[0] || '--run';

// --version 支持：直接显示版本并退出，不启动 daemon
if (command === '--version' || command === '-v') {
  try {
    const version = require('./package.json').version;
    console.log(version);
  } catch {
    console.log('unknown');
  }
  process.exit(0);
}

function runDaemon() {
  console.log('[CLI] 启动 Daemon...');
  console.log(`[CLI] CLI 路径: ${__filename}`);
  console.log(`[CLI] Daemon 路径: ${DAEMON_PATH}`);

  const daemon = spawn('node', [DAEMON_PATH], {
    stdio: 'ignore',
    detached: true
  });

  daemon.unref();

  // 不阻塞等待 Daemon 退出：
  // detached: true 使 Daemon 成为独立进程组 leader，避免随 CLI 收到 SIGINT/SIGHUP；
  // stdio: 'ignore' 防止 nohup 场景下 pipe 断开导致异常；
  // unref() 让 CLI 事件循环不等待 Daemon，安装脚本可立即继续。
  console.log(`[CLI] Daemon 已启动，PID=${daemon.pid}`);

  // 短暂停留确认 Daemon 未立即崩溃，随后 CLI 退出（Daemon 继续后台运行）
  setTimeout(() => {
    process.exit(0);
  }, 1500);
}

function installService() {
  console.log('[CLI] 安装系统服务...');

  const platform = process.platform;

  if (platform === 'win32') {
    // Windows: 使用 node-windows 注册服务（正确处理路径引号）
    console.log('[CLI] 使用 node-windows 安装服务...');

    // 强制删除可能存在的旧服务（确保配置更新，包括环境变量）
    try {
      console.log('[CLI] 清理旧服务...');
      execSync(`net stop "${SERVICE_NAME}" 2>nul`, { stdio: 'ignore', timeout: 10000 });
    } catch (e) {}
    try {
      execSync(`sc.exe delete "${SERVICE_NAME}" 2>nul`, { stdio: 'ignore', timeout: 10000 });
      console.log('[CLI] 旧服务已删除');
    } catch (e) {}
    try {
      execSync('timeout /t 2 /nobreak >nul 2>&1', { stdio: 'ignore', timeout: 5000 });
    } catch (e) {}

    try {
      const userHome = process.env.USERPROFILE || os.homedir();
      const Service = require('node-windows').Service;
      const svc = new Service({
        name: SERVICE_NAME,
        description: 'OpenClaw Guard',
        script: DAEMON_PATH,
        nodeOptions: ['--harmony', '--max_old_space_size=4096'],
        env: {
          USERPROFILE: userHome,
          HOME: userHome,
          CLAW_SERVICE_HOME: userHome
        }
      });
      console.log(`[CLI] 服务环境变量 USERPROFILE=${userHome}, CLAW_SERVICE_HOME=${userHome}`);

      svc.on('install', () => {
        console.log('[CLI] 服务安装成功');

        // 延迟 2 秒确保服务注册到 SCM，再设置开机自启 + 崩溃恢复
        setTimeout(() => {
          const cmdFailure = `sc.exe failure "${SERVICE_NAME}" reset= 0 actions= restart/0/restart/0/restart/0`;
          exec(cmdFailure, (err) => {
            if (err) console.error(`[CLI] 设置恢复策略失败: ${err.message}`);
            else console.log('[CLI] 恢复策略已设置：崩溃后自动重启');
          });

          exec(`sc.exe config "${SERVICE_NAME}" start= auto`, (err) => {
            if (err) console.error(`[CLI] 设置自动启动失败: ${err.message}`);
            else console.log('[CLI] 启动类型已设为：自动');
          });
        }, 2000);

        svc.start();
      });

      svc.on('start', () => {
        console.log('[CLI] 服务已启动');
      });

      svc.on('error', (err) => {
        console.error(`[CLI] 服务安装失败: ${err.message}`);
      });

      svc.on('alreadyinstalled', () => {
        console.log('[CLI] 服务已存在，尝试启动...');
        svc.start();
      });

      svc.install();
    } catch (err) {
      console.error(`[CLI] 安装服务异常: ${err.message}`);
    }
  } else if (platform === 'linux') {
    // Linux: systemd
    const execStart = `${process.execPath} ${DAEMON_PATH}`;
    const serviceFile = `/etc/systemd/system/${SERVICE_NAME}.service`;
    const pathEnv = process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
    const serviceContent = `[Unit]
Description=OpenClaw Guard CLI Client
After=network.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=always
RestartSec=10
WorkingDirectory=${path.dirname(DAEMON_PATH)}
Environment="PATH=${pathEnv}"

[Install]
WantedBy=multi-user.target
`;

    try {
      fs.writeFileSync(serviceFile, serviceContent);
      exec('systemctl daemon-reload && systemctl enable ' + SERVICE_NAME, (err) => {
        if (err) console.error(`[CLI] 安装失败: ${err.message}`);
        else {
          console.log('[CLI] 服务安装成功');
          exec('systemctl start ' + SERVICE_NAME);
        }
      });
    } catch (err) {
      console.error(`[CLI] 写入 service 文件失败: ${err.message}`);
    }
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
        <string>${process.execPath}</string>
        <string>${DAEMON_PATH}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>`;

    try {
      fs.writeFileSync(plistFile, plistContent);
      exec(`launchctl load ${plistFile} && launchctl start ${SERVICE_NAME}`, (err) => {
        if (err) console.error(`[CLI] 安装失败: ${err.message}`);
        else console.log('[CLI] 服务安装成功');
      });
    } catch (err) {
      console.error(`[CLI] 写入 plist 文件失败: ${err.message}`);
    }
  }
}

function uninstallService() {
  console.log('[CLI] 卸载系统服务...');

  const platform = process.platform;

  if (platform === 'win32') {
    // Windows: 使用 node-windows 卸载服务
    try {
      const Service = require('node-windows').Service;
      const svc = new Service({ name: SERVICE_NAME, script: DAEMON_PATH });
      svc.on('uninstall', () => console.log('[CLI] 服务卸载成功'));
      svc.on('error', (err) => console.error(`[CLI] 卸载失败: ${err.message}`));
      svc.uninstall();
    } catch (err) {
      console.error(`[CLI] 卸载服务异常: ${err.message}`);
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
    // Windows: 先尝试 sc.exe query，若服务未安装则回退到进程检查
    cmd = `sc.exe query "${SERVICE_NAME}"`;
    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        // 1060 = 服务未安装，给出更友好的提示
        if (stderr && stderr.includes('1060')) {
          console.log(`[CLI] 服务 "${SERVICE_NAME}" 未安装`);
          console.log(`[CLI] 请运行: claw-subagent-service --install`);
        } else {
          console.error(`[CLI] 查询状态失败: ${err.message}`);
        }
        // 回退：检查 daemon 进程是否在前台运行
        try {
          const list = execSync('tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH', { encoding: 'utf8', windowsHide: true });
          const hasDaemon = list.includes('daemon.js');
          if (hasDaemon) {
            console.log('[CLI] 检测到 Daemon 进程正在前台运行');
          }
        } catch { /* 忽略 */ }
        return;
      }
      console.log(stdout);
    });
    return;
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
