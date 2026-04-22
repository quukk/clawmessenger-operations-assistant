/**
 * 命令处理器 - 处理 start/stop/status/restart 命令
 * 
 * 使用 script-executor.js 执行实际的脚本文件
 */
const { ScriptExecutor, OpenClawCommandEnum, OpenClawServiceStatus } = require('./script-executor');
const path = require('path');

class CommandHandler {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    
    // 初始化脚本执行器
    const scriptDir = this.getScriptDir();
    this.executor = new ScriptExecutor(
      scriptDir,
      config.successKeyword || 'Success',
      config.scriptTimeout || 180
    );
  }

  /**
   * 获取脚本目录
   */
  getScriptDir() {
    const system = process.platform;
    const subDir = system === 'win32' ? path.join('command', 'win') : path.join('command', 'linux');
    return path.join(__dirname, '..', '..', subDir);
  }

  /**
   * 获取脚本文件名
   */
  getScriptName(command) {
    const system = process.platform;
    const ext = system === 'win32' ? '.bat' : '.sh';
    const names = {
      [OpenClawCommandEnum.START]: 'start',
      [OpenClawCommandEnum.STOP]: 'stop',
      [OpenClawCommandEnum.RESTART]: 'restart',
      [OpenClawCommandEnum.STATUS]: 'status'
    };
    return (names[command] || 'unknown') + ext;
  }

  /**
   * 执行命令
   * @param {number} command - 命令枚举值 (1=start, 2=stop, 3=restart, 4=status)
   * @returns {Object} { status, message }
   */
  async execute(command) {
    const scriptName = this.getScriptName(command);
    const commandName = this.getCommandName(command);
    
    this.log?.info(`[CommandHandler] 执行 ${commandName} 命令，脚本: ${scriptName}`);
    
    try {
      const result = await this.executor.executeWithStatus(command, scriptName);
      this.log?.info(`[CommandHandler] ${commandName} 结果: ${result.status} - ${result.message}`);
      return result;
    } catch (err) {
      this.log?.error(`[CommandHandler] ${commandName} 异常: ${err.message}`);
      return {
        status: OpenClawServiceStatus.ERROR,
        message: `执行异常: ${err.message}`
      };
    }
  }

  /**
   * 获取命令名称
   */
  getCommandName(command) {
    const names = {
      [OpenClawCommandEnum.START]: '启动',
      [OpenClawCommandEnum.STOP]: '停止',
      [OpenClawCommandEnum.RESTART]: '重启',
      [OpenClawCommandEnum.STATUS]: '状态检查'
    };
    return names[command] || '未知命令';
  }

  /**
   * 启动服务
   */
  async start() {
    return await this.execute(OpenClawCommandEnum.START);
  }

  /**
   * 停止服务
   */
  async stop() {
    return await this.execute(OpenClawCommandEnum.STOP);
  }

  /**
   * 重启服务
   */
  async restart() {
    return await this.execute(OpenClawCommandEnum.RESTART);
  }

  /**
   * 检查状态
   */
  async status() {
    return await this.execute(OpenClawCommandEnum.STATUS);
  }
}

module.exports = {
  CommandHandler,
  OpenClawCommandEnum,
  OpenClawServiceStatus
};
