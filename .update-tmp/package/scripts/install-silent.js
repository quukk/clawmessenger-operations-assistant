const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');

const ROOT = process.argv[2] || process.env.SILENT_SERVICE_DIR || path.join(__dirname, '..');
const DAEMON_PATH = path.join(ROOT, 'service', 'daemon.js');
const SERVICE_NAME = 'SilentNodeService';
const LOG_FILE = path.join(ROOT, 'logs', 'install.log');

if (!fs.existsSync(path.dirname(LOG_FILE))) {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
}

const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, line);
  console.log(msg);
};

const platform = process.platform;

function done(code, label) {
  if (label) log(label);
  setTimeout(() => process.exit(code), 500);
}

if (platform === 'win32') {
  exec('net session', (err) => {
    if (err) {
      const msg = '错误：请以管理员身份运行此脚本';
      fs.writeFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
      console.error(msg);
      process.exit(1);
    }

    let completed = false;
    function finish(code, label) {
      if (!completed) {
        completed = true;
        done(code, label);
      }
    }

    // 兜底超时
    setTimeout(() => finish(1, '安装操作超时'), 60000);

    // 使用 node-windows 注册服务（正确处理路径引号）
    try {
      const Service = require('node-windows').Service;
      const userHome = process.env.USERPROFILE || os.homedir();
      const svc = new Service({
        name: SERVICE_NAME,
        description: 'Node.js 静默后台服务（开机自启/崩溃自动恢复/自动更新）',
        script: DAEMON_PATH,
        wait: 2,
        grow: 0.5,
        abortOnError: false,
        env: {
          USERPROFILE: userHome,
          HOME: userHome,
          CLAW_SERVICE_HOME: userHome
        }
      });

      svc.on('install', () => {
        log('服务安装成功，正在启动...');
        svc.start();

        const cmd = `sc.exe failure "${SERVICE_NAME}" reset= 0 actions= restart/0/restart/0/restart/0`;
        exec(cmd, (err) => {
          if (err) log(`设置恢复策略失败: ${err.message}`);
          else log('恢复策略已设置：服务崩溃后系统自动无限重启');
        });

        exec(`sc.exe config "${SERVICE_NAME}" start= auto`, (err) => {
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
        finish(0);
      });

      svc.on('error', (err) => {
        log(`安装错误: ${err.message}`);
        finish(1);
      });

      log('开始安装服务...');
      svc.install();
    } catch (err) {
      log(`安装异常: ${err.message}`);
      finish(1);
    }
  });
} else if (platform === 'linux') {
  const serviceFile = `/etc/systemd/system/${SERVICE_NAME}.service`;
  const pathEnv = process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  const serviceContent = `[Unit]
Description=Node.js 静默后台服务（开机自启/崩溃自动恢复/自动更新）
After=network.target

[Service]
Type=simple
ExecStart=${process.execPath} ${DAEMON_PATH}
Restart=always
RestartSec=10
WorkingDirectory=${path.dirname(DAEMON_PATH)}
Environment="SILENT_SERVICE_DIR=${ROOT}"
Environment="PATH=${pathEnv}"

[Install]
WantedBy=multi-user.target
`;

  try {
    fs.writeFileSync(serviceFile, serviceContent);
    exec('systemctl daemon-reload && systemctl enable ' + SERVICE_NAME, (err) => {
      if (err) {
        done(1, `安装失败: ${err.message}`);
      } else {
        log('服务安装成功');
        exec('systemctl start ' + SERVICE_NAME, (err2) => {
          if (err2) {
            done(1, `启动失败: ${err2.message}`);
          } else {
            done(0, '服务已启动');
          }
        });
      }
    });
  } catch (err) {
    done(1, `安装失败: ${err.message}`);
  }
} else if (platform === 'darwin') {
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
    <key>EnvironmentVariables</key>
    <dict>
        <key>SILENT_SERVICE_DIR</key>
        <string>${ROOT}</string>
    </dict>
</dict>
</plist>`;

  try {
    fs.writeFileSync(plistFile, plistContent);
    exec(`launchctl load ${plistFile} && launchctl start ${SERVICE_NAME}`, (err) => {
      if (err) {
        done(1, `安装失败: ${err.message}`);
      } else {
        done(0, '服务安装成功并已启动');
      }
    });
  } catch (err) {
    done(1, `安装失败: ${err.message}`);
  }
} else {
  done(1, `不支持的平台: ${platform}`);
}
