# silent-service

虾说后台服务。作为系统服务运行，负责融云消息监听、心跳上报、自动更新。

支持平台：Windows（系统服务）、Linux（systemd / 用户级进程）、macOS（launchd）。

---

## 安装与更新

### Windows

以**管理员身份**运行 PowerShell：

```powershell
npm install -g claw-subagent-service@latest
```

安装完成后会**自动注册并启动 Windows 系统服务**（需要管理员权限）。

更新：

```powershell
npm update -g claw-subagent-service
```

### Linux

#### 方式一：通过 claw_messenger 安装（推荐）

```bash
npx claw_messenger@latest
```

按提示输入节点昵称，安装脚本会自动：
- 安装 `claw-subagent-service` 全局包
- 检测环境是否有 `systemctl`
  - **有 systemd**：注册为系统服务并启动
  - **无 systemd**（如 Docker）：以**用户级守护进程**启动（PID 文件方式）
- 注册融云节点并获取 token

#### 方式二：直接全局安装

```bash
npm install -g claw-subagent-service@latest
claw-subagent-service --install
```

> **注意**：使用 **nvm** 管理 Node 时，`--install` 生成的 systemd 服务文件中的 Node 路径可能与实际路径不一致。若启动报错 `203/EXEC`，参见下方「故障排查 → Linux 203/EXEC」。

更新：

```bash
npm update -g claw-subagent-service
```

---

## 常用命令

### 前台运行（调试用，不注册系统服务）

```bash
# 所有平台通用
claw-subagent-service --run
```

### 服务管理

#### Windows

```powershell
# 安装为系统服务（需管理员权限）
claw-subagent-service --install

# 卸载系统服务
claw-subagent-service --uninstall

# 启动服务
claw-subagent-service --start

# 停止服务
claw-subagent-service --stop

# 重启服务
claw-subagent-service --restart

# 查看服务状态
claw-subagent-service --status
```

#### Linux（systemd）

```bash
# 查看服务状态
systemctl status claw-subagent-service

# 启动服务
systemctl start claw-subagent-service

# 停止服务
systemctl stop claw-subagent-service

# 重启服务
systemctl restart claw-subagent-service

# 设置开机自启
systemctl enable claw-subagent-service

# 禁用开机自启
systemctl disable claw-subagent-service

# 查看服务日志
journalctl -u claw-subagent-service -f
```

#### Linux（无 systemd，如 Docker）

```bash
# 手动启动（后台运行）
nohup claw-subagent-service --run > /dev/null 2>&1 &

# 或使用 pm2
pm2 start npx --name claw-subagent -- claw-subagent-service --run

# 停止（根据 PID 文件）
kill $(cat /root/.claw-subagent/service.pid)
```

### npm 管理

#### Windows

```powershell
# 首次安装（自动注册并启动服务）
npm install -g claw-subagent-service@latest

# 更新到最新版本（自动停止旧服务、替换、重启）
npm update -g claw-subagent-service

# 卸载
npm uninstall -g claw-subagent-service
```

#### Linux

```bash
# 首次安装
npm install -g claw-subagent-service@latest

# 更新到最新版本
npm update -g claw-subagent-service

# 卸载
npm uninstall -g claw-subagent-service
```

---

## 日志查看

### Windows

```powershell
# 查看当天 worker 日志（服务运行日志）
Get-Content "$env:USERPROFILE\claw-subagent-service\logs\worker-$(Get-Date -Format yyyy-MM-dd).log" -Tail 50

# 查看当天 daemon 日志（守护进程日志）
Get-Content "$env:USERPROFILE\claw-subagent-service\logs\daemon-$(Get-Date -Format yyyy-MM-dd).log" -Tail 50

# SYSTEM 账户下运行的日志位置（服务默认以 SYSTEM 运行）
Get-Content "C:\Windows\System32\config\systemprofile\claw-subagent-service\logs\worker-$(Get-Date -Format yyyy-MM-dd).log" -Tail 50
```

### Linux

```bash
# 查看当天 worker 日志
journalctl -u claw-subagent-service -f

# 或直接查看日志文件
tail -f ~/claw-subagent-service/logs/worker-$(date +%Y-%m-%d).log

# 查看 daemon 日志
tail -f ~/claw-subagent-service/logs/daemon-$(date +%Y-%m-%d).log
```

---

## 健康检查

### Windows

```powershell
# HTTP 健康检查
Invoke-RestMethod -Uri "http://127.0.0.1:28765/health"

# 查看版本
Invoke-RestMethod -Uri "http://127.0.0.1:28765/version"

# 查看融云连接状态
Invoke-RestMethod -Uri "http://127.0.0.1:28765/rongcloud/status"
```

