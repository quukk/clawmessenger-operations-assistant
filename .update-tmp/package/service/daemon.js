const { fork, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createLogger } = require('./logger');
const { Updater } = require('./updater');
const { checkPortListening } = require('./modules/port-checker');

const log = createLogger('daemon');
const WORKER_PATH = path.join(__dirname, 'worker.js');
const PORT = process.env.SILENT_SERVICE_PORT ? parseInt(process.env.SILENT_SERVICE_PORT, 10) : 28765;
// 使用全局 PID 文件，防止不同安装路径的多个实例同时运行
const PID_FILE = (() => {
  if (process.platform === 'win32') {
    const programData = process.env.PROGRAMDATA || process.env.ALLUSERSPROFILE || 'C:\\ProgramData';
    return path.join(programData, 'claw-subagent-service', 'daemon.pid');
  }
  return path.join(os.tmpdir(), '.claw-subagent-service.pid');
})();

let worker = null;
let currentWorkerPid = null;
let stopping = false;
let isRollingBack = false;
let healthTimer = null;
let currentBackupDir = null;
let crashCount = 0;
let lastCrashTime = 0;
const updater = new Updater();

// 检测是否是 npm 更新后的重启
const VERSION_FILE = path.join(os.tmpdir(), '.claw-subagent-service.version');
function detectUpdateRestart() {
  try {
    const currentVersion = updater.loadCurrentVersion();
    let previousVersion = null;
    
    if (fs.existsSync(VERSION_FILE)) {
      previousVersion = fs.readFileSync(VERSION_FILE, 'utf8').trim();
    }
    
    // 写入当前版本
    fs.writeFileSync(VERSION_FILE, currentVersion);
    
    // 如果之前有版本记录，且当前版本不同，说明是更新后的重启
    if (previousVersion && previousVersion !== currentVersion) {
      log.info(`[DAEMON] 检测到版本变化: ${previousVersion} → ${currentVersion}，这是更新后的重启`);
      return true;
    }
  } catch (err) {
    log.warn(`[DAEMON] 检测版本变化失败: ${err.message}`);
  }
  return false;
}

process.chdir(__dirname);

/**
 * 检查是否有其他 Daemon 实例在运行
 */
function checkSingleton() {
  try {
    if (fs.existsSync(PID_FILE)) {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (!isNaN(pid)) {
        try {
          // 发送信号 0 检查进程是否存在（Windows 也支持）
          process.kill(pid, 0);
          log.error(`[DAEMON] 另一个 Daemon 实例已在运行 (PID: ${pid})，当前实例退出`);
          return false;
        } catch (err) {
          if (err.code === 'EPERM') {
            // 进程存在但无权限发送信号，视为仍在运行
            log.error(`[DAEMON] 另一个 Daemon 实例已在运行 (PID: ${pid}, 权限不足)，当前实例退出`);
            return false;
          }
          // 进程不存在（ESRCH），清理 stale PID 文件
          log.info(`[DAEMON] 发现 stale PID 文件 (PID: ${pid} 已不存在)，清理中...`);
          try { fs.unlinkSync(PID_FILE); } catch { /* 忽略 */ }
        }
      } else {
        // PID 文件内容无效，清理
        try { fs.unlinkSync(PID_FILE); } catch { /* 忽略 */ }
      }
    }
  } catch {
    // PID 文件读取失败，继续启动
  }

  try {
    const pidDir = path.dirname(PID_FILE);
    if (!fs.existsSync(pidDir)) {
      fs.mkdirSync(pidDir, { recursive: true });
    }
    fs.writeFileSync(PID_FILE, String(process.pid));
  } catch (err) {
    log.warn(`[DAEMON] 写入 PID 文件失败: ${err.message}`);
  }
  return true;
}

/**
 * 清理 PID 文件
 */
function cleanupPidFile() {
  try {
    if (fs.existsSync(PID_FILE)) {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (pid === process.pid) {
        fs.unlinkSync(PID_FILE);
      }
    }
  } catch {
    // 忽略清理错误
  }
}

if (!checkSingleton()) {
  process.exit(0);
}

process.on('exit', cleanupPidFile);
process.on('SIGINT', cleanupPidFile);
process.on('SIGTERM', cleanupPidFile);

/**
 * 尝试释放占用的端口（杀死占用进程）
 * Windows 下检查本地地址（第二列）是否匹配目标端口，不限于 LISTENING 状态
 */
