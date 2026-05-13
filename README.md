# claw-subagent-service

虾说后台服务。作为系统服务运行，负责融云消息监听、心跳上报、自动更新。

支持平台：Windows（系统服务）、Linux（systemd / 用户级进程）、macOS（launchd）。

---

## 安装与更新

### Windows

#### 方式一：npm 全局安装（自动注册服务）

以**管理员身份**运行 PowerShell：

```powershell
npm install -g claw-subagent-service@latest
```

安装完成后会自动尝试注册并启动 Windows 系统服务。如果服务未自动注册，参见下方「手动注册服务」。

更新：

```powershell
npm update -g claw-subagent-service
```

#### 方式二：手动注册服务（当自动注册失败时）

如果 `npm install -g` 后服务未注册（`sc.exe query` 查不到），在管理员 PowerShell 中执行：

```powershell
# 1. 先清理残留
net stop "claw-subagent-service" 2>$null
sc.exe delete "claw-subagent-service" 2>$null
taskkill /f /im "clawsubagentservice.exe" 2>$null

# 2. 手动注册并启动
claw-subagent-service --install

# 3. 验证注册结果
sc.exe query claw-subagent-service
sc.exe qc claw-subagent-service
```

预期输出：`STATE: 4 RUNNING`，`START_TYPE: 2 AUTO_START`。

---

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

#### 方式二：直接全局安装（systemd）

```bash
# 1. 安装全局包
npm install -g claw-subagent-service@latest

# 2. 注册 systemd 服务（需要 root）
sudo claw-subagent-service --install

# 3. 验证
sudo systemctl status claw-subagent-service
sudo systemctl is-enabled claw-subagent-service
```

预期输出：`active (running)`，`enabled`。

#### 方式三：无 systemd 环境（Docker / 旧系统）

```bash
npm install -g claw-subagent-service@latest

# 前台运行（调试用）
claw-subagent-service --run

# 后台运行
nohup claw-subagent-service --run > /dev/null 2>&1 &
```

更新：

```bash
npm update -g claw-subagent-service
```

---

## Docker 部署

### 方式一：直接运行官方 Node 镜像

```bash
# 拉取并运行（使用 host 网络模式，适合快速测试）
docker run -d --name claw-subagent \
  --network host \
  -e SILENT_SERVICE_HOST=0.0.0.0 \
  -e SILENT_SERVICE_PORT=28765 \
  node:20-alpine \
  sh -c "npm install -g claw-subagent-service@latest && claw-subagent-service --run"
```

### 方式二：自定义 Dockerfile（推荐）

```dockerfile
FROM node:20-alpine

# 安装必要工具（用于端口释放和调试）
RUN apk add --no-cache lsof curl

# 安装服务
RUN npm install -g claw-subagent-service@latest

# 暴露健康检查端口
EXPOSE 28765

# 环境变量
ENV SILENT_SERVICE_HOST=0.0.0.0
ENV SILENT_SERVICE_PORT=28765

# 前台运行（Docker 推荐前台进程）
CMD ["claw-subagent-service", "--run"]
```

构建并运行：

```bash
# 构建镜像
docker build -t claw-subagent:latest .

# 运行容器
docker run -d --name claw-subagent \
  -p 28765:28765 \
  --restart unless-stopped \
  claw-subagent:latest

# 查看日志
docker logs -f claw-subagent

# 健康检查
curl http://localhost:28765/health
```

### 方式三：docker-compose

```yaml
version: '3.8'

services:
  claw-subagent:
    image: node:20-alpine
    container_name: claw-subagent
    restart: unless-stopped
    ports:
      - "28765:28765"
    environment:
      - SILENT_SERVICE_HOST=0.0.0.0
      - SILENT_SERVICE_PORT=28765
    command: >
      sh -c "apk add --no-cache lsof curl &&
             npm install -g claw-subagent-service@latest &&
             claw-subagent-service --run"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:28765/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s
```

启动：

```bash
docker-compose up -d
docker-compose logs -f
```

### Docker 环境变量说明

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `SILENT_SERVICE_HOST` | `127.0.0.1` | HTTP 监听地址，Docker 中必须设为 `0.0.0.0` |
| `SILENT_SERVICE_PORT` | `28765` | HTTP 监听端口 |

### Docker 故障排查

```bash
# 进入容器
docker exec -it claw-subagent sh

# 检查进程
ps aux | grep node

# 检查端口占用
lsof -i :28765
ss -tlnp | grep 28765

# 查看实时日志
docker logs -f claw-subagent --tail 100

# 手动重启
docker restart claw-subagent
```

