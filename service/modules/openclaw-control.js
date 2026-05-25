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
 * 检测是否在 Docker 环境（无 systemd）
 */
function isDockerEnvironment() {
  try {
    const fs = require('fs');
    // 检查 /proc/1/cgroup 是否包含 docker
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
    return cgroup.includes('docker');
  } catch (e) {
    return false;
  }
}

/**
 * 使用 ServiceManager 管理服务（systemd 模式）
 * 注意：在 Docker 环境中不应该使用 ServiceManager，因为 Docker 通常没有 systemd
 */
async function manageWithServiceManager(command) {
  // 如果在 Docker 环境中，直接返回 null，让上层回退到脚本方式
  if (isDockerEnvironment()) {
    console.log('[OpenClawControl] 检测到 Docker 环境，跳过 ServiceManager，使用脚本方式');
    return null;
  }
  
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
  console.log(`[OpenClawControl] ====== 开始执行 ${cmdName} 命令 ======`);
  console.log(`[OpenClawControl] 命令代码: ${command}`);
  console.log(`[OpenClawControl] 平台: ${process.platform}`);

  let result;

  // 优先尝试 ServiceManager（systemd 模式）
  if (process.platform === 'linux' || process.platform === 'darwin') {
    console.log(`[OpenClawControl] 尝试使用 ServiceManager...`);
    result = await manageWithServiceManager(command);
    if (result) {
      console.log(`[OpenClawControl] ServiceManager 结果: ${result.status} - ${result.message}`);
    } else {
      console.log(`[OpenClawControl] ServiceManager 不可用，回退到脚本方式`);
    }
  }
  
  // 如果 ServiceManager 失败或不是 Linux/macOS，使用脚本方式
  let scriptOutput = '';
  if (!result) {
    console.log(`[OpenClawControl] 使用脚本方式执行...`);
    const scriptResult = await executeWithScript(command);
    result = scriptResult.result;
    scriptOutput = scriptResult.output;
    console.log(`[OpenClawControl] 脚本执行结果: ${result.status} - ${result.message}`);
    if (scriptOutput) {
      console.log(`[OpenClawControl] 脚本输出长度: ${scriptOutput.length}`);
    }
  }
  
  // 验证结果（传递脚本输出用于后备检查）
  console.log(`[OpenClawControl] 开始验证命令结果...`);
  result = await verifyCommandResult(command, result, scriptOutput);
  console.log(`[OpenClawControl] 验证后结果: ${result.status} - ${result.message}`);

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
    let realMessage = result.message;
    if (command === OpenClawCommandEnum.STOP || command === OpenClawCommandEnum.START || command === OpenClawCommandEnum.RESTART) {
      try {
        console.log(`[OpenClawControl] 检测操作后的真实状态...`);
        const { getOpenClawStatus } = require('./port-checker');
        const portStatus = await getOpenClawStatus(18789);
        console.log(`[OpenClawControl] 端口状态: ${portStatus}`);
        // 更新真实状态
        if (command === OpenClawCommandEnum.STOP) {
          realStatus = portStatus === 1 ? OpenClawServiceStatus.RUNNING : OpenClawServiceStatus.STOP_SUCCESS;
          realMessage = portStatus === 1 ? '停止失败: 服务仍在运行' : '服务已停止';
        } else if (command === OpenClawCommandEnum.START) {
          realStatus = portStatus === 1 ? OpenClawServiceStatus.START_SUCCESS : OpenClawServiceStatus.ERROR;
          realMessage = portStatus === 1 ? '服务已启动' : '启动失败: 服务未运行';
        } else if (command === OpenClawCommandEnum.RESTART) {
          realStatus = portStatus === 1 ? OpenClawServiceStatus.RESTART_SUCCESS : OpenClawServiceStatus.ERROR;
          realMessage = portStatus === 1 ? '服务已重启' : '重启失败: 服务未运行';
        }
        console.log(`[OpenClawControl] 操作后真实状态: portStatus=${portStatus}, realStatus=${realStatus}, message=${realMessage}`);
      } catch (e) {
        console.error(`[OpenClawControl] 真实状态检测失败: ${e.message}`);
      }
    }
    
    console.log(`[OpenClawControl] 发送响应: status=${httpStatus}, message=${realMessage}`);
    sendResponse({
      type: 'command_result',
      command,
      status: httpStatus,
      message: realMessage,
      service_status: realStatus
    });
  }

  console.log(`[OpenClawControl] ====== ${cmdName} 命令执行完成 ======`);
  return result;
}

module.exports = {
  executeCommand,
  getScriptName,
  getCommandName,
  getScriptDir,
  getExecutor
};