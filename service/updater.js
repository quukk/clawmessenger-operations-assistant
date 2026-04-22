const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const { createLogger } = require('./logger');

const log = createLogger('updater');

const CONFIG = {
  UPDATE_URL: 'https://your-cdn.com/api/version',
  CHECK_INTERVAL: 10000 * 60 * 60 * 6,
  ROLLBACK_TIMEOUT: 10000 * 60 * 5,
  CURRENT_VERSION_PATH: path.join(__dirname, '..', 'version.json'),
  UPDATE_DIR: path.join(__dirname, '..', 'update'),
  BACKUP_DIR: path.join(__dirname, '..', 'backup'),
  SERVICE_DIR: path.join(__dirname)
};

[CONFIG.UPDATE_DIR, CONFIG.BACKUP_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

class Updater {
  constructor() {
    this.currentVersion = this.loadCurrentVersion();
    this.isUpdating = false;
    this.updateTimer = null;
  }

  loadCurrentVersion() {
    try {
      const raw = fs.readFileSync(CONFIG.CURRENT_VERSION_PATH, 'utf8');
      return JSON.parse(raw).version;
    } catch {
      return '0.0.0';
    }
  }

  saveVersion(ver) {
    fs.writeFileSync(CONFIG.CURRENT_VERSION_PATH, JSON.stringify({
      version: ver,
      updatedAt: new Date().toISOString()
    }, null, 2));
  }

  async check() {
    if (this.isUpdating) return null;

    return new Promise((resolve, reject) => {
      const url = new URL(`${CONFIG.UPDATE_URL}?current=${this.currentVersion}&arch=${process.platform}`);
      const client = url.protocol === 'https:' ? https : http;

      const req = client.get(url, { timeout: 15000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            if (res.statusCode === 204) {
              resolve(null);
              return;
            }
            const info = JSON.parse(data);
            if (this.compareVersion(info.version, this.currentVersion) > 0) {
              log.info(`[UPDATER] 发现新版本: ${this.currentVersion} → ${info.version}`);
              resolve(info);
            } else {
              resolve(null);
            }
          } catch (e) {
            reject(new Error('版本接口返回非法JSON'));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('版本检测超时'));
      });
    });
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

  async download(url, dest, expectedSize = 0) {
    return new Promise((resolve, reject) => {
      const tempPath = dest + '.tmp';
      let startByte = 0;

      if (fs.existsSync(tempPath)) {
        startByte = fs.statSync(tempPath).size;
        log.info(`[UPDATER] 断点续传: ${startByte} bytes`);
      }

      const client = url.startsWith('https') ? https : http;
      const req = client.get(url, {
        headers: startByte > 0 ? { 'Range': `bytes=${startByte}-` } : {},
        timeout: 30000
      }, (res) => {
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          return reject(new Error(`下载失败，HTTP ${res.statusCode}`));
        }

        const total = parseInt(res.headers['content-length'] || expectedSize) + startByte;
        const file = fs.createWriteStream(tempPath, { flags: startByte > 0 ? 'a' : 'w' });
        let downloaded = startByte;

        res.pipe(file);
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (total && downloaded % (1024 * 1024 * 5) < chunk.length) {
            log.info(`[UPDATER] 下载进度: ${(downloaded / total * 100).toFixed(1)}%`);
          }
        });

        file.on('finish', () => {
          file.close();
          fs.renameSync(tempPath, dest);
          resolve(dest);
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('下载超时'));
      });
    });
  }

  async verifyHash(filePath, expectedHash) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', d => hash.update(d));
      stream.on('end', () => {
        const actual = 'sha256:' + hash.digest('hex');
        if (actual === expectedHash) {
          resolve(true);
        } else {
          reject(new Error(`哈希校验失败: ${actual} ≠ ${expectedHash}`));
        }
      });
      stream.on('error', reject);
    });
  }

  async unzip(zipPath, extractTo) {
    return new Promise((resolve, reject) => {
      const psCmd = `powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractTo}' -Force"`;
      exec(psCmd, { timeout: 600000 }, (err, stdout, stderr) => {
        if (err) {
          log.error(`[UPDATER] PowerShell 解压失败: ${stderr}`);
          const sevenz = `7z x "${zipPath}" -o"${extractTo}" -y`;
          exec(sevenz, { timeout: 600000 }, (err2) => {
            if (err2) reject(new Error('解压失败，请确保系统有 PowerShell 或 7-Zip'));
            else resolve();
          });
        } else {
          resolve();
        }
      });
    });
  }

  async atomicReplace(newDir) {
    const serviceDir = CONFIG.SERVICE_DIR;
    const backupDir = path.join(CONFIG.BACKUP_DIR, `bak-${Date.now()}`);

    fs.mkdirSync(backupDir, { recursive: true });

    const items = fs.readdirSync(serviceDir);
    for (const item of items) {
      if (item === 'node_modules') continue;
      const src = path.join(serviceDir, item);
      const dst = path.join(backupDir, item);

      try {
        fs.renameSync(src, dst);
      } catch (e) {
        if (fs.statSync(src).isDirectory()) {
          this.copyDir(src, dst);
        } else {
          fs.copyFileSync(src, dst);
          const lockedTrash = src + '.old';
          try {
            fs.renameSync(src, lockedTrash);
          } catch (renameErr) {
            log.error(`[UPDATER] 文件被占用，无法重命名: ${src}`);
          }
        }
      }
    }

    const newItems = fs.readdirSync(newDir);
    for (const item of newItems) {
      const src = path.join(newDir, item);
      const dst = path.join(serviceDir, item);
      fs.renameSync(src, dst);
    }

    this.scheduleCleanup(backupDir);

    log.info(`[UPDATER] 原子替换完成，备份: ${backupDir}`);
    return backupDir;
  }

  copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const s = path.join(src, entry.name);
      const d = path.join(dest, entry.name);
      entry.isDirectory() ? this.copyDir(s, d) : fs.copyFileSync(s, d);
    }
  }

  scheduleCleanup(dir) {
    setTimeout(() => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        const olds = fs.readdirSync(CONFIG.SERVICE_DIR).filter(f => f.endsWith('.old'));
        olds.forEach(f => {
          try {
            fs.rmSync(path.join(CONFIG.SERVICE_DIR, f), { force: true });
          } catch { }
        });
      } catch (e) {
        log.error(`[UPDATER] 清理失败: ${e.message}`);
      }
    }, CONFIG.ROLLBACK_TIMEOUT + 5000);
  }

  async rollback(backupDir) {
    log.error(`[UPDATER] 启动回滚...`);
    const serviceDir = CONFIG.SERVICE_DIR;

    const badDir = path.join(CONFIG.BACKUP_DIR, `bad-${Date.now()}`);
    fs.mkdirSync(badDir, { recursive: true });

    fs.readdirSync(serviceDir).forEach(item => {
      if (item === 'node_modules' || item.endsWith('.old')) return;
      try {
        fs.renameSync(path.join(serviceDir, item), path.join(badDir, item));
      } catch { }
    });

    fs.readdirSync(backupDir).forEach(item => {
      try {
        fs.renameSync(path.join(backupDir, item), path.join(serviceDir, item));
      } catch { }
    });

    log.info(`[UPDATER] 回滚完成，已恢复旧版本`);
  }

  async execute(info) {
    if (this.isUpdating) return { success: false, error: '更新进行中' };
    this.isUpdating = true;

    try {
      log.info(`[UPDATER] 开始更新: ${this.currentVersion} → ${info.version}`);

      const zipFile = path.join(CONFIG.UPDATE_DIR, `v${info.version}.zip`);
      await this.download(info.url, zipFile, info.size);

      if (info.hash) {
        await this.verifyHash(zipFile, info.hash);
        log.info(`[UPDATER] 哈希校验通过`);
      }

      const extractDir = path.join(CONFIG.UPDATE_DIR, `v${info.version}`);
      if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true });
      fs.mkdirSync(extractDir, { recursive: true });
      await this.unzip(zipFile, extractDir);

      const extractSubDir = this.findServiceDir(extractDir);
      const backupDir = await this.atomicReplace(extractSubDir);

      this.saveVersion(info.version);
      this.currentVersion = info.version;

      fs.rmSync(zipFile, { force: true });
      try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch { }

      log.info(`[UPDATER] 文件替换完成，准备重启 Worker`);
      return { success: true, backupDir };
    } catch (err) {
      log.error(`[UPDATER] 更新失败: ${err.message}`);
      try { fs.rmSync(CONFIG.UPDATE_DIR, { recursive: true, force: true }); } catch { }
      return { success: false, error: err.message };
    } finally {
      this.isUpdating = false;
    }
  }

  findServiceDir(extractDir) {
    const items = fs.readdirSync(extractDir);
    if (items.length === 1) {
      const subPath = path.join(extractDir, items[0]);
      if (fs.statSync(subPath).isDirectory()) {
        const subItems = fs.readdirSync(subPath);
        if (subItems.some(i => i.endsWith('.js'))) {
          return subPath;
        }
      }
    }
    return extractDir;
  }

  startSchedule(restartWorkerCallback) {
    this.restartWorker = restartWorkerCallback;

    const run = async () => {
      try {
        const info = await this.check();
        if (info) {
          const result = await this.execute(info);
          if (result.success) {
            this.restartWorker(result.backupDir);
          }
        }
      } catch (err) {
        log.error(`[UPDATER] 定时检查异常: ${err.message}`);
      }
    };

    run();
    this.updateTimer = setInterval(run, CONFIG.CHECK_INTERVAL);
  }

  stopSchedule() {
    if (this.updateTimer) clearInterval(this.updateTimer);
  }
}

module.exports = { Updater };