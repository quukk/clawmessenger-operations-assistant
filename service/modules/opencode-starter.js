/**
 * OpenClaw 服务启动器 - 与桌面客户端对齐
 * 
 * 桌面客户端启动流程：
 * 1. 检查端口 4096 是否已被占用
 * 2. 如果未占用，检查 opencode 是否已安装
 * 3. 如果未安装，自动安装 opencode-ai
 * 4. 启动 opencode serve --port 4096
 * 
 * 参考: nodejs_client/src/main/rongyun-client.ts startOpencodeService()
 */
const net = require('net');
const { spawn, exec } = require('child_process');

/**
 * 检查端口是否可用
 */
function checkPort(port = 4096, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(3000);
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => {
      sock.destroy();
      resolve(false);
    });
    sock.once('timeout', () => {
      sock.destroy();
      resolve(false);
    });
    sock.connect(port, host);
  });
}

/**
 * 检查 opencode 是否已安装
 */
function checkOpencodeInstalled() {
  return new Promise((resolve) => {
    const checkCmd = process.platform === 'win32' ? 'where opencode' : 'which opencode';
    exec(checkCmd, { timeout: 5000 }, (error) => {
      resolve(!error);
    });
  });
}

/**
 * 安装 opencode
 */
function installOpencode(log) {
  return new Promise((resolve) => {
    log?.info('[OPENCODE] 执行: npm install -g opencode-ai@latest');
    
    const installChild = spawn(
      'npm',
      ['install', '-g', 'opencode-ai@latest'],
      { shell: true, windowsHide: true }
    );
    
    let installOutput = '';
    let installError = '';
    
    installChild.stdout?.on('data', (data) => {
      installOutput += data.toString();
    });
    
    installChild.stderr?.on('data', (data) => {
      installError += data.toString();
    });
    
    installChild.on('close', (code) => {
      if (code === 0) {
        log?.info('[OPENCODE] opencode 安装成功');
        resolve(true);
      } else {
        log?.error(`[OPENCODE] 安装失败，退出码: ${code}`);
        if (installError) {
          log?.error(`[OPENCODE] 安装错误: ${installError.substring(0, 500)}`);
        }
        resolve(false);
      }
    });
    
    installChild.on('error', (err) => {
      log?.error(`[OPENCODE] 安装进程错误: ${err.message}`);
      resolve(false);
    });
  });
}

/**
 * 启动 opencode 服务
 */
function startOpencodeProcess(log) {
  return new Promise((resolve) => {
    log?.info('[OPENCODE] 正在启动 opencode serve...');
    
    const child = spawn(
      'opencode',
      ['serve', '--port', '4096', '--hostname', '127.0.0.1'],
      { shell: true, windowsHide: true }
    );
    
    // 保存进程引用，以便后续关闭
    global.opencodeProcess = child;
    
    child.stdout?.on('data', (data) => {
      log?.info(`[OPENCODE-OUT] ${data.toString().trim()}`);
    });
    
    child.stderr?.on('data', (data) => {
      log?.error(`[OPENCODE-ERR] ${data.toString().trim()}`);
    });
    
    child.on('close', (code) => {
      log?.warn(`[OPENCODE] 服务进程退出，退出码: ${code}`);
      global.opencodeProcess = null;
    });
    
    child.on('error', (err) => {
      log?.error(`[OPENCODE] 服务进程错误: ${err.message}`);
    });
    
    // 等待 10 秒让服务启动
    setTimeout(() => {
      resolve();
    }, 10000);
  });
}

/**
 * 启动 OpenClaw 服务
 * 与桌面客户端对齐
 */
async function startOpencodeService(log) {
  // 检查端口是否已被占用
  if (await checkPort(4096)) {
    log?.info('[OPENCODE] 服务已在运行 (port 4096)');
    return true;
  }

  // 检查 opencode 是否已安装
  const isInstalled = await checkOpencodeInstalled();
  if (!isInstalled) {
    log?.warn('[OPENCODE] opencode 未安装，正在自动安装...');
    
    const installResult = await installOpencode(log);
    if (!installResult) {
      log?.error('[OPENCODE] 自动安装失败，请手动运行: npm install -g opencode-ai@latest');
      return false;
    }
    
    // 安装成功后等待 5 秒
    log?.info('[OPENCODE] 等待 5 秒让安装生效...');
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  // 启动服务
  await startOpencodeProcess(log);
  
  // 再次检查端口
  if (await checkPort(4096)) {
    log?.info('[OPENCODE] 服务启动成功');
    return true;
  } else {
    log?.warn('[OPENCODE] 服务可能未启动成功，请手动检查');
    return false;
  }
}

/**
 * 停止 OpenClaw 服务
 */
function stopOpencodeService(log) {
  if (global.opencodeProcess) {
    log?.info('[OPENCODE] 正在停止服务...');
    try {
      global.opencodeProcess.kill();
      global.opencodeProcess = null;
      log?.info('[OPENCODE] 服务已停止');
    } catch (err) {
      log?.error(`[OPENCODE] 停止服务失败: ${err.message}`);
    }
  }
}

module.exports = {
  startOpencodeService,
  stopOpencodeService,
  checkPort
};