const { spawn } = require('child_process');
const path = require('path');

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

function commandFromScript(scriptPath) {
  const base = scriptPath.toLowerCase();
  // 注意顺序：restart 必须排在 start 前面，因为 restart 包含 start
  if (base.includes('restart')) return OpenClawCommandEnum.RESTART;
  if (base.includes('start')) return OpenClawCommandEnum.START;
  if (base.includes('stop')) return OpenClawCommandEnum.STOP;
  if (base.includes('status')) return OpenClawCommandEnum.STATUS;
  return null;
}

class ScriptExecutor {
  constructor(scriptDir, successKeyword = 'Success', timeout = 180) {
    const currentDir = __dirname;
    const system = process.platform;
    if (scriptDir) {
      this.scriptDir = scriptDir;
    } else if (system === 'win32') {
      this.scriptDir = path.join(currentDir, '..', '..', 'command', 'win');
    } else {
      this.scriptDir = path.join(currentDir, '..', '..', 'command', 'linux');
    }
    this.successKeyword = successKeyword;
    this.timeout = timeout;
  }

  async execute(scriptName) {
    const scriptPath = path.join(this.scriptDir, scriptName);

    try {
      const { stdout, stderr } = await this.runScript(scriptPath);
      const fullOutput = stdout + stderr;
      if (fullOutput.includes(this.successKeyword)) {
        return { success: true, message: '执行成功' };
      }
      return {
        success: false,
        message: `执行失败（未找到成功标识 '${this.successKeyword}'）${stderr ? '\n错误输出: ' + stderr.slice(0, 200) : ''}`
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, message: `执行异常: ${msg}` };
    }
  }

  async executeWithStatus(command, scriptName) {
    // 配置修复命令特殊处理：直接执行命令，不需要脚本
    if (command === OpenClawCommandEnum.CONFIG_FIX) {
      return await this.executeCommandDirect('openclaw doctor --fix', 120);
    }

    const scriptPath = path.join(this.scriptDir, scriptName);

    try {
      const { stdout, stderr } = await this.runScript(scriptPath);
      const fullOutput = stdout + stderr;
      return this.parseStatus(command, fullOutput);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { status: OpenClawServiceStatus.ERROR, message: `执行异常: ${msg}` };
    }
  }

