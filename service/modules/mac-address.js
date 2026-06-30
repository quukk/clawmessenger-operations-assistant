/**
 * MAC 地址获取模块
 *
 * 与 opencode-clawmessenger 的 mac-address.ts 保持一致，
 * 确保同一台机器在两个客户端下获取到相同的 MAC 地址，
 * 从而后端 /api/claw/register 能正确幂等返回同一个 node_id。
 */
const os = require('os');
const { execSync } = require('child_process');
const fs = require('fs');

/**
 * 验证 MAC 地址格式并统一返回 AA:BB:CC:DD:EE:FF 大写格式
 * @param {string} mac
 * @returns {string|null}
 */
function normalizeMac(mac) {
  if (!mac) return null;
  const cleaned = mac.replace(/[-:\s"]/g, '').toUpperCase();
  if (!/^[0-9A-F]{12}$/.test(cleaned)) return null;
  return cleaned.match(/.{2}/g).join(':');
}

function getMacAddress() {
  const platform = os.platform();

  try {
    if (platform === 'win32') {
      // Windows: 使用 getmac 命令，与 opencode-clawmessenger 保持一致
      const result = execSync('getmac /fo csv /nh', { encoding: 'utf8', timeout: 5000 });
      const lines = result.trim().split(/\r?\n/);
      for (const line of lines) {
        const parts = line.split(',');
        if (parts.length > 0) {
          const mac = normalizeMac(parts[0]);
          if (mac) return mac;
        }
      }
    } else if (platform === 'linux') {
      // Linux: 优先读取常见网卡文件
      const paths = [
        '/sys/class/net/eth0/address',
        '/sys/class/net/enp0s3/address',
        '/sys/class/net/eno1/address',
      ];
      for (const p of paths) {
        try {
          const mac = normalizeMac(fs.readFileSync(p, 'utf8'));
          if (mac) return mac;
        } catch {}
      }

      // 兜底：ip link show
      const result = execSync('ip link show | grep ether | head -1', { encoding: 'utf8', timeout: 5000 });
      const match = result.match(/([0-9a-fA-F]{2}[:-]){5}([0-9a-fA-F]{2})/);
      const mac = normalizeMac(match ? match[0] : null);
      if (mac) return mac;
    } else if (platform === 'darwin') {
      const result = execSync('ifconfig en0 | grep ether', { encoding: 'utf8', timeout: 5000 });
      const match = result.match(/([0-9a-fA-F]{2}[:-]){5}([0-9a-fA-F]{2})/);
      const mac = normalizeMac(match ? match[0] : null);
      if (mac) return mac;
    }
  } catch (err) {
    // ignore
  }

  // 兜底：使用 os.networkInterfaces()，但统一格式
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const mac = normalizeMac(iface.mac);
        if (mac) return mac;
      }
    }
  }

  return '00:00:00:00:00:00';
}

module.exports = { getMacAddress, normalizeMac };