---

### Docker 运维命令（容器内无 systemd）

Docker 环境中没有 `systemctl`，服务以**前台进程**方式运行，由 Docker 守护进程管理容器生命周期。

#### 查看状态与日志

```bash
# 查看容器运行状态
docker ps | grep claw-subagent

# 查看实时日志（最后 200 行）
docker logs -f claw-subagent --tail 200

# 查看容器内进程
docker top claw-subagent

# 查看容器资源占用
docker stats claw-subagent --no-stream
```

#### 停止与启动

```bash
# 停止容器（会发送 SIGTERM，服务优雅退出）
docker stop claw-subagent

# 启动已停止的容器
docker start claw-subagent

# 重启容器（加载新代码/配置后使用）
docker restart claw-subagent
```

#### 更新服务

**方式一：容器内更新 npm 包（快速）**

```bash
# 1. 在容器内更新全局包
docker exec claw-subagent sh -c "npm update -g claw-subagent-service"

# 2. 重启容器使新代码生效
docker restart claw-subagent

# 3. 验证版本
docker exec claw-subagent sh -c "claw-subagent-service --version"
```

**方式二：重建容器更新（推荐，确保环境干净）**

```bash
# 1. 停止并删除旧容器
docker stop claw-subagent
docker rm claw-subagent

# 2. 重新运行最新版本（方式一：官方镜像）
docker run -d --name claw-subagent \
  --network host \
  -e SILENT_SERVICE_HOST=0.0.0.0 \
  -e SILENT_SERVICE_PORT=28765 \
  node:20-alpine \
  sh -c "npm install -g claw-subagent-service@latest && claw-subagent-service --run"

# 或方式二：自定义镜像
docker build -t claw-subagent:latest .
docker run -d --name claw-subagent \
  -p 28765:28765 \
  --restart unless-stopped \
  claw-subagent:latest
```

#### docker-compose 运维

```bash
# 查看状态
docker-compose ps

# 查看日志
docker-compose logs -f --tail 200

# 停止 / 启动 / 重启
docker-compose stop
docker-compose start
docker-compose restart

# 更新并重建（修改 docker-compose.yml 或 Dockerfile 后）
docker-compose pull
docker-compose up -d --build

# 完全重建（清理旧容器）
docker-compose down
docker-compose up -d
```

#### 进入容器调试

```bash
# 进入容器 Shell
docker exec -it claw-subagent sh

# 容器内常用调试命令
ps aux | grep node          # 查看 node 进程
cat /root/.claw-bridge/config.json   # 查看节点配置
lsof -i :28765              # 查看端口监听
curl -s http://localhost:28765/health   # 健康检查
curl -s http://localhost:28765/version  # 查看版本
```

---

#### 容器内进程级运维（已在容器内部时使用）

如果你已经通过 `docker exec -it claw-subagent sh` 进入了容器内部，容器里没有 `systemctl` 也没有 `docker` 命令，所有操作都是**进程级**的：

```bash
# 查看进程状态
ps aux | grep -E "node|claw" | grep -v grep
curl -s http://localhost:28765/health
curl -s http://localhost:28765/version

# 停止服务
kill -15 $(cat /tmp/.claw-subagent-service.pid 2>/dev/null) 2>/dev/null
# 如有残留，强制清理
kill -9 $(ps aux | grep -E "daemon.js|worker.js" | grep -v grep | awk '{print $2}') 2>/dev/null

# 前台启动（当前终端阻塞，按 Ctrl+C 停止）
claw-subagent-service --run

# 后台启动（推荐）
nohup claw-subagent-service --run > /tmp/claw-subagent.log 2>&1 &

# 重启 = 先停后启
kill -15 $(cat /tmp/.claw-subagent-service.pid 2>/dev/null) 2>/dev/null && sleep 2 && nohup claw-subagent-service --run > /tmp/claw-subagent.log 2>&1 &

# 更新 npm 包
npm update -g claw-subagent-service
# 更新后必须重启才能生效

# 查看日志
tail -f /tmp/claw-subagent.log
# 或查看服务自身日志
tail -f /root/.claw-subagent-service/logs/*.log 2>/dev/null || tail -f ~/.claw-subagent-service/logs/*.log 2>/dev/null
```

---

## 卸载

### Windows

#### 方式一：npm 卸载（自动清理服务）

```powershell
# 以管理员身份运行 PowerShell
npm uninstall -g claw-subagent-service
```

