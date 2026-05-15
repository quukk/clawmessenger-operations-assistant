const net = require('net');
const os = require('os');

function checkPortListening(port, host = '127.0.0.1') {
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
 * 检查端口是否在所有网络接口上监听
 * Docker 环境中，服务可能绑定到 0.0.0.0 而不是 127.0.0.1
 */
async function checkPortOnAllInterfaces(port) {
  // 先检查 localhost
  const localhostListening = await checkPortListening(port, '127.0.0.1');
  if (localhostListening) return true;

  // 再检查 0.0.0.0（所有接口）
  const allInterfacesListening = await checkPortListening(port, '0.0.0.0');
  if (allInterfacesListening) return true;

  // 获取所有网络接口并逐一检查
  const interfaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        const listening = await checkPortListening(port, addr.address);
        if (listening) {
          console.log(`[PortChecker] 端口 ${port} 在 ${addr.address} (${name}) 上监听`);
          return true;
        }
      }
    }
  }

  return false;
}

async function getOpenClawStatus(port = 18789) {
  const isListening = await checkPortOnAllInterfaces(port);
  return isListening ? 1 : 0;
}

module.exports = {
  checkPortListening,
  checkPortOnAllInterfaces,
  getOpenClawStatus,
};
