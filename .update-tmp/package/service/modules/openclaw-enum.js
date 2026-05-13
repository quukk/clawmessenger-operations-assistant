/**
 * OpenClaw 命令枚举和服务状态
 * 与桌面客户端对齐: nodejs_client/src/main/openclaw-enum.ts
 */
const OpenClawCommandEnum = {
  START: 1,
  STOP: 2,
  RESTART: 3,
  STATUS: 4,
  CONFIG_FIX: 5
};

const OpenClawServiceStatus = {
  RUNNING: 'running',
  NOT_RUNNING: 'not_running',
  START_SUCCESS: 'starting_success',
  STOP_SUCCESS: 'stop_success',
  RESTART_SUCCESS: 'restart_success',
  CONFIG_FIX_SUCCESS: 'config_fix_success',
  NOT_INSTALL: 'not_install',
  ERROR: 'error'
};

const statusMessages = {
  [OpenClawServiceStatus.RUNNING]: '服务运行中',
  [OpenClawServiceStatus.NOT_RUNNING]: '服务未运行',
  [OpenClawServiceStatus.START_SUCCESS]: '启动成功',
  [OpenClawServiceStatus.STOP_SUCCESS]: '关闭服务成功',
  [OpenClawServiceStatus.RESTART_SUCCESS]: '重启服务成功',
  [OpenClawServiceStatus.CONFIG_FIX_SUCCESS]: '配置修复成功',
  [OpenClawServiceStatus.ERROR]: '未知异常',
  [OpenClawServiceStatus.NOT_INSTALL]: 'openclaw未安装'
};

function getServiceStatusMessage(status) {
  return statusMessages[status] || '状态未知';
}

function isValidCommand(command) {
  return Object.values(OpenClawCommandEnum).includes(command);
}

module.exports = {
  OpenClawCommandEnum,
  OpenClawServiceStatus,
  getServiceStatusMessage,
  isValidCommand
};