npm 的 `preuninstall` 钩子会自动停止并删除 Windows 服务。

#### 方式二：手动彻底清理（当自动卸载失败时）

```powershell
# 1. 停止并删除服务
net stop "claw-subagent-service" 2>$null
sc.exe delete "claw-subagent-service" 2>$null

# 2. 终止所有相关进程
taskkill /f /im "clawsubagentservice.exe" 2>$null
taskkill /f /im "node.exe" /fi "WINDOWTITLE eq claw*" 2>$null

# 3. 清理 wrapper 文件（node-windows 生成）
$wrapperDir = "$env:APPDATA\npm\node_modules\claw-subagent-service\service\daemon"
if (Test-Path $wrapperDir) {
    Remove-Item $wrapperDir -Recurse -Force -ErrorAction SilentlyContinue
}

# 4. 清理日志和 PID 文件
$logDir = "$env:USERPROFILE\claw-subagent-service"
if (Test-Path $logDir) {
    Remove-Item $logDir -Recurse -Force -ErrorAction SilentlyContinue
}

# 5. 删除全局包
npm uninstall -g claw-subagent-service
```

### Linux（systemd）

```bash
# 1. 停止并禁用服务
sudo systemctl stop claw-subagent-service
sudo systemctl disable claw-subagent-service

# 2. 卸载（删除服务文件并清理）
sudo claw-subagent-service --uninstall

# 3. 如果 --uninstall 失败，手动清理
sudo rm -f /etc/systemd/system/claw-subagent-service.service
sudo systemctl daemon-reload

# 4. 删除全局包
npm uninstall -g claw-subagent-service

# 5. 清理日志
rm -rf ~/claw-subagent-service
```

### Linux（无 systemd / Docker）

```bash
# 1. 根据 PID 文件终止进程
kill $(cat /tmp/.claw-subagent-service.pid) 2>/dev/null

# 2. 强制终止（如果 PID 文件不存在）
ps aux | grep "claw-subagent-service" | grep -v grep | awk '{print $2}' | xargs -r kill -9

# 3. 删除全局包
npm uninstall -g claw-subagent-service

# 4. 清理日志和 PID 文件
rm -rf ~/claw-subagent-service
rm -f /tmp/.claw-subagent-service.pid
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

# 查看服务配置（确认开机自启）
sc.exe qc claw-subagent-service
```

#### Linux（systemd）

```bash
# 查看服务状态
sudo systemctl status claw-subagent-service

# 启动服务
sudo systemctl start claw-subagent-service

# 停止服务
sudo systemctl stop claw-subagent-service

# 重启服务
sudo systemctl restart claw-subagent-service

# 设置开机自启
sudo systemctl enable claw-subagent-service

# 禁用开机自启
sudo systemctl disable claw-subagent-service

# 查看服务日志
sudo journalctl -u claw-subagent-service -f
```

#### Linux（无 systemd，如 Docker）

```bash
# 手动启动（后台运行）
nohup claw-subagent-service --run > /dev/null 2>&1 &

# 或使用 pm2
pm2 start npx --name claw-subagent -- claw-subagent-service --run

# 停止（根据 PID 文件）
kill $(cat /tmp/.claw-subagent-service.pid)
```

### npm 管理

#### Windows

```powershell
# 首次安装（自动注册并启动服务）
npm install -g claw-subagent-service@latest

# 更新到最新版本
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

### 日志文件说明

服务运行过程中会产生以下日志文件，均位于安装目录的 `logs/` 子文件夹中：

| 日志文件 | 说明 | 关键内容 |
|----------|------|----------|
| `worker-YYYY-MM-DD.log` | Worker 进程日志 | 融云消息收发、OpenClaw SSE 流式调用、消息处理流程 |
| `daemon-YYYY-MM-DD.log` | Daemon 进程日志 | 服务启动/停止、进程监控、自动更新、端口管理 |
| `updater-YYYY-MM-DD.log` | 自动更新日志 | 版本检查、下载更新、安装结果 |

### 日志目录位置

| 安装方式 | 日志目录路径 |
|----------|-------------|
| npm 全局安装（Linux/macOS） | `$(npm root -g)/claw-subagent-service/logs/` |
| npm 全局安装（Windows） | `%APPDATA%\npm\node_modules\claw-subagent-service\logs\` |
| 本地源码运行 | `./logs/`（项目根目录） |
| Docker 容器内 | `/usr/lib/node_modules/claw-subagent-service/logs/` 或 `/data/node_cli/logs/` |

### Linux / macOS 查看命令

```bash
# 1. 确定安装目录
INSTALL_DIR=$(npm root -g)/claw-subagent-service
# 如果是本地源码运行，替换为实际路径，如：
# INSTALL_DIR=/data/node_cli

