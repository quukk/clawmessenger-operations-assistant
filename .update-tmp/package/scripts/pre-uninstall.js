/**
 * npm preuninstall 钩子
 * 在卸载旧版本前停止并删除 Windows 服务，释放文件锁
 *
 * 设计原则：完全同步执行，多层兜底，不依赖 node-windows 异步事件。
 * npm 运行此脚本时会等待进程退出，因此所有操作必须阻塞完成。
 */
const { execSync } = require('child_process');

const SERVICES = ['SilentNodeService', 'claw-subagent-service'];

/**
 * 强制停止服务进程并删除服务注册表
 */
function forceCleanupService(name) {
  console.log(`[preuninstall] 开始清理服务: ${name}`);

  // 1. 发送停止指令（服务可能正在运行）
  try {
    execSync(`net stop "${name}" 2>nul`, { stdio: 'ignore', timeout: 15000 });
    console.log(`[preuninstall] 服务 ${name} 已发送停止指令`);
  } catch (e) {
    // 服务可能未运行，忽略
  }

  // 2. 通过 sc queryex 获取服务 PID 并强制终止
  // 这是最精确的杀进程方式，直接终止锁定文件的进程
  try {
    const output = execSync(`sc queryex "${name}" 2>nul`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pidMatch = output.match(/PID\s*:\s*(\d+)/);
    if (pidMatch) {
      const pid = pidMatch[1];
      console.log(`[preuninstall] 发现服务 PID=${pid}，强制终止...`);
      try {
        execSync(`taskkill /f /pid ${pid} 2>nul`, { stdio: 'ignore', timeout: 10000 });
        console.log(`[preuninstall] PID ${pid} 已强制终止`);
      } catch (e) {
        // PID 可能已退出
      }
    }
  } catch (e) {
    // 服务不存在或未运行
  }

  // 3. 按进程名强制杀掉 wrapper 可执行文件（node-windows 生成的 .exe）
  try {
    execSync(`taskkill /f /im "${name}.exe" 2>nul`, { stdio: 'ignore', timeout: 10000 });
    console.log(`[preuninstall] ${name}.exe 已强制终止`);
  } catch (e) {
    // 进程可能不存在
  }

  // 4. 兜底：通过 PowerShell 按命令行路径匹配，杀掉所有包含 claw-subagent 的 node 进程
  try {
    execSync(
      `powershell -NoProfile -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object {\$_.Path -like '*claw-subagent*'} | Stop-Process -Force -ErrorAction SilentlyContinue" 2>nul`,
      { stdio: 'ignore', timeout: 15000 }
    );
    console.log(`[preuninstall] 相关 node 进程已清理`);
  } catch (e) {
    // 忽略
  }

  // 5. 使用 node-windows 卸载服务（删除 wrapper 文件）
  try {
    const Service = require('node-windows').Service;
    const DAEMON_PATH = require('path').join(__dirname, '..', 'service', 'daemon.js');
    const svc = new Service({ name, script: DAEMON_PATH });
    svc.uninstall();
    console.log(`[preuninstall] node-windows 卸载指令已发送`);
  } catch (e) {
    // node-windows 可能未安装或已卸载
  }

  // 6. 最终兜底：使用 sc.exe 直接从注册表删除服务
  try {
    execSync(`sc.exe delete "${name}" 2>nul`, { stdio: 'ignore', timeout: 10000 });
    console.log(`[preuninstall] 服务 ${name} 已从注册表删除`);
  } catch (e) {
    // 服务可能已不存在
  }

  // 7. 短暂停顿，让操作系统回收文件句柄
  try {
    execSync('timeout /t 2 /nobreak >nul 2>&1', { stdio: 'ignore', timeout: 5000 });
  } catch (e) {}
}

if (process.platform === 'win32') {
  for (const name of SERVICES) {
    forceCleanupService(name);
  }

  // 最后再等待几秒，确保 Windows 完全释放文件锁
  try {
    execSync('timeout /t 3 /nobreak >nul 2>&1', { stdio: 'ignore', timeout: 5000 });
    console.log('[preuninstall] 文件锁清理完成，npm 可以继续卸载');
  } catch (e) {}
}

process.exit(0);