function freePortIfNeeded(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr ":${port}"`, {
        encoding: 'utf8', timeout: 5000, windowsHide: true,
      });
      for (const line of out.split('\n')) {
        const parts = line.trim().split(/\s+/);
        const localAddr = parts[1] || '';
        if (localAddr.endsWith(`:${port}`) || localAddr.endsWith(`]:${port}`)) {
          const pid = parseInt(parts[parts.length - 1], 10);
          if (pid && pid > 0 && pid !== currentWorkerPid && pid !== process.pid) {
            log.warn(`[DAEMON] 端口 ${port} 被进程 ${pid} 占用，正在释放...`);
            try {
              execSync(`taskkill /F /PID ${pid}`, { timeout: 5000, windowsHide: true });
            } catch (e) {
              log.warn(`[DAEMON] 终止进程 ${pid} 失败: ${e.message}`);
            }
          }
        }
      }
    } else {
      // Linux / macOS：优先 lsof，兜底 fuser / ss / netstat / pkill
      let pid = 0;
      const commands = [
        `lsof -i :${port} -t 2>/dev/null`,
        `fuser ${port}/tcp 2>/dev/null`,
        `ss -tlnp 2>/dev/null | grep -oP 'pid=\\K[0-9]+'`,
        `netstat -tlnp 2>/dev/null | grep ":${port} " | awk '{print $7}' | cut -d'/' -f1`,
      ];
      for (const cmd of commands) {
        try {
          // 精简 Docker 镜像中部分命令可能极慢或不存在，缩短超时避免阻塞
          const out = execSync(cmd, { encoding: 'utf8', timeout: 2000 }).trim();
          const firstLine = out.split(/\r?\n/)[0];
          const candidate = parseInt(firstLine, 10);
          if (candidate && candidate > 0 && candidate !== currentWorkerPid && candidate !== process.pid) {
            pid = candidate;
            break;
          }
        } catch { /* 命令不可用，继续下一个兜底 */ }
      }

      if (pid) {
        log.warn(`[DAEMON] 端口 ${port} 被进程 ${pid} 占用，正在释放...`);
        try { process.kill(pid, 'SIGKILL'); } catch (e) {
          log.warn(`[DAEMON] 终止进程 ${pid} 失败: ${e.message}`);
        }
      } else {
        // 所有端口查询命令都不可用（常见于精简 Docker 镜像）
        // 兜底：杀掉残留 Worker 进程（Daemon 自身的命令行不含 worker.js，不会自杀）
        try {
          execSync('pkill -9 -f "worker.js" 2>/dev/null || true', { timeout: 2000 });
          log.warn(`[DAEMON] 已尝试杀掉残留 Worker 进程`);
        } catch { /* 忽略 */ }
      }
    }
  } catch { /* 端口已被释放或无法查询 */ }
}

/**
 * 获取重启延迟（指数退避，最大 60 秒）
 */
function getRestartDelay() {
  const now = Date.now();
  // 如果距离上次崩溃超过 30 秒，重置计数器
  if (now - lastCrashTime > 30000) {
    crashCount = 0;
  }
  lastCrashTime = now;
  crashCount++;
  // 指数退避: 1s, 2s, 4s, 8s, 16s, 32s, 60s(封顶)
  const delay = Math.min(1000 * Math.pow(2, crashCount - 1), 60000);
  log.info(`[DAEMON] Worker 连续崩溃 ${crashCount} 次，等待 ${delay / 1000}s 后重启`);
  return delay;
}

function startWorker(isAfterUpdate = false, backupDirForRollback = null) {
  if (stopping || isRollingBack) return;

  // 修复：如果 daemon 的 cwd 已失效（如目录被删除/替换），先切到临时目录，避免 worker 继承无效路径
  try {
    process.cwd();
  } catch (e) {
    if (e.code === 'ENOENT') {
      try { process.chdir(os.tmpdir()); } catch {}
    }
  }

  log.info(`[DAEMON] 启动 Worker，daemon PID: ${process.pid}，更新后重启: ${isAfterUpdate}`);
  log.info(`[DAEMON] Daemon 目录: ${__dirname}`);
  log.info(`[DAEMON] Worker 路径: ${WORKER_PATH}`);

  // 启动前释放旧端口，防止旧 worker 残留占用
  freePortIfNeeded(PORT);

  const forkOptions = {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    // Windows 服务中 detached:true 会导致 worker 成为孤儿进程，
    // 服务重启后旧 worker 依然占着端口引发 EADDRINUSE，因此使用默认 detached:false
    windowsHide: true
  };

  worker = fork(WORKER_PATH, [], forkOptions);
  currentWorkerPid = worker.pid || null;

  // 只有 pipe 模式才需要手动转发到 logger
  if (forkOptions.stdio !== 'inherit') {
    worker.stdout?.on('data', d => log.info(`[WORKER] ${d.toString().trim()}`));
    worker.stderr?.on('data', d => log.error(`[WORKER] ${d.toString().trim()}`));
  }

  if (isAfterUpdate && backupDirForRollback) {
    currentBackupDir = backupDirForRollback;
    healthTimer = setTimeout(() => {
      log.info('[DAEMON] 新版 Worker 健康观察通过（5分钟未崩溃），更新成功');
      currentBackupDir = null;
    }, 5 * 60 * 1000);
  }

  worker.on('exit', (code, signal) => {
    if (healthTimer) {
      clearTimeout(healthTimer);
      healthTimer = null;
    }

    worker = null;
    currentWorkerPid = null;

    // 正常退出（code=0, signal=null）视为优雅关闭，不增加崩溃计数
    const isNormalExit = code === 0 && signal === null;
    if (isNormalExit) {
      log.info(`[DAEMON] Worker 正常退出，code=${code}, signal=${signal}`);
    } else {
      log.error(`[DAEMON] Worker 异常退出，code=${code}, signal=${signal}`);
    }

    if (isAfterUpdate && code !== 0 && currentBackupDir && !isRollingBack) {
      isRollingBack = true;
      log.error('[DAEMON] 新版 Worker 启动后异常退出，触发自动回滚！');

      updater.rollback(currentBackupDir).then(() => {
        isRollingBack = false;
        currentBackupDir = null;
        log.info('[DAEMON] 回滚完成，重新启动旧版 Worker...');
        startWorker(false, null);
      }).catch(err => {
        log.error(`[DAEMON] 回滚失败: ${err.message}`);
        isRollingBack = false;
        currentBackupDir = null;
        startWorker(false, null);
      });
      return;
    }

    if (!stopping && !isRollingBack) {
      // 正常退出使用固定 1 秒延迟；异常退出使用指数退避
      const delay = isNormalExit ? 1000 : getRestartDelay();
      if (!isNormalExit) {
        log.info(`[DAEMON] Worker 连续崩溃 ${crashCount} 次，等待 ${delay / 1000}s 后重启`);
      }
      setTimeout(() => startWorker(false, null), delay);
    }
  });

  worker.on('error', (err) => {
    log.error(`[DAEMON] Worker 启动错误: ${err.message}`);
  });
}

function restartWorkerWithUpdate(backupDir) {
  if (!worker) {
    startWorker(true, backupDir);
    return;
  }

  log.info('[DAEMON] 收到更新重启指令，优雅终止当前 Worker...');

  worker.send({ type: 'prepare-shutdown', reason: 'update' });

  // Windows 上等待时间稍长
  const waitTime = process.platform === 'win32' ? 5000 : 3000;

  setTimeout(() => {
    if (worker) {
      worker.removeAllListeners('exit');

      // Windows 上使用 taskkill 确保进程树被终止
      if (process.platform === 'win32' && worker.pid) {
        try {
          const { execSync } = require('child_process');
          execSync(`taskkill /pid ${worker.pid} /T /F 2>nul`, { windowsHide: true });
        } catch (e) {
          // 忽略错误，使用 kill 作为后备
          try { worker.kill('SIGTERM'); } catch { /* 进程可能已退出 */ }
        }
      } else {
        try { worker.kill('SIGTERM'); } catch { /* 进程可能已退出 */ }
      }

      const waitKill = setInterval(() => {
        if (!worker || worker.killed) {
          clearInterval(waitKill);
          worker = null;
          setTimeout(() => startWorker(true, backupDir), 1000);
        } else {
          // 再次尝试强制终止
          if (process.platform === 'win32' && worker.pid) {
            try {
              const { execSync } = require('child_process');
              execSync(`taskkill /pid ${worker.pid} /T /F 2>nul`, { windowsHide: true });
            } catch (e) {
              try { worker.kill('SIGKILL'); } catch { /* 进程可能已退出 */ }
            }
          } else {
            try { worker.kill('SIGKILL'); } catch { /* 进程可能已退出 */ }
          }
        }
      }, 500);
    } else {
      startWorker(true, backupDir);
    }
  }, waitTime);
}

function gracefulShutdown() {
  stopping = true;
  updater.stopSchedule();
  log.info('[DAEMON] 收到停止信号，正在终止 Worker...');

  if (worker) {
    // Windows 上直接使用 taskkill /T 杀死整个进程树
    if (process.platform === 'win32' && worker.pid) {
      try {
        execSync(`taskkill /pid ${worker.pid} /T /F 2>nul`, { timeout: 5000, windowsHide: true });
      } catch (e) {
        try { worker.kill('SIGKILL'); } catch { /* 忽略 */ }
      }
    } else {
      try { worker.kill('SIGKILL'); } catch { /* 忽略 */ }
    }
    worker = null;
  }

  // Worker 已被 SIGKILL，端口会立即释放，无需再执行可能阻塞的 freePortIfNeeded
  // 旧代码在此处调用 freePortIfNeeded，其内部的 execSync 命令链在精简 Docker 中
  // 可能阻塞 20+ 秒，导致 kill -15 后旧进程迟迟不退出，新实例 checkSingleton 失败。
  cleanupPidFile();
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('message', (msg) => {
  if (msg === 'shutdown') gracefulShutdown();
});

// 检测是否是 npm 更新后的重启
const isAfterNpmUpdate = detectUpdateRestart();
if (isAfterNpmUpdate) {
  log.info('[DAEMON] npm 更新后的重启，启动 Worker 并设置健康观察...');
  startWorker(true, null);
} else {
  startWorker(false, null);
}
updater.startSchedule(restartWorkerWithUpdate);

process.on('uncaughtException', (err) => {
  log.error(`[DAEMON] 未捕获异常: ${err.message}`);
});

process.on('unhandledRejection', (reason) => {
  log.error(`[DAEMON] 未捕获 Promise: ${reason}`);
});