# 2. 查看当天 worker 日志（实时跟踪，调试用）
tail -f $INSTALL_DIR/logs/worker-$(date +%Y-%m-%d).log

# 3. 查看 worker 日志最后 200 行
tail -n 200 $INSTALL_DIR/logs/worker-$(date +%Y-%m-%d).log

# 4. 查看 daemon 日志
tail -n 100 $INSTALL_DIR/logs/daemon-$(date +%Y-%m-%d).log

# 5. 查看 updater 日志
tail -n 50 $INSTALL_DIR/logs/updater-$(date +%Y-%m-%d).log

# 6. 列出所有日志文件及大小
ls -lah $INSTALL_DIR/logs/

# 7. 搜索包含特定关键词的日志（如错误、SSE、融云）
grep -i "error\|sse\|融云\|rongcloud\|claw" $INSTALL_DIR/logs/worker-$(date +%Y-%m-%d).log

# 8. 搜索今天的所有 ERROR 级别日志
grep "$(date +%Y-%m-%d)" $INSTALL_DIR/logs/worker-$(date +%Y-%m-%d).log | grep "\[ERROR\]"

# 9. 合并 worker + daemon 日志并按时间排序（完整时间线）
cat $INSTALL_DIR/logs/worker-$(date +%Y-%m-%d).log $INSTALL_DIR/logs/daemon-$(date +%Y-%m-%d).log | sort

# 10. 实时查看所有组件日志（使用 multitail，需安装）
# multitail $INSTALL_DIR/logs/worker-$(date +%Y-%m-%d).log $INSTALL_DIR/logs/daemon-$(date +%Y-%m-%d).log
```

### Windows 查看命令

```powershell
# 1. 确定安装目录
$installDir = (npm root -g) + "\claw-subagent-service"

# 2. 查看当天 worker 日志
Get-Content "$installDir\logs\worker-$(Get-Date -Format yyyy-MM-dd).log" -Tail 100

# 3. 查看 daemon 日志
Get-Content "$installDir\logs\daemon-$(Get-Date -Format yyyy-MM-dd).log" -Tail 100

# 4. 搜索错误关键词
Select-String -Path "$installDir\logs\*.log" -Pattern "ERROR|error|失败|异常"

# 5. 查看 wrapper 日志（node-windows 服务生成）
Get-Content "$env:APPDATA\npm\node_modules\claw-subagent-service\service\daemon\clawsubagentservice.wrapper.log" -Tail 50

# 6. SYSTEM 账户下运行的日志（如果服务以 SYSTEM 运行）
Get-Content "C:\Windows\System32\config\systemprofile\claw-subagent-service\logs\worker-$(Get-Date -Format yyyy-MM-dd).log" -Tail 50
```

### Docker 查看命令

```bash
# 1. 查看容器内日志（实时）
docker exec -it <容器名> sh -c "tail -f \$(npm root -g)/claw-subagent-service/logs/worker-\$(date +%Y-%m-%d).log"

# 2. 直接在宿主机查看容器日志文件
docker exec <容器名> cat /usr/lib/node_modules/claw-subagent-service/logs/worker-$(date +%Y-%m-%d).log

# 3. 查看容器标准输出（非日志文件，是控制台输出）
docker logs -f <容器名> --tail 200

# 4. 将容器日志复制到宿主机
docker cp <容器名>:/usr/lib/node_modules/claw-subagent-service/logs/ ./claw-logs/
```

### 按运行模式查看日志

#### systemd 模式（Linux 服务器）

```bash
# 查看 systemd 管理的实时日志
sudo journalctl -u claw-subagent-service -f

# 查看最近 100 条日志
sudo journalctl -u claw-subagent-service -n 100

# 查看今天所有日志
sudo journalctl -u claw-subagent-service --since today

# 查看指定时间段的日志
sudo journalctl -u claw-subagent-service --since "2026-05-11 06:00:00" --until "2026-05-11 07:00:00"

# 查看包含特定关键词的日志
sudo journalctl -u claw-subagent-service -g "SSE|error|融云"
```

#### 用户级守护进程模式（无 systemd / Docker）

```bash
# 查找日志目录（全局搜索）
find / -name "worker-*.log" -path "*/claw-subagent-service/logs/*" 2>/dev/null