  /**
   * 直接执行命令（不通过脚本）
   * @param {string} command - 要执行的命令
   * @param {number} timeout - 超时时间（秒）
   * @returns {Object} { status, message }
   */
  async executeCommandDirect(command, timeout = 180) {
    return new Promise((resolve, reject) => {
      const system = process.platform;
      let cmd;
      let args;

      if (system === 'win32') {
        cmd = 'cmd';
        args = ['/c', command];
      } else {
        cmd = 'bash';
        args = ['-c', command];
      }

      const child = spawn(cmd, args, {
        detached: false,
        windowsHide: true
      });

      let stdout = '';
      let stderr = '';
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        this.killProcessTree(child);
        resolve({
          status: OpenClawServiceStatus.ERROR,
          message: `执行超时（超过 ${timeout} 秒）`
        });
      }, timeout * 1000);

      child.stdout?.on('data', (data) => {
        const text = data.toString('utf-8');
        stdout += text;
      });

      child.stderr?.on('data', (data) => {
        const text = data.toString('utf-8');
        stderr += text;
      });

      child.on('error', (err) => {
        if (!killed) {
          killed = true;
          clearTimeout(timer);
          resolve({
            status: OpenClawServiceStatus.ERROR,
            message: `执行异常: ${err.message}`
          });
        }
      });

      child.on('close', (code) => {
        if (!killed) {
          killed = true;
          clearTimeout(timer);
          const fullOutput = stdout + stderr;
          // 对于配置修复命令，解析输出结果
          if (command.includes('doctor')) {
            const result = this.parseStatus(OpenClawCommandEnum.CONFIG_FIX, fullOutput);
            resolve(result);
          } else {
            resolve({
              status: code === 0 ? OpenClawServiceStatus.CONFIG_FIX_SUCCESS : OpenClawServiceStatus.ERROR,
              message: code === 0 ? '执行成功' : `执行失败（退出码: ${code}）`
            });
          }
        }
      });
    });
  }

  runScript(scriptPath) {
    return new Promise((resolve, reject) => {
      const system = process.platform;
      let cmd;
      let args;

      if (system === 'win32') {
        cmd = 'cmd';
        args = ['/c', scriptPath];
      } else {
        cmd = 'bash';
        args = [scriptPath];
      }

      const child = spawn(cmd, args, {
        detached: false,
        windowsHide: true
      });

      let stdout = '';
      let stderr = '';
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        this.killProcessTree(child);
        reject(new Error(`执行超时（超过 ${this.timeout} 秒）`));
      }, this.timeout * 1000);

      child.stdout?.on('data', (data) => {
        const text = data.toString('utf-8');
        stdout += text;
        if (this.shouldReturnEarly(commandFromScript(scriptPath), stdout + stderr)) {
          if (!killed) {
            killed = true;
            clearTimeout(timer);
            this.killProcessTree(child);
            resolve({ stdout, stderr });
          }
        }
      });

      child.stderr?.on('data', (data) => {
        const text = data.toString('utf-8');
        stderr += text;
        if (this.shouldReturnEarly(commandFromScript(scriptPath), stdout + stderr)) {
          if (!killed) {
            killed = true;
            clearTimeout(timer);
            this.killProcessTree(child);
            resolve({ stdout, stderr });
          }
        }
      });

      child.on('error', (err) => {
        if (!killed) {
          killed = true;
          clearTimeout(timer);
          reject(err);
        }
      });

      child.on('close', () => {
        if (!killed) {
          killed = true;
          clearTimeout(timer);
          resolve({ stdout, stderr });
        }
      });
    });
  }

  shouldReturnEarly(command, output) {
    const upper = output.toUpperCase();

    // 只检查错误关键字，错误时立即返回
    const errorKeywords = ['[ERROR]', '错误', 'FAILED', '失败', '[错误]'];
    for (const kw of errorKeywords) {
      if (upper.includes(kw.toUpperCase())) return true;
    }

    // 对于 START 命令，不提前返回，让脚本完整执行
    // 因为 start.bat 有等待循环，需要完整输出才能判断状态
    if (command === OpenClawCommandEnum.START) {
      return false;
    }

    let successKeywords;
    if (command === OpenClawCommandEnum.RESTART) {
      successKeywords = [
        '[OK] RESTART COMPLETED SUCCESSFULLY',
        'RESTART COMPLETED SUCCESSFULLY',
        '[OK] RESTART COMPLETED',
        'RESTART COMPLETED',
        '重启完成'
      ];
    } else {
      successKeywords = [
        '[OK] RESTART COMPLETED SUCCESSFULLY',
        'RESTART COMPLETED SUCCESSFULLY',
        '[OK] RESTART COMPLETED',
        'RESTART COMPLETED',
        '重启完成',
        '[OK] SERVICE IS RUNNING',
        '[OK] SERVICE STOPPED',
        'STOPPED SUCCESSFULLY',
        '服务停止成功',
        '服务已停止',
        'GATEWAY STOP SIGNAL SENT',
        'STOP SIGNAL SENT'
      ];
    }

    for (const kw of successKeywords) {
      if (upper.includes(kw.toUpperCase())) return true;
    }

    return false;
  }

  parseStatus(command, output) {
    const upper = output.toUpperCase();

    if (
      upper.includes('OPENCLAW COMMAND NOT FOUND') ||
      output.includes('服务 openclaw-gateway.service 未安装') ||
      output.includes('服务 openclaw-gateway.service 不存在') ||
      upper.includes('OPENCLAW-GATEWAY.SERVICE 不存在')
    ) {
      return {
        status: OpenClawServiceStatus.NOT_INSTALL,
        message: getServiceStatusMessage(OpenClawServiceStatus.NOT_INSTALL)
      };
    }

    if (command === OpenClawCommandEnum.STATUS) {
      if (
        upper.includes('[INFO] STATUS: RUNNING') ||
        upper.includes('[OK] SERVICE IS RUNNING') ||
        (upper.includes('ACTIVE: ACTIVE (RUNNING)') && upper.includes('SUCCESS')) ||
        (upper.includes('LISTENING') && output.includes(':18789'))
      ) {
        return {
          status: OpenClawServiceStatus.RUNNING,
          message: getServiceStatusMessage(OpenClawServiceStatus.RUNNING)
        };
      }
      if (
        upper.includes('[INFO] STATUS: NOT RUNNING') ||
        upper.includes('[INFO] OPENCLAW IS NOT RUNNING') ||
        upper.includes('ACTIVE: INACTIVE (DEAD)') ||
        upper.includes('ACTIVE: FAILED') ||
        output.includes('[INFO] 未启动')
      ) {
        return {
          status: OpenClawServiceStatus.NOT_RUNNING,
          message: getServiceStatusMessage(OpenClawServiceStatus.NOT_RUNNING)
        };
      }
      return {
        status: OpenClawServiceStatus.NOT_RUNNING,
        message: getServiceStatusMessage(OpenClawServiceStatus.NOT_RUNNING)
      };
    }

    if (command === OpenClawCommandEnum.START) {
      // 优先检查错误
      if (upper.includes('[ERROR]') || output.includes('[错误]')) {
        return { status: OpenClawServiceStatus.ERROR, message: '启动失败' };
      }
      // 检查成功标识：包含 SUCCESS 或 ALREADY RUNNING 即为成功
      if (upper.includes('SUCCESS') || upper.includes('ALREADY RUNNING') || output.includes('服务已经在运行中')) {
        return {
          status: OpenClawServiceStatus.START_SUCCESS,
          message: getServiceStatusMessage(OpenClawServiceStatus.START_SUCCESS)
        };
      }
      // 如果既没有错误也没有成功标识，返回未知（但通常不会发生）
      return { status: OpenClawServiceStatus.ERROR, message: '启动结果未知' };
    }

    if (command === OpenClawCommandEnum.STOP) {
      if (
        upper.includes('NOT RUNNING') ||
        upper.includes('IS NOT RUNNING') ||
        output.includes('[INFO] 未启动') ||
        upper.includes('OPENCLAW IS NOT RUNNING') ||
        output.includes('服务未运行')
      ) {
        return {
          status: OpenClawServiceStatus.NOT_RUNNING,
          message: '服务已经停止'
        };
      }
      if (
        upper.includes('SUCCESS') ||
        upper.includes('STOPPED') ||
        upper.includes('[OK] STOP COMMAND EXECUTED') ||
        upper.includes('[OK] SERVICE STOPPED') ||
        (output.includes('[INFO] OPENCLAW 服务停止成功') && output.includes('[INFO] 服务已成功停止')) ||
        upper.includes('GATEWAY STOP SIGNAL SENT') ||
        (upper.includes('[INFO] STOPPING SERVICE') && upper.includes('STOP SIGNAL'))
      ) {
        if (
          upper.includes('NOT RUNNING') ||
          upper.includes('ALREADY STOPPED') ||
          output.includes('服务已经停止')
        ) {
          return {
            status: OpenClawServiceStatus.NOT_RUNNING,
            message: '服务已经停止'
          };
        }
        return {
          status: OpenClawServiceStatus.STOP_SUCCESS,
          message: getServiceStatusMessage(OpenClawServiceStatus.STOP_SUCCESS)
        };
      }
      if (
        (upper.includes('[OK]') || upper.includes('[INFO] STOPPING SERVICE')) &&
        !upper.includes('[ERROR]')
      ) {
        return {
          status: OpenClawServiceStatus.STOP_SUCCESS,
          message: getServiceStatusMessage(OpenClawServiceStatus.STOP_SUCCESS)
        };
      }
      return { status: OpenClawServiceStatus.ERROR, message: '停止失败' };
    }

    if (command === OpenClawCommandEnum.RESTART) {
      if (
        upper.includes('[OK] RESTART COMPLETED SUCCESSFULLY') ||
        upper.includes('RESTART COMPLETED SUCCESSFULLY') ||
        output.includes('[INFO] OPENCLAW 服务已完全重启')
      ) {
        return {
          status: OpenClawServiceStatus.RESTART_SUCCESS,
          message: getServiceStatusMessage(OpenClawServiceStatus.RESTART_SUCCESS)
        };
      }
      if (
        (upper.includes('SUCCESS') && upper.includes('RUNNING')) ||
        (upper.includes('[OK] SERVICE IS RUNNING') && upper.includes('SUCCESS'))
      ) {
        const successCount = upper.split('SUCCESS').length - 1;
        if (successCount >= 2 || upper.includes('RESTART')) {
          return {
            status: OpenClawServiceStatus.RESTART_SUCCESS,
            message: getServiceStatusMessage(OpenClawServiceStatus.RESTART_SUCCESS)
          };
        }
      }
      if (upper.includes('[OK] RESTART COMPLETED') || upper.includes('RESTART COMPLETED')) {
        return {
          status: OpenClawServiceStatus.RESTART_SUCCESS,
          message: getServiceStatusMessage(OpenClawServiceStatus.RESTART_SUCCESS)
        };
      }
      if (upper.includes('[ERROR]')) {
        return { status: OpenClawServiceStatus.ERROR, message: '重启失败' };
      }
      if (output.includes('端口 18789 已就绪') || upper.includes('PORT 18789')) {
        return {
          status: OpenClawServiceStatus.RESTART_SUCCESS,
          message: getServiceStatusMessage(OpenClawServiceStatus.RESTART_SUCCESS)
        };
      }
      const successCount = upper.split('SUCCESS').length - 1;
      if (successCount >= 2 && !upper.includes('[ERROR]')) {
        return {
          status: OpenClawServiceStatus.RESTART_SUCCESS,
          message: getServiceStatusMessage(OpenClawServiceStatus.RESTART_SUCCESS)
        };
      }
      return { status: OpenClawServiceStatus.ERROR, message: '重启失败' };
    }

    if (command === OpenClawCommandEnum.CONFIG_FIX) {
      // 配置修复命令解析
      if (
        upper.includes('DOCTOR COMPLETE') ||
        upper.includes('CONFIG WAS LAST WRITTEN') ||
        upper.includes('RESTARTED SCHEDULED TASK')
      ) {
        return {
          status: OpenClawServiceStatus.CONFIG_FIX_SUCCESS,
          message: getServiceStatusMessage(OpenClawServiceStatus.CONFIG_FIX_SUCCESS)
        };
      }
      if (upper.includes('[ERROR]') || upper.includes('ERROR')) {
        return { status: OpenClawServiceStatus.ERROR, message: '配置修复失败' };
      }
      // 如果没有明确的错误，默认认为成功（因为 doctor 命令通常会完成）
      return {
        status: OpenClawServiceStatus.CONFIG_FIX_SUCCESS,
        message: getServiceStatusMessage(OpenClawServiceStatus.CONFIG_FIX_SUCCESS)
      };
    }

    return { status: OpenClawServiceStatus.ERROR, message: `未知命令: ${command}` };
  }

  killProcessTree(child) {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') {
        const { execSync } = require('child_process');
        execSync(`taskkill /pid ${child.pid} /T /F`, { windowsHide: true });
      } else {
        child.kill('SIGKILL');
      }
    } catch {}
  }
}

// 脚本映射
const scriptMap = {
  [OpenClawCommandEnum.START]: 'start-opencode.bat',
  [OpenClawCommandEnum.STOP]: 'stop-opencode.bat',
  [OpenClawCommandEnum.RESTART]: 'restart-opencode.bat',
  [OpenClawCommandEnum.STATUS]: 'status-opencode.bat'
};

// 兼容旧版 API：executeCommand
async function executeCommand(command, args = [], timeout = 180) {
  const executor = new ScriptExecutor(undefined, 'Success', timeout);
  const scriptName = scriptMap[command];
  
  if (!scriptName) {
    throw new Error(`未知命令: ${command}`);
  }

  const result = await executor.executeWithStatus(command, scriptName);
  
  // 转换为旧版 API 格式
  return {
    service_status: result.status,
    message: result.message
  };
}

module.exports = { 
  ScriptExecutor, 
  executeCommand, 
  OpenClawCommandEnum,
  OpenClawServiceStatus,
  getServiceStatusMessage
};
