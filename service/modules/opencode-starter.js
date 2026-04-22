const { spawn, exec } = require('child_process');
const net = require('net');

async function startOpencodeService(log) {
  const checkPort = (port) => {
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
      sock.connect(port, '127.0.0.1');
    });
  };

  if (await checkPort(4096)) {
    log?.info('[OPENCODE] 服务已在运行 (port 4096)');
    return;
  }

  const checkInstalled = () => {
    return new Promise((resolve) => {
      const checkCmd = process.platform === 'win32' ? 'where opencode' : 'which opencode';
      exec(checkCmd, { timeout: 5000 }, (error) => {
        resolve(!error);
      });
    });
  };

  const isInstalled = await checkInstalled();
  if (!isInstalled) {
    log?.warn('[OPENCODE] opencode 未安装，正在自动安装...');
    
    const installResult = await new Promise((resolve) => {
      const installChild = spawn(
        'npm',
        ['install', '-g', 'opencode-ai@latest'],
        { shell: true, windowsHide: true }
      );
      
      installChild.on('close', (code) => {
        resolve(code === 0);
      });
      
      installChild.on('error', () => {
        resolve(false);
      });
    });
    
    if (!installResult) {
      log?.error('[OPENCODE] 自动安装失败');
      return;
    }
    
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  log?.info('[OPENCODE] 正在启动 opencode serve...');
  spawn('opencode', ['serve', '--port', '4096', '--hostname', '127.0.0.1'], {
    shell: true,
    windowsHide: true,
    detached: true
  });

  await new Promise(resolve => setTimeout(resolve, 10000));

  if (await checkPort(4096)) {
    log?.info('[OPENCODE] 服务启动成功');
  } else {
    log?.warn('[OPENCODE] 服务可能未启动成功');
  }
}

module.exports = {
  startOpencodeService
};