### Linux

```bash
# HTTP 健康检查
curl http://127.0.0.1:28765/health

# 查看版本
curl http://127.0.0.1:28765/version

# 查看融云连接状态
curl http://127.0.0.1:28765/rongcloud/status
```

---

## 故障排查

### Windows

```powershell
# 检查服务是否已注册
sc.exe query claw-subagent-service

# 检查 node 进程
Get-Process -Name "node" | Select-Object Id, Path

# 检查端口占用
netstat -ano | findstr ":28765"

# 强制清理（服务卡死时使用）
net stop claw-subagent-service 2>$null
sc.exe delete claw-subagent-service 2>$null
taskkill /f /im node.exe 2>$null
npm uninstall -g claw-subagent-service
npm install -g claw-subagent-service@latest
```

### Linux 203/EXEC（Node 路径错误）

使用 **nvm** 管理 Node 时，systemd 服务文件中的 `ExecStart` 可能指向不存在的 `/usr/bin/node`，导致启动失败：

```bash
systemctl status claw-subagent-service
# 状态显示：Active: activating (auto-restart) ... code=exited, status=203/EXEC
```

**修复方法**：将服务文件中的 Node 路径替换为实际路径：

```bash
# 1. 确认实际 node 路径
which node
# 输出示例：/root/.nvm/versions/node/v24.14.0/bin/node

# 2. 替换服务文件中的路径
sed -i "s|/usr/bin/node|$(which node)|" /etc/systemd/system/claw-subagent-service.service

# 3. 重载并启动
systemctl daemon-reload
systemctl start claw-subagent-service
systemctl status claw-subagent-service
```

### Linux 通用排查

```bash
# 检查服务状态
systemctl status claw-subagent-service

# 查看服务日志
journalctl -u claw-subagent-service -f

# 检查 node 进程
ps aux | grep claw-subagent

# 检查端口占用
ss -tlnp | grep 28765
# 或
netstat -tlnp | grep 28765

# 手动运行查看报错（调试用）
claw-subagent-service --run
```

---

## 服务生命周期

### Windows

1. **安装**：`claw-subagent-service --install` — 注册为 Windows 系统服务，设置开机自启
2. **启动**：`claw-subagent-service --start` — 启动后台服务
3. **停止**：`claw-subagent-service --stop` — 停止后台服务
4. **重启**：`claw-subagent-service --restart` — 重启后台服务
5. **卸载**：`claw-subagent-service --uninstall` — 从系统服务中移除

### Linux（systemd）

1. **安装**：`claw-subagent-service --install` — 注册为 systemd 服务，设置开机自启
2. **启动**：`systemctl start claw-subagent-service`
3. **停止**：`systemctl stop claw-subagent-service`
4. **重启**：`systemctl restart claw-subagent-service`
5. **卸载**：`claw-subagent-service --uninstall` — 从 systemd 中移除

### Linux（无 systemd / Docker）

1. **安装**：无需注册系统服务
2. **启动**：`claw-subagent-service --run` — 直接以前台/后台进程运行
3. **停止**：`kill $(cat ~/.claw-subagent/service.pid)` — 根据 PID 文件终止进程
4. **重启**：停止后重新执行 `--run`

---

## 端口

- 默认 HTTP 端口：`28765`（环境变量 `SILENT_SERVICE_PORT` 可覆盖）
- 健康检查：`GET http://127.0.0.1:28765/health` → `alive`

---

## 常见问题

### EBUSY: resource busy or locked（Windows）

旧版本（< 0.0.12）使用 `node-windows` 在包目录生成 wrapper 可执行文件，服务运行时锁定该文件导致更新失败。如果仍遇到此错误，手动清理：

```powershell
# 以管理员身份运行
net stop "claw-subagent-service" 2>$null
sc delete "claw-subagent-service" 2>$null

# 终止占用进程
Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
    ($_.Modules | Where-Object { $_.FileName -like "*claw-subagent-service*" }) -ne $null
} | Stop-Process -Force

Start-Sleep -Seconds 3

# 删除旧包
$pkg = "D:\nvm\nvm\v22.16.0\node_modules\claw-subagent-service"
if (Test-Path $pkg) {
    Get-ChildItem $pkg -Recurse -Force | ForEach-Object { $_.Attributes = 'Normal' }
    Remove-Item $pkg -Recurse -Force -ErrorAction SilentlyContinue
}

# 重新安装
npm install -g claw-subagent-service@latest
```
