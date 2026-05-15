/**
 * OpenClaw 控制模块 - 与桌面客户端对齐
 * 
 * 执行 start/stop/restart/status 命令
 * 基于 nodejs_client/src/main/openclaw-control.ts
 */
const path = require('path');
const { OpenClawCommandEnum, OpenClawServiceStatus, getServiceStatusMessage } = require('./openclaw-enum');
const { ScriptExecutor } = require('./script-executor');
const { ServiceManager } = require('./service-manager');
const { getOpenClawStatus } = require('./port-checker');

let globalExecutor = null;

function getScriptDir() {
  const system = process.platform;
  const subDir = system === 'win32' ? path.join('command', 'win') : path.join('command', 'linux');
  
  // 在 CLI 环境中，脚本在 nodejs_cli_client/command 目录下
  return path.join(__dirname, '..', '..', subDir);
}

function getExecutor() {
  if (!globalExecutor) {
    globalExecutor = new ScriptExecutor(
      getScriptDir(),
      'Success',
      180
    );
  }
  return globalExecutor;
}

function getScriptName(command) {
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

function getCommandName(command) {
  const names = {
    [OpenClawCommandEnum.START]: '启动',
    [OpenClawCommandEnum.STOP]: '停止',
    [OpenClawCommandEnum.RESTART]: '重启',
    [OpenClawCommandEnum.STATUS]: '状态检查'
  };
  return names[command] || '未知命令';
}

/**
 * 使用 ServiceManager 管理服务（systemd 模式）
 */
async function manageWithServiceManager(command) {
  const serviceMgr = new ServiceManager('openclaw-gateway', 'OpenClaw Gateway');
  
  try {
    switch (command) {
      case OpenClawCommandEnum.STOP:
        await serviceMgr.stop();
        return { status: OpenClawServiceStatus.STOP_SUCCESS, message: '服务已停止' };
      case OpenClawCommandEnum.START:
        await serviceMgr.start();
        return { status: OpenClawServiceStatus.START_SUCCESS, message: '服务已启动' };
      case OpenClawCommandEnum.RESTART:
        await serviceMgr.restart();
        return { status: OpenClawServiceStatus.RESTART_SUCCESS, message: '服务已重启' };
      case OpenClawCommandEnum.STATUS:
        const status = await serviceMgr.status();
        return { status: OpenClawServiceStatus.RUNNING, message: status };
      default:
        return { status: OpenClawServiceStatus.ERROR, message: '未知命令' };
    }
  } catch (err) {
    // ServiceManager 失败，返回 null 让上层回退到脚本方式
    console.log(`[OpenClawControl] ServiceManager 失败: ${err.message}`);
    return null;
  }
}

/**
 * 使用 ScriptExecutor 执行脚本（Docker 模式）
 */
async function executeWithScript(command) {
  const executor = getExecutor();
  const scriptName = getScriptName(command);
  
  try {
    return await executor.executeWithStatus(command, scriptName);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`[OpenClawControl] 脚本执行异常: ${msg}`);
    return {
      status: OpenClawServiceStatus.ERROR,
      message: `执行异常: ${msg}`
    };
  }
}

/**
 * 验证命令执行结果
 */
async function verifyCommandResult(command, result) {
  if (result.status === OpenClawServiceStatus.ERROR) {
    return result;
  }
  
  if (command === OpenClawCommandEnum.STOP) {
    // 等待 3 秒后验证端口
    await new Promise(resolve => setTimeout(resolve, 3000));
    const portStatus = await getOpenClawStatus(18789);
    console.log(`[OpenClawControl] 停止后端口状态: ${portStatus === 1 ? '运行中' : '未运行'}`);
    
    if (portStatus === 1) {
      return {
        status: OpenClawServiceStatus.ERROR,
        message: '停止失败: 服务仍在运行'
      };
    }
  } else if (command === OpenClawCommandEnum.START || command === OpenClawCommandEnum.RESTART) {
    // 等待服务启动
    const maxWait = command === OpenClawCommandEnum.START ? 30 : 60;
    let attempts = 0;
    let portStatus = 0;
    
    while (attempts < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      portStatus = await getOpenClawStatus(18789);
      if (portStatus === 1) break;
      attempts++;
    }
    
    console.log(`[OpenClawControl] ${getCommandName(command)}后端口状态: ${portStatus === 1 ? '运行中' : '未运行'}`);
    
    if (portStatus === 0) {
      return {
        status: OpenClawServiceStatus.ERROR,
        message: `${getCommandName(command)}失败: 服务未运行`
      };
    }
  }
  
  return result;
}

async function executeCommand(command, window, sendResponse) {
  const cmdName = getCommandName(command);
  console.log(`[OpenClawControl] ${cmdName} OpenClaw...`);

  let result;

  // 优先尝试 ServiceManager（systemd 模式）
  if (process.platform === 'linux' || process.platform === 'darwin') {
    result = await manageWithServiceManager(command);
  }
  
  // 如果 ServiceManager 失败或不是 Linux/macOS，使用脚本方式
  if (!result) {
    result = await executeWithScript(command);
  }
  
  // 验证结果
  result = await verifyCommandResult(command, result);

  // 输出日志
  if (result.status === OpenClawServiceStatus.START_SUCCESS ||
      result.status === OpenClawServiceStatus.STOP_SUCCESS ||
      result.status === OpenClawServiceStatus.RESTART_SUCCESS) {
    console.log(`[OpenClawControl] ${cmdName} 成功: ${result.message}`);
  } else if (result.status === OpenClawServiceStatus.ERROR) {
    console.log(`[OpenClawControl] ${cmdName} 失败: ${result.message}`);
  } else if (result.status === OpenClawServiceStatus.NOT_INSTALL) {
    console.log(`[OpenClawControl] ${cmdName}: OpenClaw未安装`);
  } else {
    console.log(`[OpenClawControl] ${cmdName} 状态: ${result.message}`);
  }

  if (sendResponse) {
    let httpStatus = 'success';
    if (result.status === OpenClawServiceStatus.ERROR) httpStatus = 'error';
    sendResponse({
      type: 'command_result',
      command,
      status: httpStatus,
      message: result.message,
      service_status: result.status
    });
  }

  return result;
}

module.exports = {
  executeCommand,
  getScriptName,
  getCommandName,
  getScriptDir,
  getExecutor
};