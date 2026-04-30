const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');

const log = createLogger('updater');
const execAsync = promisify(exec);

const PACKAGE_NAME = 'claw-subagent-service';
const CHECK_INTERVAL = 1000 * 60 * 60 * 6; // 6 小时

class Updater {
  constructor() {
    this.currentVersion = this.loadCurrentVersion();
    this.isUpdating = false;
    this.updateTimer = null;
  }

  loadCurrentVersion() {
    try {
      // 从全局安装的 package.json 读取版本
      const globalPkg = path.join(__dirname, '..', 'package.json');
      if (fs.existsSync(globalPkg)) {
        const pkg = JSON.parse(fs.readFileSync(globalPkg, 'utf8'));
        return pkg.version || '0.0.0';
      }
    } catch {
      // ignore
    }
    return '0.0.0';
  }

  async getLatestVersion() {
    try {
      const { stdout } = await execAsync(`npm view ${PACKAGE_NAME} version --json`, {
        timeout: 15000,
        windowsHide: true,
      });
      const version = stdout.trim().replace(/^"|"$/g, '');
      if (version && /^\d+\.\d+\.\d+/.test(version)) {
        return version;
      }
    } catch (err) {
      log.warn(`[UPDATER] 查询 npm 版本失败: ${err.message}`);
    }
    return null;
  }

  compareVersion(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] || 0) > (pb[i] || 0)) return 1;
      if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    }
    return 0;
  }

  async check() {
    if (this.isUpdating) return null;

    const latest = await this.getLatestVersion();
    if (!latest) return null;

    if (this.compareVersion(latest, this.currentVersion) > 0) {
      log.info(`[UPDATER] 发现新版本: ${this.currentVersion} → ${latest}`);
      return { version: latest };
    }
    return null;
  }

  async execute(info) {
    if (this.isUpdating) return { success: false, error: '更新进行中' };
    this.isUpdating = true;

    try {
      log.info(`[UPDATER] 开始更新: ${this.currentVersion} → ${info.version}`);

      // 使用 npm 全局安装最新版本
      const { stdout, stderr } = await execAsync(
        `npm install -g ${PACKAGE_NAME}@latest`,
        { timeout: 300000, windowsHide: true }
      );

      if (stderr) {
        log.warn(`[UPDATER] npm 安装警告: ${stderr.substring(0, 500)}`);
      }

      log.info(`[UPDATER] npm 安装输出: ${stdout.substring(0, 500)}`);
      log.info(`[UPDATER] 更新完成，准备重启 Worker`);

      this.currentVersion = info.version;
      return { success: true };
    } catch (err) {
      log.error(`[UPDATER] 更新失败: ${err.message}`);
      return { success: false, error: err.message };
    } finally {
      this.isUpdating = false;
    }
  }

  startSchedule(restartWorkerCallback) {
    this.restartWorker = restartWorkerCallback;

    const run = async () => {
      try {
        const info = await this.check();
        if (info) {
          const result = await this.execute(info);
          if (result.success) {
            // npm 全局安装完成后，直接重启 Worker 即可加载新代码
            this.restartWorker(null);
          }
        }
      } catch (err) {
        log.error(`[UPDATER] 定时检查异常: ${err.message || err}`);
      }
    };

    run();
    this.updateTimer = setInterval(run, CHECK_INTERVAL);
  }

  stopSchedule() {
    if (this.updateTimer) clearInterval(this.updateTimer);
  }
}

module.exports = { Updater };
