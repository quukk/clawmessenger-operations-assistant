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
    this.pkgJsonPath = path.join(__dirname, '..', 'package.json');
    this.isGlobalInstall = this.detectGlobalInstall();
  }

  detectGlobalInstall() {
    const cwd = path.normalize(__dirname).toLowerCase();
    const inNodeModules = cwd.includes('node_modules');
    const globalPaths = [
      'npm', 'node_modules', '.nvm', 'usr/local/lib', 'usr/lib',
    ];
    const inGlobalPath = globalPaths.some(p => cwd.includes(p.toLowerCase()));
    return inNodeModules || inGlobalPath;
  }

  loadCurrentVersion() {
    try {
      const pkgPath = path.join(__dirname, '..', 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
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

      let updateOk = false;
      if (this.isGlobalInstall) {
        updateOk = await this.updateGlobalPackage(info.version);
      } else {
        updateOk = await this.updateLocalPackage(info.version);
      }

      if (!updateOk) {
        return { success: false, error: '版本未变化' };
      }

      this.currentVersion = info.version;
      log.info(`[UPDATER] 更新完成，当前版本: ${this.currentVersion}，准备重启 Worker`);
      return { success: true };
    } catch (err) {
      log.error(`[UPDATER] 更新失败: ${err.message}`);
      return { success: false, error: err.message };
    } finally {
      this.isUpdating = false;
    }
  }

  async updateGlobalPackage(version) {
    const { stdout, stderr } = await execAsync(
      `npm install -g ${PACKAGE_NAME}@${version}`,
      { timeout: 300000, windowsHide: true }
    );

    if (stderr) {
      log.warn(`[UPDATER] npm 安装警告: ${stderr.substring(0, 500)}`);
    }
    log.info(`[UPDATER] npm 安装输出: ${stdout.substring(0, 500)}`);

    // 全局安装后重新读取版本确认
    const newVersion = this.loadCurrentVersion();
    if (this.compareVersion(newVersion, this.currentVersion) <= 0) {
      log.warn(`[UPDATER] 更新后版本未变化: ${this.currentVersion} → ${newVersion}，可能安装路径不一致`);
      return false;
    }
    return true;
  }

  async updateLocalPackage(version) {
    const pkgDir = path.dirname(this.pkgJsonPath);
    const tmpDir = path.join(pkgDir, '.update-tmp');

    try {
      // 1. 清理临时目录
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
      fs.mkdirSync(tmpDir, { recursive: true });

      // 2. 下载 tarball
      log.info(`[UPDATER] 下载 ${PACKAGE_NAME}@${version} ...`);
      const { stdout } = await execAsync(
        `npm pack ${PACKAGE_NAME}@${version}`,
        { cwd: tmpDir, timeout: 120000, windowsHide: true }
      );
      const tarballName = stdout.trim().split('\n').pop();
      const tarballPath = path.join(tmpDir, tarballName);
      if (!fs.existsSync(tarballPath)) {
        throw new Error('tarball 下载失败');
      }

      // 3. 解压 tarball
      log.info(`[UPDATER] 解压 ${tarballName} ...`);
      await execAsync(
        `tar -xzf ${tarballPath} -C ${tmpDir}`,
        { timeout: 30000 }
      );

      // 4. 复制 package/ 下的文件覆盖当前目录
      const extractedDir = path.join(tmpDir, 'package');
      if (!fs.existsSync(extractedDir)) {
        throw new Error('解压后未找到 package 目录');
      }

      log.info(`[UPDATER] 覆盖本地文件...`);
      this.copyDirSync(extractedDir, pkgDir);

      // 5. 重新安装依赖（因为 node_modules 被覆盖）
      log.info(`[UPDATER] 重新安装依赖...`);
      const { stdout: installOut, stderr: installErr } = await execAsync(
        'npm install --production',
        { cwd: pkgDir, timeout: 300000, windowsHide: true }
      );
      if (installErr) {
        log.warn(`[UPDATER] npm install 警告: ${installErr.substring(0, 500)}`);
      }
      log.info(`[UPDATER] npm install 输出: ${installOut.substring(0, 500)}`);

      // 6. 验证版本
      const newVersion = this.loadCurrentVersion();
      if (this.compareVersion(newVersion, this.currentVersion) <= 0) {
        log.warn(`[UPDATER] 更新后版本未变化: ${this.currentVersion} → ${newVersion}`);
        return false;
      }

      log.info(`[UPDATER] 本地更新成功: ${this.currentVersion} → ${newVersion}`);
      return true;
    } catch (err) {
      log.error(`[UPDATER] 本地更新异常: ${err.message}`);
      return false;
    } finally {
      // 清理临时目录
      try {
        if (fs.existsSync(tmpDir)) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      } catch { /* 忽略 */ }
    }
  }

  copyDirSync(src, dest) {
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      // 跳过隐藏文件、日志和临时目录
      if (entry.name.startsWith('.') || entry.name === 'logs') {
        continue;
      }

      if (entry.isDirectory()) {
        if (!fs.existsSync(destPath)) {
          fs.mkdirSync(destPath, { recursive: true });
        }
        this.copyDirSync(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  startSchedule(restartWorkerCallback) {
    this.restartWorker = restartWorkerCallback;

    // Docker / 本地开发环境可通过环境变量禁用自动更新
    if (process.env.DISABLE_AUTO_UPDATE === 'true' || process.env.DISABLE_AUTO_UPDATE === '1') {
      log.info('[UPDATER] 已禁用自动更新（DISABLE_AUTO_UPDATE 已设置）');
      return;
    }

    // Linux 平台默认禁用自动更新 npm 包
    if (process.platform === 'linux') {
      log.info('[UPDATER] Linux 平台已禁用自动 npm 更新');
      return;
    }

    const run = async () => {
      try {
        const info = await this.check();
        if (info) {
          const result = await this.execute(info);
          if (result.success) {
            // npm 安装完成后，直接重启 Worker 即可加载新代码
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