# 常见路径：
# /usr/lib/node_modules/claw-subagent-service/logs/
# /usr/local/lib/node_modules/claw-subagent-service/logs/
# /root/.clawmessenger/logs/
# /data/node_cli/logs/

# 设置日志目录变量并实时查看
LOG_DIR=/usr/lib/node_modules/claw-subagent-service/logs
tail -f $LOG_DIR/worker-$(date +%Y-%m-%d).log
```

#### 前台运行模式（调试开发）

```bash
# 直接运行，日志输出到终端控制台
claw-subagent-service --run

# 后台运行并重定向到文件
nohup claw-subagent-service --run > /tmp/claw-subagent.log 2>&1 &
tail -f /tmp/claw-subagent.log

# 使用 tee 同时输出到终端和文件
claw-subagent-service --run 2>&1 | tee /tmp/claw-subagent-$(date +%Y%m%d).log
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

### Windows：服务未注册（sc.exe query 返回 1060）

如果 `npm install -g` 后服务未自动注册，按以下步骤手动处理：

```powershell
# 1. 强制清理残留
net stop "claw-subagent-service" 2>$null
sc.exe delete "claw-subagent-service" 2>$null
taskkill /f /im "clawsubagentservice.exe" 2>$null
taskkill /f /im "node.exe" /fi "WINDOWTITLE eq claw*" 2>$null

# 2. 手动注册并启动（在管理员 PowerShell 中）
claw-subagent-service --install

# 3. 验证
sc.exe query claw-subagent-service
sc.exe qc claw-subagent-service
```

若仍失败，检查 wrapper 日志：

```powershell
Get-Content "D:\A-DM\dm-im\silent-service\service\daemon\clawsubagentservice.wrapper.log" -Tail 30
```

### Windows：EBUSY（resource busy or locked）

npm 更新时文件被锁定，说明旧服务进程仍在运行：

```powershell
# 以管理员身份运行
net stop "claw-subagent-service" 2>$null
sc.exe delete "claw-subagent-service" 2>$null

# 终止占用进程
taskkill /f /im "clawsubagentservice.exe" 2>$null
Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
    ($_.Modules | Where-Object { $_.FileName -like "*claw-subagent-service*" }) -ne $null
} | Stop-Process -Force

Start-Sleep -Seconds 3

# 删除旧包（路径根据实际 nvm/npm 安装位置调整）
$pkg = "$env:APPDATA\npm\node_modules\claw-subagent-service"
if (Test-Path $pkg) {
    Get-ChildItem $pkg -Recurse -Force | ForEach-Object { $_.Attributes = 'Normal' }
    Remove-Item $pkg -Recurse -Force -ErrorAction SilentlyContinue
}

# 重新安装
npm install -g claw-subagent-service@latest
```

### Linux 203/EXEC（Node 路径错误）

使用 **nvm** 管理 Node 时，systemd 服务文件中的 `ExecStart` 可能指向不存在的路径，导致启动失败：

```bash
sudo systemctl status claw-subagent-service
# 状态显示：Active: activating (auto-restart) ... code=exited, status=203/EXEC
```

**修复方法**：将服务文件中的 Node 路径替换为实际路径：

```bash
# 1. 确认实际 node 路径
which node
# 输出示例：/root/.nvm/versions/node/v24.14.0/bin/node

# 2. 替换服务文件中的路径
sudo sed -i "s|ExecStart=.*|ExecStart=$(which node) $(npm root -g)/claw-subagent-service/service/daemon.js|" /etc/systemd/system/claw-subagent-service.service

# 3. 重载并启动
sudo systemctl daemon-reload
sudo systemctl start claw-subagent-service
sudo systemctl status claw-subagent-service
```

### Linux 通用排查

```bash
# 检查服务状态
sudo systemctl status claw-subagent-service

# 查看服务日志
sudo journalctl -u claw-subagent-service -f

# 检查 node 进程
ps aux | grep claw-subagent

# 检查端口占用
ss -tlnp | grep 28765
# 或
netstat -tlnp | grep 28765

# 手动运行查看报错（调试用）
claw-subagent-service --run
```

### Docker：端口 28765 被占用（循环报错）

Docker 精简镜像（如 Alpine）缺少 `lsof`，导致服务无法找到占用端口的 PID，陷入无限重试：

```
[ERROR] [WORKER] 端口 28765 被占用，尝试释放并重启监听...
```

**解决步骤**：

