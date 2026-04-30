/**
 * 系统服务管理器
 * 支持 Windows/Linux/macOS 系统服务注册
 */
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

class ServiceManager {
  constructor(serviceName, serviceDesc, scriptPath, log) {
    this.serviceName = serviceName || 'claw-subagent-service';
    this.serviceDesc = serviceDesc || 'OpenClaw Guard CLI Client';
    this.scriptPath = scriptPath || process.argv[1];
    this.log = log;
    this.platform = process.platform;
  }

  /**
   * 安装系统服务
   */
  async install() {
    this.log?.info(`[ServiceManager] 安装系统服务: ${this.serviceName}`);
    
    try {
      switch (this.platform) {
        case 'win32':
          return await this.installWindows();
        case 'linux':
          return await this.installLinux();
        case 'darwin':
          return await this.installMacOS();
        default:
          throw new Error(`不支持的平台: ${this.platform}`);
      }
    } catch (err) {
      this.log?.error(`[ServiceManager] 安装服务失败: ${err.message}`);
      return false;
    }
  }

  /**
   * 卸载系统服务
   */
  async uninstall() {
    this.log?.info(`[ServiceManager] 卸载系统服务: ${this.serviceName}`);
    
    try {
      switch (this.platform) {
        case 'win32':
          return await this.uninstallWindows();
        case 'linux':
          return await this.uninstallLinux();
        case 'darwin':
          return await this.uninstallMacOS();
        default:
          throw new Error(`不支持的平台: ${this.platform}`);
      }
    } catch (err) {
      this.log?.error(`[ServiceManager] 卸载服务失败: ${err.message}`);
      return false;
    }
  }

  /**
   * 启动服务
   */
  async start() {
    this.log?.info(`[ServiceManager] 启动服务: ${this.serviceName}`);
    
    try {
      switch (this.platform) {
        case 'win32':
          return await this.execCommand(`net start ${this.serviceName}`);
        case 'linux':
          return await this.execCommand(`systemctl start ${this.serviceName}`);
        case 'darwin':
          return await this.execCommand(`launchctl start ${this.serviceName}`);
        default:
          throw new Error(`不支持的平台: ${this.platform}`);
      }
    } catch (err) {
      this.log?.error(`[ServiceManager] 启动服务失败: ${err.message}`);
      return false;
    }
  }

  /**
   * 停止服务
   */
  async stop() {
    this.log?.info(`[ServiceManager] 停止服务: ${this.serviceName}`);
    
    try {
      switch (this.platform) {
        case 'win32':
          return await this.execCommand(`net stop ${this.serviceName}`);
        case 'linux':
          return await this.execCommand(`systemctl stop ${this.serviceName}`);
        case 'darwin':
          return await this.execCommand(`launchctl stop ${this.serviceName}`);
        default:
          throw new Error(`不支持的平台: ${this.platform}`);
      }
    } catch (err) {
      this.log?.error(`[ServiceManager] 停止服务失败: ${err.message}`);
      return false;
    }
  }

  /**
   * 重启服务
   */
  async restart() {
    this.log?.info(`[ServiceManager] 重启服务: ${this.serviceName}`);
    
    try {
      switch (this.platform) {
        case 'win32':
          await this.execCommand(`net stop ${this.serviceName}`);
          return await this.execCommand(`net start ${this.serviceName}`);
        case 'linux':
          return await this.execCommand(`systemctl restart ${this.serviceName}`);
        case 'darwin':
          await this.execCommand(`launchctl stop ${this.serviceName}`);
          return await this.execCommand(`launchctl start ${this.serviceName}`);
        default:
          throw new Error(`不支持的平台: ${this.platform}`);
      }
    } catch (err) {
      this.log?.error(`[ServiceManager] 重启服务失败: ${err.message}`);
      return false;
    }
  }

  /**
   * 查看服务状态
   */
  async status() {
    this.log?.info(`[ServiceManager] 查看服务状态: ${this.serviceName}`);
    
    try {
      switch (this.platform) {
        case 'win32':
          return await this.execCommand(`sc query ${this.serviceName}`);
        case 'linux':
          return await this.execCommand(`systemctl status ${this.serviceName}`);
        case 'darwin':
          return await this.execCommand(`launchctl list | grep ${this.serviceName}`);
        default:
          throw new Error(`不支持的平台: ${this.platform}`);
      }
    } catch (err) {
      this.log?.error(`[ServiceManager] 查看状态失败: ${err.message}`);
      return false;
    }
  }

