const { fork } = require('child_process');
const path = require('path');
const { createLogger } = require('./logger');
const { Updater } = require('./updater');

const log = createLogger('daemon');
const WORKER_PATH = path.join(__dirname, 'worker.js');

let worker = null;
let stopping = false;
let isRollingBack = false;
let healthTimer = null;
let currentBackupDir = null;
const updater = new Updater();

process.chdir(__dirname);

function startWorker(isAfterUpdate = false, backupDirForRollback = null) {
  if (stopping || isRollingBack) return;

  log.info(`[DAEMON] 启动 Worker，PID: ${process.pid}，更新后重启: ${isAfterUpdate}`);

  // Windows 服务中需要使用 detached: true 避免控制台关联问题
  const forkOptions = {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    detached: process.platform === 'win32',
    windowsHide: process.platform === 'win32'
  };

  worker = fork(WORKER_PATH, [], forkOptions);

  worker.stdout?.on('data', d => log.info(`[WORKER] ${d.toString().trim()}`));
  worker.stderr?.on('data', d => log.error(`[WORKER] ${d.toString().trim()}`));

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

    log.error(`[DAEMON] Worker 退出，code=${code}, signal=${signal}`);
    worker = null;

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
      setTimeout(() => startWorker(false, null), 3000);
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
          worker.kill('SIGTERM');
        }
      } else {
        worker.kill('SIGTERM');
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
              worker.kill('SIGKILL');
            }
          } else {
            worker.kill('SIGKILL');
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
    // 先尝试优雅地通知 Worker 退出
    try {
      worker.send({ type: 'prepare-shutdown', reason: 'daemon-stopping' });
    } catch (e) {
      // 忽略发送失败
    }

    // Windows 上等待时间稍长，给子进程时间清理
    const waitTime = process.platform === 'win32' ? 8000 : 5000;

    setTimeout(() => {
      if (worker && !worker.killed) {
        log.error('[DAEMON] Worker 未响应，强制杀死');
        // Windows 上使用 taskkill 确保进程树被终止
        if (process.platform === 'win32' && worker.pid) {
          try {
            const { execSync } = require('child_process');
            execSync(`taskkill /pid ${worker.pid} /T /F 2>nul`, { windowsHide: true });
          } catch (e) {
            // 忽略错误，使用 kill 作为后备
            worker.kill('SIGKILL');
          }
        } else {
          worker.kill('SIGKILL');
        }
      }
      process.exit(0);
    }, waitTime);
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('message', (msg) => {
  if (msg === 'shutdown') gracefulShutdown();
});

startWorker(false, null);
updater.startSchedule(restartWorkerWithUpdate);

process.on('uncaughtException', (err) => {
  log.error(`[DAEMON] 未捕获异常: ${err.message}`);
});

process.on('unhandledRejection', (reason) => {
  log.error(`[DAEMON] 未捕获 Promise: ${reason}`);
});