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

  worker = fork(WORKER_PATH, [], { stdio: 'pipe' });

  worker.stdout?.on('data', d => log.info(`[WORKER] ${d.toString().trim()}`));
  worker.stderr?.on('data', d => {
    const msg = d.toString().trim();
    // 融云 SDK 的警告信息输出到 stderr，但级别不是错误
    if (msg.includes('[WARN]') || msg.includes('DeprecationWarning') || msg.includes('[IMLib][WARN]')) {
      log.warn(`[WORKER] ${msg}`);
    } else {
      log.error(`[WORKER] ${msg}`);
    }
  });

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

  setTimeout(() => {
    if (worker) {
      worker.removeAllListeners('exit');
      worker.kill('SIGTERM');

      const waitKill = setInterval(() => {
        if (!worker || worker.killed) {
          clearInterval(waitKill);
          worker = null;
          setTimeout(() => startWorker(true, backupDir), 1000);
        } else {
          worker.kill('SIGKILL');
        }
      }, 500);
    } else {
      startWorker(true, backupDir);
    }
  }, 3000);
}

function gracefulShutdown() {
  stopping = true;
  updater.stopSchedule();
  log.info('[DAEMON] 收到停止信号，正在终止 Worker...');

  if (worker) {
    worker.kill('SIGTERM');
    setTimeout(() => {
      if (worker && !worker.killed) {
        log.error('[DAEMON] Worker 未响应，强制杀死');
        worker.kill('SIGKILL');
      }
      process.exit(0);
    }, 5000);
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