  // Windows 服务安装
  async installWindows() {
    // 使用 node-windows 或手动创建服务
    const nodeWindowsPath = path.join(__dirname, '..', '..', 'node_modules', 'node-windows');
    
    if (!fs.existsSync(nodeWindowsPath)) {
      this.log?.warn('[ServiceManager] node-windows 未安装，尝试安装...');
      await this.execCommand('npm install node-windows --save');
    }
    
    const Service = require('node-windows').Service;
    const svc = new Service({
      name: this.serviceName,
      description: this.serviceDesc,
      script: this.scriptPath,
      nodeOptions: ['--harmony', '--max_old_space_size=4096']
    });
    
    return new Promise((resolve, reject) => {
      svc.on('install', () => {
        this.log?.info('[ServiceManager] Windows 服务安装成功');
        svc.start();
        resolve(true);
      });
      
      svc.on('error', (err) => {
        this.log?.error(`[ServiceManager] Windows 服务安装失败: ${err.message}`);
        reject(err);
      });
      
      svc.install();
    });
  }

  // Linux 服务安装 (systemd)
  async installLinux() {
    const serviceFile = `/etc/systemd/system/${this.serviceName}.service`;
    const serviceContent = `[Unit]
Description=${this.serviceDesc}
After=network.target

[Service]
Type=simple
User=root
ExecStart=/usr/bin/node ${this.scriptPath}
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
`;
    
    fs.writeFileSync(serviceFile, serviceContent);
    await this.execCommand('systemctl daemon-reload');
    await this.execCommand(`systemctl enable ${this.serviceName}`);
    await this.execCommand(`systemctl start ${this.serviceName}`);
    
    this.log?.info('[ServiceManager] Linux 服务安装成功');
    return true;
  }

  // macOS 服务安装 (launchd)
  async installMacOS() {
    const plistFile = `/Library/LaunchDaemons/${this.serviceName}.plist`;
    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${this.serviceName}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>${this.scriptPath}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/var/log/${this.serviceName}.log</string>
    <key>StandardErrorPath</key>
    <string>/var/log/${this.serviceName}.error.log</string>
</dict>
</plist>`;
    
    fs.writeFileSync(plistFile, plistContent);
    await this.execCommand(`launchctl load ${plistFile}`);
    await this.execCommand(`launchctl start ${this.serviceName}`);
    
    this.log?.info('[ServiceManager] macOS 服务安装成功');
    return true;
  }

  // Windows 服务卸载
  async uninstallWindows() {
    const Service = require('node-windows').Service;
    const svc = new Service({
      name: this.serviceName,
      script: this.scriptPath
    });
    
    return new Promise((resolve, reject) => {
      svc.on('uninstall', () => {
        this.log?.info('[ServiceManager] Windows 服务卸载成功');
        resolve(true);
      });
      
      svc.on('error', (err) => {
        this.log?.error(`[ServiceManager] Windows 服务卸载失败: ${err.message}`);
        reject(err);
      });
      
      svc.uninstall();
    });
  }

  // Linux 服务卸载
  async uninstallLinux() {
    await this.execCommand(`systemctl stop ${this.serviceName}`);
    await this.execCommand(`systemctl disable ${this.serviceName}`);
    const serviceFile = `/etc/systemd/system/${this.serviceName}.service`;
    if (fs.existsSync(serviceFile)) {
      fs.unlinkSync(serviceFile);
    }
    await this.execCommand('systemctl daemon-reload');
    
    this.log?.info('[ServiceManager] Linux 服务卸载成功');
    return true;
  }

  // macOS 服务卸载
  async uninstallMacOS() {
    const plistFile = `/Library/LaunchDaemons/${this.serviceName}.plist`;
    await this.execCommand(`launchctl stop ${this.serviceName}`);
    await this.execCommand(`launchctl unload ${plistFile}`);
    if (fs.existsSync(plistFile)) {
      fs.unlinkSync(plistFile);
    }
    
    this.log?.info('[ServiceManager] macOS 服务卸载成功');
    return true;
  }

  // 执行系统命令
  execCommand(command) {
    return new Promise((resolve, reject) => {
      exec(command, (error, stdout, stderr) => {
        if (error) {
          reject(error);
        } else {
          resolve(stdout || stderr);
        }
      });
    });
  }
}

module.exports = {
  ServiceManager
};
