const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

class OpenClawClient {
  constructor(log) {
    this.log = log;
  }

  async chat(message, fromUser) {
    if (!message || !message.trim()) {
      return '消息内容为空';
    }

    const sessionId = `rongcloud-${fromUser}-${Date.now()}`;
    const isWindows = process.platform === 'win32';
    const escapedMessage = message.replace(/"/g, '\\"');
    const cmd = isWindows
      ? `cmd /c openclaw agent -m "${escapedMessage}" --session-id ${sessionId}`
      : `openclaw agent -m "${escapedMessage}" --session-id ${sessionId}`;

    this.log?.info(`[OpenClawClient] 执行命令: ${cmd}`);

    try {
      const { stdout, stderr } = await execAsync(cmd, {
        timeout: 120000,
        maxBuffer: 1024 * 1024,
      });

      this.log?.info(`[OpenClawClient] stdout: ${stdout?.substring(0, 200) || '(empty)'}`);
      if (stderr) this.log?.error(`[OpenClawClient] stderr: ${stderr?.substring(0, 200) || '(empty)'}`);

      const output = stdout || stderr || '';
      return this.cleanOutput(output);
    } catch (err) {
      this.log?.error(`[OpenClawClient] 执行异常: ${err.message}`);
      this.log?.error(`[OpenClawClient] 错误码: ${err.code}`);
      
      if (err.killed) {
        return 'OpenClaw 响应超时';
      }
      if (err.code === 'ENOENT') {
        return '找不到 openclaw 命令';
      }
      return `OpenClaw 调用失败: ${err.message}`;
    }
  }

  cleanOutput(output) {
    const cleaned = output
      .split('\n')
      .filter(line => !line.includes('[plugins]'))
      .map(line => line.replace(/\x1B\[[0-9;]*m/g, '').trim())
      .filter(line => line.length > 0)
      .join('\n');

    return cleaned || 'OpenClaw 未返回有效响应';
  }
}

module.exports = { OpenClawClient };