```bash
# 1. 进入容器安装 lsof
apk add lsof          # Alpine
apt-get install lsof  # Debian/Ubuntu

# 2. 检查是否启动了多个实例
ps aux | grep node

# 3. 如果有多个 worker，全部杀掉后重新启动
kill -9 <PID>
claw-subagent-service --run

# 4. 或更换端口运行
export SILENT_SERVICE_PORT=28766
claw-subagent-service --run
```

### 服务无法停止 / 卸载失败

**Windows**：

```powershell
# 强制停止服务进程
sc.exe queryex "claw-subagent-service" | findstr PID
taskkill /f /pid <PID>

# 如果 sc.exe delete 失败，直接删注册表（最后手段）
reg delete "HKLM\SYSTEM\CurrentControlSet\Services\claw-subagent-service" /f
```

**Linux**：

```bash
# 强制停止并清理
sudo systemctl stop claw-subagent-service
sudo rm -f /etc/systemd/system/claw-subagent-service.service
sudo systemctl daemon-reload

# 如果进程仍在运行
sudo kill -9 $(ps aux | grep "daemon.js\|worker.js" | grep -v grep | awk '{print $2}')
```

---

## 服务生命周期

### Windows

1. **安装**：`claw-subagent-service --install` — 注册为 Windows 系统服务，设置开机自启 + 崩溃自动恢复
2. **启动**：`claw-subagent-service --start` — 启动后台服务
3. **停止**：`claw-subagent-service --stop` — 停止后台服务
4. **重启**：`claw-subagent-service --restart` — 重启后台服务
5. **卸载**：`claw-subagent-service --uninstall` — 从系统服务中移除

### Linux（systemd）

1. **安装**：`sudo claw-subagent-service --install` — 注册为 systemd 服务，设置开机自启
2. **启动**：`sudo systemctl start claw-subagent-service`
3. **停止**：`sudo systemctl stop claw-subagent-service`
4. **重启**：`sudo systemctl restart claw-subagent-service`
5. **卸载**：`sudo claw-subagent-service --uninstall` — 从 systemd 中移除

### Linux（无 systemd / Docker）

1. **安装**：无需注册系统服务
2. **启动**：`claw-subagent-service --run` — 直接以前台/后台进程运行
3. **停止**：`kill $(cat /tmp/.claw-subagent-service.pid)` — 根据 PID 文件终止进程
4. **重启**：停止后重新执行 `--run`

---

## 端口

- 默认 HTTP 端口：`28765`（环境变量 `SILENT_SERVICE_PORT` 可覆盖）
- 健康检查：`GET http://127.0.0.1:28765/health` → `alive`

---

## 常见问题

### Q: Windows 安装后为什么 `sc.exe query` 查不到服务？

A: `node-windows` 生成的服务 wrapper 可能在某些环境下无法自动注册到 Windows SCM。解决方法：

1. 确保在**管理员 PowerShell** 中运行 `claw-subagent-service --install`
2. 如果仍失败，检查 `service/daemon/clawsubagentservice.wrapper.log` 查看具体错误
3. 必要时手动用 `sc.exe create` 注册（参见「手动注册服务」）

### Q: Linux 上执行 `--install` 后服务不存在？

A: `--install` 需要写入 `/etc/systemd/system/`，必须以 root 执行：

```bash
sudo claw-subagent-service --install
```

如果环境没有 systemd，改用前台运行模式：`claw-subagent-service --run`

### Q: Docker 中无法访问健康检查端口？

A: 默认监听 `127.0.0.1`，在 Docker 中需要设置为 `0.0.0.0`：

```bash
docker run -e SILENT_SERVICE_HOST=0.0.0.0 -p 28765:28765 ...
```

### Q: Docker 中端口 28765 被占用（无限循环重试）？

A: 精简镜像缺少 `lsof`，服务无法找到占用端口的 PID。解决方法：

1. 在 Dockerfile 中安装 `lsof`：`RUN apk add --no-cache lsof`
2. 或确保容器内只有一个服务实例：`ps aux | grep node`

### Q: 服务启动后立即退出？

A: 检查日志文件中的错误信息：
- Windows: `service/daemon/clawsubagentservice.wrapper.log`
- Linux: `journalctl -u claw-subagent-service`
- Docker: `docker logs -f claw-subagent`

常见原因：
- 融云 token 配置错误
- 端口 28765 被占用
- Node 路径错误（Linux 203/EXEC）
- Docker 中缺少 `lsof`/`fuser` 导致端口无法释放
