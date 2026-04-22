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
    // 使用默认 agent (main) 处理消息，不指定 --agent 参数
    const cmd = isWindows
      ? `cmd /c openclaw agent -m "${escapedMessage}" --session-id ${sessionId}`
      : `openclaw agent -m "${escapedMessage}" --session-id ${sessionId}`;

    this.log?.info(`[OpenClawClient] 执行命令: ${cmd}`);

    try {
      const { stdout, stderr } = await execAsync(cmd, {
        timeout: 1200000,
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
    const lines = output.split('\n');
    const cleanLines = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // 移除 ANSI 颜色代码
      const cleanLine = trimmed.replace(/\x1B\[[0-9;]*m/g, '');

      // 跳过所有调试/配置日志行
      if (cleanLine.startsWith('[ws]')) continue;
      if (cleanLine.startsWith('[health-monitor]')) continue;
      if (cleanLine.startsWith('[OpenClawConfig]')) continue;
      if (cleanLine.startsWith('[plugins]')) continue;
      if (cleanLine.includes('龙虾信使插件已注册')) continue;
      if (cleanLine.includes('龙虾信使')) continue;
      if (cleanLine.includes('已加载配置文件')) continue;
      if (cleanLine.includes('plugins.allow')) continue;
      if (cleanLine.includes('Config warnings')) continue;
      if (cleanLine.includes('stale config')) continue;
      if (cleanLine.includes('plugin not found')) continue;
      if (cleanLine.includes('⇄ res')) continue;
      if (cleanLine.includes('chat.history')) continue;
      if (cleanLine.includes('models.list')) continue;
      if (cleanLine.includes('node.list')) continue;
      if (/^\d{2}:\d{2}:\d{2}/.test(cleanLine)) continue; // 时间戳开头的日志

      cleanLines.push(cleanLine);
    }

    return cleanLines.join('\n').trim() || 'OpenClaw 未返回有效响应';
  }
}

module.exports = { OpenClawClient };