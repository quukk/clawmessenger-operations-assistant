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
      [OpenClawCommandEnum.STATUS]: 'status',
      [OpenClawCommandEnum.CONFIG_FIX]: null  // 配置修复不需要脚本，直接执行命令
    };
    const name = names[command];
    return name ? name + ext : null;
  }

  /**
   * 执行命令
   * @param {number} command - 命令枚举值 (1=start, 2=stop, 3=restart, 4=status, 5=config_fix)
   * @returns {Object} { status, message }
   */
  async execute(command) {
    const scriptName = this.getScriptName(command);
    const commandName = this.getCommandName(command);
    
    // 配置修复命令特殊处理：直接执行 openclaw doctor --fix
    if (command === OpenClawCommandEnum.CONFIG_FIX) {
      return await this.executeConfigFix();
    }
    
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
   * 执行配置修复命令
   * 直接运行 openclaw doctor --fix
   */
  async executeConfigFix() {
    this.log?.info('[CommandHandler] 执行配置修复命令: openclaw doctor --fix');
    
    try {
      const result = await this.executor.executeCommandDirect('openclaw doctor --fix', 120); // 2分钟超时
      this.log?.info(`[CommandHandler] 配置修复结果: ${result.status} - ${result.message}`);
      return result;
    } catch (err) {
      this.log?.error(`[CommandHandler] 配置修复异常: ${err.message}`);
      return {
        status: OpenClawServiceStatus.ERROR,
        message: `配置修复异常: ${err.message}`
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
      [OpenClawCommandEnum.STATUS]: '状态检查',
      [OpenClawCommandEnum.CONFIG_FIX]: '配置修复'
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

  /**
   * 配置修复
   */
  async configFix() {
    return await this.execute(OpenClawCommandEnum.CONFIG_FIX);
  }
}

module.exports = {
  CommandHandler,
  OpenClawCommandEnum,
  OpenClawServiceStatus
};
