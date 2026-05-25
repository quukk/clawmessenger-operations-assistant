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
    [OpenClawCommandEnum.STATUS]: 'status',
    [OpenClawCommandEnum.CONFIG_FIX]: null  // 配置修复不需要脚本
  };
  const name = names[command];
  return name ? name + ext : null;
}

function getCommandName(command) {
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
      case OpenClawCommandEnum.CONFIG_FIX:
        // 配置修复不通过 ServiceManager，回退到脚本方式
        return null;
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
 * @returns {Object} { result, output }
 */
async function executeWithScript(command) {
  const executor = getExecutor();
  const scriptName = getScriptName(command);
  
  try {
    const result = await executor.executeWithStatus(command, scriptName);
    // ScriptExecutor 现在返回 { status, message, output }
    return { 
      result: { status: result.status, message: result.message },
      output: result.output || ''
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`[OpenClawControl] 脚本执行异常: ${msg}`);
    return {
      result: {
        status: OpenClawServiceStatus.ERROR,
        message: `执行异常: ${msg}`
      },
      output: ''
    };
  }
}

/**
 * 验证命令执行结果
 * 
 * 注意：在 Docker 环境中，端口检查可能不可靠（服务可能绑定到特定网络接口）
 * 因此，如果脚本输出明确指示成功，但端口检查失败，会给出警告但保留脚本结果
 */
async function verifyCommandResult(command, result, scriptOutput = '') {
  if (result.status === OpenClawServiceStatus.ERROR) {
    return result;
  }
  
  const outputUpper = (scriptOutput || '').toUpperCase();
  
  // 配置修复命令不需要端口验证
  if (command === OpenClawCommandEnum.CONFIG_FIX) {
    return result;
  }
  
  if (command === OpenClawCommandEnum.STOP) {
    // 停止命令验证：快速检查端口状态
    console.log(`[OpenClawControl] 开始验证停止结果...`);

    // 等待 2 秒后检查
    await new Promise(resolve => setTimeout(resolve, 2000));
    const portStatus = await getOpenClawStatus(18789);
    console.log(`[OpenClawControl] 停止后端口状态: ${portStatus}`);

    if (portStatus !== 1) {
      console.log(`[OpenClawControl] 停止验证通过: 端口已关闭`);
    } else {
      console.error(`[OpenClawControl] 停止失败: 端口 18789 仍在监听。`);
      return {
        status: OpenClawServiceStatus.ERROR,
        message: '停止失败: 服务仍在运行'
      };
    }
  } else if (command === OpenClawCommandEnum.START || command === OpenClawCommandEnum.RESTART) {
    // 等待服务启动（最多等待 30 秒）
    const maxWait = 15; // 最多 15 次检查
    let attempts = 0;
    let portStatus = 0;
    
    while (attempts < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      portStatus = await getOpenClawStatus(18789);
      if (portStatus === 1) break; // 端口监听算成功
      attempts++;
    }
    
    console.log(`[OpenClawControl] ${getCommandName(command)}后端口状态: ${portStatus}`);
    
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
  let scriptOutput = '';
  if (!result) {
    const scriptResult = await executeWithScript(command);
    result = scriptResult.result;
    scriptOutput = scriptResult.output;
  }
  
  // 验证结果（传递脚本输出用于后备检查）
  result = await verifyCommandResult(command, result, scriptOutput);

  // 输出日志
  if (result.status === OpenClawServiceStatus.START_SUCCESS ||
      result.status === OpenClawServiceStatus.STOP_SUCCESS ||
      result.status === OpenClawServiceStatus.RESTART_SUCCESS ||
      result.status === OpenClawServiceStatus.CONFIG_FIX_SUCCESS) {
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
    
    // 获取操作后的真实状态
    let realStatus = result.status;
    if (command === OpenClawCommandEnum.STOP || command === OpenClawCommandEnum.START || command === OpenClawCommandEnum.RESTART) {
      try {
        const { getOpenClawStatus } = require('./port-checker');
        const portStatus = await getOpenClawStatus(18789);
        // 更新真实状态
        if (command === OpenClawCommandEnum.STOP) {
          realStatus = portStatus === 1 ? OpenClawServiceStatus.RUNNING : OpenClawServiceStatus.STOP_SUCCESS;
        } else if (command === OpenClawCommandEnum.START) {
          realStatus = portStatus === 1 ? OpenClawServiceStatus.START_SUCCESS : OpenClawServiceStatus.ERROR;
        } else if (command === OpenClawCommandEnum.RESTART) {
          realStatus = portStatus === 1 ? OpenClawServiceStatus.RESTART_SUCCESS : OpenClawServiceStatus.ERROR;
        }
        console.log(`[OpenClawControl] 操作后真实状态检测: portStatus=${portStatus}, realStatus=${realStatus}`);
      } catch (e) {
        console.error(`[OpenClawControl] 真实状态检测失败: ${e.message}`);
      }
    }
    
    sendResponse({
      type: 'command_result',
      command,
      status: httpStatus,
      message: result.message,
      service_status: realStatus
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