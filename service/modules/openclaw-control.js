/**
 * OpenClaw 控制模块 - 与桌面客户端对齐
 * 
 * 执行 start/stop/restart/status 命令
 * 基于 nodejs_client/src/main/openclaw-control.ts
 */
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const { OpenClawCommandEnum, OpenClawServiceStatus, getServiceStatusMessage } = require('./openclaw-enum');
const { ScriptExecutor } = require('./script-executor');
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

async function executeCommand(command, window, sendResponse) {
  const cmdName = getCommandName(command);
  console.log(`[OpenClawControl] ${cmdName} OpenClaw...`);

  const executor = getExecutor();
  const scriptName = getScriptName(command);

  try {
    const result = await executor.executeWithStatus(command, scriptName);

    if (
      result.status === OpenClawServiceStatus.START_SUCCESS ||
      result.status === OpenClawServiceStatus.STOP_SUCCESS ||
      result.status === OpenClawServiceStatus.RESTART_SUCCESS
    ) {
      console.log(`[OpenClawControl] ${cmdName} 成功: ${result.message}`);
      // 延迟更新状态
      setTimeout(async () => {
        const portStatus = await getOpenClawStatus(18789);
        console.log(`[OpenClawControl] 状态已更新: ${portStatus === 1 ? '运行中' : '未运行'}`);
      }, 2000);
    } else if (result.status === OpenClawServiceStatus.ERROR) {
      console.log(`[OpenClawControl] ${cmdName} 失败: ${result.message}`);
    } else if (result.status === OpenClawServiceStatus.NOT_INSTALL) {
      console.log(`[OpenClawControl] ${cmdName}: OpenClaw未安装`);
    } else {
      console.log(`[OpenClawControl] ${cmdName} 状态: ${result.message}`);
      setTimeout(async () => {
        const portStatus = await getOpenClawStatus(18789);
        console.log(`[OpenClawControl] 状态: ${portStatus}`);
      }, 2000);
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
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`[OpenClawControl] ${cmdName} 执行异常: ${msg}`);
    if (sendResponse) {
      sendResponse({
        type: 'command_result',
        command,
        status: 'error',
        message: msg,
        service_status: OpenClawServiceStatus.ERROR
      });
    }
    return {
      status: OpenClawServiceStatus.ERROR,
      message: msg
    };
  }
}

module.exports = {
  executeCommand,
  getScriptName,
  getCommandName,
  getScriptDir,
  getExecutor
};