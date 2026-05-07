#!/usr/bin/env node

/**
 * sync-local.js - 本地开发快速同步脚本
 *
 * 运行后将当前代码直接替换到全局安装的 claw-subagent-service 目录，
 * 无需发布到 npm 后再重新下载安装。
 *
 * 用法:
 *   npm run sync        (推荐)
 *   node scripts/sync-local.js
 *
 * 注意: Windows 下若服务正在运行，会自动卸载服务、同步后再重新安装。
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const isWindows = process.platform === 'win32';
const SERVICE_NAME = 'claw-subagent-service';
const PACKAGE_NAME = 'claw-subagent-service';
const ROOT = path.join(__dirname, '..');

// 需要同步的文件/目录（与 package.json files 保持一致）
const FILES_TO_SYNC = [
  'cli.js',
  'service',
  'scripts',
  'command',
  'version.json',
  'README.md',
  'package.json',
];

function getGlobalPackageDir() {
  try {
    const globalRoot = execSync('npm root -g', {
      encoding: 'utf-8',
      windowsHide: true,
    }).trim();
    return path.join(globalRoot, PACKAGE_NAME);
  } catch (e) {
    console.error('❌ 无法获取全局 npm 路径:', e.message);
    process.exit(1);
  }
}

function stopAndUninstallService() {
  if (!isWindows) {
    try {
      execSync('systemctl stop claw-subagent-service 2>/dev/null', {
        stdio: 'ignore',
        timeout: 15000,
      });
      console.log('✅ 服务已停止');
    } catch {}
    return;
  }

  console.log('🛑 正在停止并卸载 Windows 服务（释放文件锁）...');

  // 1. 停止服务
  try {
    execSync('net stop "claw-subagent-service" 2>nul', {
      stdio: 'ignore',
      timeout: 35000,
    });
    console.log('  ✅ 服务已停止');
  } catch {}

  // 2. 杀掉 wrapper 进程（node-windows 生成的 .exe）
  try {
    execSync('taskkill /f /im "claw-subagent-service.exe" 2>nul', {
      stdio: 'ignore',
      timeout: 10000,
    });
    console.log('  ✅ wrapper 进程已终止');
  } catch {}

  // 3. 杀掉相关 node 进程
  try {
    execSync(
      'powershell -NoProfile -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object {$_.Path -like \'*claw-subagent*\'} | Stop-Process -Force -ErrorAction SilentlyContinue" 2>nul',
      { stdio: 'ignore', timeout: 15000 }
    );
  } catch {}

  // 4. 通过 wmic 按命令行匹配杀掉相关 node 进程
  try {
    execSync('wmic process where "name=\'node.exe\' and commandline like \'%claw-subagent%\'" delete 2>nul', {
      stdio: 'ignore',
      timeout: 10000,
    });
    console.log('  ✅ 相关 node 进程已清理');
  } catch {}

  // 5. 从注册表删除服务（彻底释放 node-windows wrapper 的文件锁）
  try {
    execSync('sc.exe delete "claw-subagent-service" 2>nul', {
      stdio: 'ignore',
      timeout: 10000,
    });
    console.log('  ✅ 服务已从注册表删除');
  } catch {}

  // 6. 等待 Windows 回收文件句柄（关键！node-windows wrapper 需要足够时间释放）
  console.log('  ⏳ 等待系统释放文件锁（10秒）...');
  execSync('ping -n 11 127.0.0.1 >nul', { stdio: 'ignore', windowsHide: true });
}

function installAndStartService() {
  console.log('🚀 正在安装并启动服务...');
  try {
    if (isWindows) {
      execSync('claw-subagent-service --install', {
        stdio: 'inherit',
        timeout: 60000,
        windowsHide: true,
      });
    } else {
      execSync('systemctl start claw-subagent-service', {
        stdio: 'inherit',
        timeout: 15000,
      });
    }
    console.log('✅ 服务已安装/启动');
  } catch (e) {
    console.error('⚠️  服务安装/启动失败:', e.message);
    console.log('   请手动运行: claw-subagent-service --install');
  }
}

function isServiceInstalled() {
  try {
    if (isWindows) {
      execSync('sc query "claw-subagent-service" | findstr SERVICE_NAME >nul', {
        stdio: 'ignore',
        windowsHide: true,
      });
      return true;
    } else {
      execSync('systemctl is-active --quiet claw-subagent-service || systemctl is-enabled --quiet claw-subagent-service', {
        stdio: 'ignore',
      });
      return true;
    }
  } catch {
    return false;
  }
}

function copyDirSync(src, dest) {
  if (isWindows) {
    // 确保目标目录存在
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }

    // 使用 robocopy，遇到锁定的文件时跳过（/R:0 /W:0 表示不重试）
    const cmd = `robocopy "${src}" "${dest}" /E /R:0 /W:0 /NJH /NJS /NDL /NC /NS /NFL`;
    try {
      execSync(cmd, { encoding: 'utf-8', windowsHide: true });
    } catch (e) {
      // robocopy 返回码含义：
      // 0 = 成功，1 = 有文件被跳过，2 = 有额外文件，4 = 有不匹配，8 = 有错误，16 = 严重错误
      const status = e.status || 0;
      if (status === 1) {
        console.log('  ℹ️  部分文件被跳过（可能正在使用）');
      } else if (status >= 8) {
        throw new Error(`robocopy 失败 (code ${status})`);
      }
    }
  } else {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name);
      const d = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        copyDirSync(s, d);
      } else {
        fs.copyFileSync(s, d);
      }
    }
  }
}

function syncFiles(targetDir) {
  console.log(`📦 同步到: ${targetDir}\n`);

  for (const file of FILES_TO_SYNC) {
    const src = path.join(ROOT, file);
    const dest = path.join(targetDir, file);

    if (!fs.existsSync(src)) {
      console.log(`  ⚠️  跳过: ${file} (不存在)`);
      continue;
    }

    try {
      const stat = fs.statSync(src);
      if (stat.isDirectory()) {
        copyDirSync(src, dest);
      } else {
        fs.copyFileSync(src, dest);
      }
      console.log(`  ✅ ${file}`);
    } catch (e) {
      console.error(`  ❌ ${file}: ${e.message}`);
      process.exit(1);
    }
  }
}

function installDepsIfNeeded(targetDir) {
  const nodeModulesPath = path.join(targetDir, 'node_modules');
  const hasNodeModules = fs.existsSync(nodeModulesPath) && fs.readdirSync(nodeModulesPath).length > 0;

  if (hasNodeModules) {
    console.log('\n📦 依赖已存在，跳过安装');
    return;
  }

  console.log('\n📦 安装依赖...');
  try {
    execSync('npm install --ignore-scripts --prefer-offline --no-audit --no-fund --progress=false', {
      cwd: targetDir,
      stdio: 'inherit',
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 300000,
    });
    console.log('✅ 依赖安装完成');
  } catch (e) {
    console.error('⚠️  依赖安装失败，请手动运行:');
    console.error(`   cd "${targetDir}" && npm install`);
  }
}

function main() {
  console.log('🦞 claw-subagent-service - 本地同步\n');

  const targetDir = getGlobalPackageDir();
  const wasInstalled = isServiceInstalled();

  if (wasInstalled) {
    console.log('ℹ️  检测到服务已安装，先卸载以释放文件锁\n');
    stopAndUninstallService();
  }

  syncFiles(targetDir);
  installDepsIfNeeded(targetDir);

  console.log('\n✅ 同步完成!');
  console.log(`   目标目录: ${targetDir}`);

  if (wasInstalled) {
    console.log('\n🔄 正在重新安装并启动服务...');
    installAndStartService();
  } else {
    console.log('\n💡 提示:');
    console.log('   服务未安装，如需安装请运行:');
    console.log('   claw-subagent-service --install');
  }
}

main();
