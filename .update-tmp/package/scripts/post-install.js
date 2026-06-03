/**
 * npm postinstall 钩子
 * 全局安装完成后自动注册并启动 Windows 服务
 */
const { execSync } = require('child_process');
const path = require('path');
const os = require('os');

const SERVICE_NAME = 'claw-subagent-service';
const DAEMON_PATH = path.join(__dirname, '..', 'service', 'daemon.js');

function isGlobalInstall() {
  const pkgPath = path.normalize(__dirname).toLowerCase();
  const cwd = process.cwd().toLowerCase();
  const inNodeModules = pkgPath.includes('node_modules');
  const notInCwd = !pkgPath.startsWith(cwd);

  console.log(`[postinstall] 安装检测: inNodeModules=${inNodeModules}, notInCwd=${notInCwd}`);

  if (inNodeModules && notInCwd) {
    console.log('[postinstall] 检测到全局安装');
    return true;
  }

  // 兜底 - postinstall 只在安装时触发，默认按全局安装处理
  console.log('[postinstall] 兜底检测通过，默认按全局安装处理');
  return true;
}

function isWindowsAdmin() {
  if (process.platform !== 'win32') return false;
  try {
    execSync('net session', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch (e) {
    return false;
  }
}

function fixShellScriptLineEndings() {
  if (process.platform === 'win32') return;

  const fs = require('fs');
  const path = require('path');
  const scriptDir = path.join(__dirname, '..', 'command', 'linux');

  try {
    if (!fs.existsSync(scriptDir)) return;
    const files = fs.readdirSync(scriptDir);
    let fixedCount = 0;

    for (const file of files) {
      if (!file.endsWith('.sh')) continue;
      const filePath = path.join(scriptDir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        if (content.includes('\r\n')) {
          fs.writeFileSync(filePath, content.replace(/\r\n/g, '\n'));
          fixedCount++;
          console.log(`[postinstall] 已修复 ${file} 换行符（CRLF → LF）`);
        }
        // 确保脚本有执行权限
        try {
          fs.accessSync(filePath, fs.constants.X_OK);
        } catch (e) {
          // 没有执行权限，添加
          fs.chmodSync(filePath, 0o755);
          console.log(`[postinstall] 已添加 ${file} 执行权限`);
        }
      } catch (e) {
        console.warn(`[postinstall] 修复 ${file} 失败: ${e.message}`);
      }
    }

    if (fixedCount > 0) {
      console.log(`[postinstall] 共修复 ${fixedCount} 个脚本换行符`);
    }
  } catch (e) {
    console.warn(`[postinstall] 修复换行符失败: ${e.message}`);
  }
}

function installAndStartService() {
  // 先修复 Linux 脚本的换行符
  fixShellScriptLineEndings();

  if (process.platform !== 'win32') {
    console.log(`[postinstall] 跳过（非 Windows: ${process.platform}）`);
    return;
  }

  if (!isWindowsAdmin()) {
    console.log('[postinstall] 非管理员权限，跳过自动注册');
    console.log('[postinstall] 请运行: claw-subagent-service --install');
    return;
  }

  console.log('[postinstall] 正在注册系统服务...');

  // 强制删除可能存在的旧服务（确保配置更新，包括环境变量）
  try {
    console.log('[postinstall] 清理旧服务...');
    execSync(`net stop "${SERVICE_NAME}" 2>nul`, { stdio: 'ignore', timeout: 10000 });
  } catch (e) {}
  try {
    execSync(`sc.exe delete "${SERVICE_NAME}" 2>nul`, { stdio: 'ignore', timeout: 10000 });
    console.log('[postinstall] 旧服务已删除');
  } catch (e) {}
  try {
    execSync('timeout /t 2 /nobreak >nul 2>&1', { stdio: 'ignore', timeout: 5000 });
  } catch (e) {}

  try {
    // 使用 node-windows 注册服务（正确处理路径引号）
    const Service = require('node-windows').Service;
    const userHome = process.env.USERPROFILE || os.homedir();
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
    console.log(`[postinstall] 服务环境变量 USERPROFILE=${userHome}, CLAW_SERVICE_HOME=${userHome}`);

    svc.on('install', () => {
      console.log('[postinstall] 服务注册成功，正在启动...');

      // 延迟 3 秒确保服务注册到 SCM，再设置开机自启 + 崩溃恢复
      setTimeout(() => {
        // 使用 execSync 确保配置在启动前生效
        try {
          execSync(`sc.exe failure "${SERVICE_NAME}" reset= 0 actions= restart/0/restart/0/restart/0`, { stdio: 'ignore', timeout: 10000 });
          console.log('[postinstall] 恢复策略已设置：崩溃后自动重启');
        } catch (err) {
          console.error(`[postinstall] 设置恢复策略失败: ${err.message}`);
        }

        try {
          execSync(`sc.exe config "${SERVICE_NAME}" start= auto`, { stdio: 'ignore', timeout: 10000 });
          console.log('[postinstall] 启动类型已设为：自动');
        } catch (err) {
          console.error(`[postinstall] 设置自动启动失败: ${err.message}`);
        }

        // 配置完成后启动服务
        svc.start();
      }, 3000);
    });

    svc.on('start', () => {
      console.log('[postinstall] 服务已启动');
      // 启动后验证服务状态
      setTimeout(() => {
        try {
          const status = execSync(`sc.exe query "${SERVICE_NAME}"`, { encoding: 'utf8', timeout: 5000 });
          console.log('[postinstall] 服务状态验证:');
          console.log(status);
        } catch (err) {
          console.warn(`[postinstall] 服务状态验证失败: ${err.message}`);
        }
      }, 2000);
    });

    svc.on('error', (err) => {
      console.error(`[postinstall] 服务错误: ${err.message}`);
    });

    svc.on('alreadyinstalled', () => {
      console.log('[postinstall] 服务已存在，尝试启动...');
      svc.start();
    });

    svc.install();
  } catch (err) {
    console.error(`[postinstall] 注册服务异常: ${err.message}`);
  }
}

// 主逻辑
console.log('[postinstall] 脚本开始执行...');

if (isGlobalInstall()) {
  console.log('[postinstall] 准备自动注册服务...');
  installAndStartService();
} else {
  console.log('[postinstall] 本地安装模式，跳过自动注册');
}
