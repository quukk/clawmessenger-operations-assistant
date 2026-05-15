const net = require('net');
const os = require('os');
const { execSync } = require('child_process');

function checkPortListening(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(5000);
    
    console.log(`[PortChecker] 尝试连接 ${host}:${port}`);
    
    sock.once('connect', () => {
      console.log(`[PortChecker] 成功连接到 ${host}:${port}`);
      sock.destroy();
      resolve(true);
    });
    
    sock.once('error', (err) => {
      console.log(`[PortChecker] 连接 ${host}:${port} 失败: ${err.code} - ${err.message}`);
      sock.destroy();
      resolve(false);
    });
    
    sock.once('timeout', () => {
      console.log(`[PortChecker] 连接 ${host}:${port} 超时`);
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

/**
 * 通过系统命令检查端口是否监听（备选方法）
 * 当 net.Socket 连接失败时使用
 */
function checkPortViaSystemCommand(port) {
  try {
    // 按优先级尝试多种工具
    const commands = [
      `ss -tlnp 2>/dev/null | grep -q ":${port} " && echo "found"`,
      `netstat -tlnp 2>/dev/null | grep -q ":${port} " && echo "found"`,
      `lsof -i :${port} 2>/dev/null | grep -q LISTEN && echo "found"`,
      `fuser ${port}/tcp 2>/dev/null | grep -q '[0-9]' && echo "found"`
    ];
    
    for (const cmd of commands) {
      try {
        const result = execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim();
        if (result === 'found') {
          console.log(`[PortChecker] 系统命令检测到端口 ${port} 正在监听`);
          return true;
        }
      } catch (e) {
        // 命令失败，尝试下一个
      }
    }
  } catch (e) {
    console.error(`[PortChecker] 系统命令检查端口失败: ${e.message}`);
  }
  return false;
}

/**
 * 检查 openclaw 进程是否存在
 */
function checkProcessExists() {
  try {
    // 尝试多种方法检查进程
    const commands = [
      'ps aux | grep -v grep | grep openclaw',
      'pgrep -f openclaw',
      'pidof openclaw'
    ];
    
    for (const cmd of commands) {
      try {
        const output = execSync(cmd, { 
          encoding: 'utf8', 
          timeout: 5000 
        }).trim();
        
        if (output) {
          console.log(`[PortChecker] 检测到 openclaw 进程存在 (通过: ${cmd.split(' ')[0]})`);
          console.log(`[PortChecker] 进程信息: ${output.split('\n')[0]}`);
          return true;
        }
      } catch (e) {
        // 命令失败，尝试下一个
      }
    }
    
    console.log(`[PortChecker] 未检测到 openclaw 进程`);
  } catch (e) {
    console.error(`[PortChecker] 进程检查失败: ${e.message}`);
  }
  return false;
}

async function getOpenClawStatus(port = 18789) {
  // 方法1: 通过 net.Socket 检查端口
  const isListening = await checkPortOnAllInterfaces(port);
  if (isListening) {
    console.log(`[PortChecker] 端口 ${port} 检测为运行中（net.Socket）`);
    return 1;
  }
  
  // 方法2: 通过系统命令检查端口
  const isListeningViaCmd = checkPortViaSystemCommand(port);
  if (isListeningViaCmd) {
    console.log(`[PortChecker] 端口 ${port} 检测为运行中（系统命令）`);
    return 1;
  }
  
  // 方法3: 检查进程是否存在（备选）
  const processExists = checkProcessExists();
  if (processExists) {
    console.warn(`[PortChecker] 警告: openclaw 进程存在，但端口 ${port} 未监听。可能绑定到其他端口或地址。`);
    // 进程存在但端口未监听，返回特殊状态 2
    return 2;
  }
  
  console.log(`[PortChecker] 端口 ${port} 检测为未运行`);
  return 0;
}

module.exports = {
  checkPortListening,
  checkPortOnAllInterfaces,
  getOpenClawStatus,
};
