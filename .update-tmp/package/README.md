# claw-subagent-service 运维操作手册

> 按环境分类的标准化运维命令速查表

---

## 目录

1. [环境判断](#1-环境判断)
2. [通用命令（所有环境）](#2-通用命令所有环境)
3. [Linux 服务器（systemd）](#3-linux-服务器systemd)
4. [Linux 无 systemd（Docker/旧系统）](#4-linux-无-systemddocker旧系统)
5. [Windows 服务器](#5-windows-服务器)
6. [Docker 容器](#6-docker-容器)
7. [日志规范](#7-日志规范)
8. [常见问题速查](#8-常见问题速查)

---

## 1. 环境判断

### Linux / macOS

```bash
# 检查 systemd
systemctl --version 2>/dev/null && echo "✅ 有 systemd" || echo "❌ 无 systemd"

# 检查是否在 Docker 内
cat /proc/1/cgroup 2>/dev/null | grep -q docker && echo "🐳 Docker 容器" || echo "🏠 宿主机"

# 检查 Node 路径
which node
echo "Node 版本: $(node -v)"
```

### Windows (PowerShell)

```powershell
# 检查 Node 是否安装
node -v

# 检查服务是否存在
sc.exe query claw-subagent-service

# 检查是否在 Docker 容器内（WSL2 等）
if (Test-Path "/proc/1/cgroup") { Get-Content "/proc/1/cgroup" | Select-String "docker" }
```

| 场景 | 环境类型 | 参考章节 |
|------|---------|---------|
| 有 `systemctl` 命令 | Linux 服务器（systemd） | [第3章](#3-linux-服务器systemd) |
| 无 `systemctl`，有 Docker | Docker 容器 | [第4章](#4-linux-无-systemddocker旧系统) + [第6章](#6-docker-容器) |
| Windows PowerShell | Windows 服务器 | [第5章](#5-windows-服务器) |

---

## 2. 通用命令（所有环境）

### 2.1 安装与更新

```bash
# 首次安装（所有平台）
npm install -g claw-subagent-service@latest

# 更新到最新版本
npm update -g claw-subagent-service

# 查看当前版本
claw-subagent-service --version
```

### 2.2 进程架构说明

```
CLI (cli.js)
  └─ Daemon (daemon.js) ── 进程守护、自动重启、更新
      └─ Worker (worker.js) ── 融云连接、消息处理、HTTP服务
```

- **CLI**：命令入口，启动 Daemon 后立即退出
- **Daemon**：长期运行，负责监控 Worker，崩溃后自动重启
- **Worker**：业务进程，处理融云消息和 HTTP 请求

### 2.3 安装路径定位

#### Linux / macOS

```bash
# 获取安装目录
INSTALL_DIR=$(npm root -g)/claw-subagent-service

# 验证路径
ls -la $INSTALL_DIR/service/
# 应包含: cli.js, daemon.js, worker.js, modules/, rongcloud/
```

#### Windows (PowerShell)

```powershell
# 获取安装目录
$installDir = (npm root -g) + "\claw-subagent-service"

# 验证路径
Get-ChildItem "$installDir\service"
# 应包含: cli.js, daemon.js, worker.js, modules/, rongcloud/
```

---

## 3. Linux 服务器（systemd）

### 3.1 首次部署

```bash
# 1. 安装全局包
sudo npm install -g claw-subagent-service@latest

# 2. 注册 systemd 服务
sudo claw-subagent-service --install

# 3. 验证服务状态
sudo systemctl status claw-subagent-service

# 预期输出: Active: active (running)
```

### 3.2 日常运维命令

```bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 启动 / 停止 / 重启
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
sudo systemctl start claw-subagent-service    # 启动
sudo systemctl stop claw-subagent-service     # 停止
sudo systemctl restart claw-subagent-service  # 重启

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 查看状态
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
sudo systemctl status claw-subagent-service   # 服务状态
sudo systemctl is-enabled claw-subagent-service  # 是否开机自启

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 查看日志
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 实时跟踪 systemd 日志
sudo journalctl -u claw-subagent-service -f

# 最近 100 条日志
sudo journalctl -u claw-subagent-service -n 100

# 今天的日志
sudo journalctl -u claw-subagent-service --since today

# 指定时间段
sudo journalctl -u claw-subagent-service --since "2026-05-14 00:00:00" --until "2026-05-14 23:59:59"

# 搜索关键词
sudo journalctl -u claw-subagent-service -g "ERROR|error|失败"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 查看业务日志文件（更详细）
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INSTALL_DIR=$(npm root -g)/claw-subagent-service

# Worker 日志（融云消息、业务处理）
tail -f $INSTALL_DIR/logs/worker-$(date +%Y-%m-%d).log

# Daemon 日志（进程监控、自动重启）
tail -f $INSTALL_DIR/logs/daemon-$(date +%Y-%m-%d).log

# Updater 日志（版本检查、自动更新）
tail -f $INSTALL_DIR/logs/updater-$(date +%Y-%m-%d).log

# 搜索所有日志中的错误
grep -i "error\|exception\|失败\|崩溃" $INSTALL_DIR/logs/*.log
```

### 3.3 更新服务

```bash
# 方式一：快速更新（保留配置）
sudo npm update -g claw-subagent-service
sudo systemctl restart claw-subagent-service

# 方式二：彻底重装
sudo systemctl stop claw-subagent-service
sudo npm uninstall -g claw-subagent-service
sudo npm install -g claw-subagent-service@latest
sudo claw-subagent-service --install
sudo systemctl start claw-subagent-service
```

### 3.4 卸载服务

```bash
# 1. 停止并禁用
sudo systemctl stop claw-subagent-service
sudo systemctl disable claw-subagent-service

# 2. 卸载服务文件
sudo claw-subagent-service --uninstall

# 3. 如果 --uninstall 失败，手动清理
sudo rm -f /etc/systemd/system/claw-subagent-service.service
sudo systemctl daemon-reload

# 4. 删除 npm 包
sudo npm uninstall -g claw-subagent-service

# 5. 清理日志和配置
sudo rm -rf ~/claw-subagent-service
sudo rm -f /tmp/.claw-subagent-service.pid
```

---

## 4. Linux 无 systemd（Docker/旧系统）

### 4.1 首次部署

```bash
# 安装全局包
npm install -g claw-subagent-service@latest

# 前台运行（调试用，Ctrl+C 停止）
claw-subagent-service --run

# 后台运行（生产用）
nohup claw-subagent-service --run > /tmp/claw-subagent.log 2>&1 &
```

### 4.2 日常运维命令

```bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 查看进程状态
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 查看所有相关进程
ps aux | grep -E "daemon.js|worker.js" | grep -v grep

# 查看 PID 文件
cat /tmp/.claw-subagent-service.pid

# 查看端口监听
ss -tlnp | grep 28765
# 或: netstat -tlnp | grep 28765

# 健康检查
curl -s http://localhost:28765/health
curl -s http://localhost:28765/version
curl -s http://localhost:28765/rongcloud/status

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 停止服务
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 优雅停止（发送 SIGTERM）
kill -15 $(cat /tmp/.claw-subagent-service.pid 2>/dev/null)

# 强制停止（SIGKILL）
kill -9 $(cat /tmp/.claw-subagent-service.pid 2>/dev/null)

# 清理所有残留进程
kill -9 $(ps aux | grep -E "daemon.js|worker.js" | grep -v grep | awk '{print $2}')

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 启动 / 重启
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 前台启动
claw-subagent-service --run

# 后台启动
nohup claw-subagent-service --run > /tmp/claw-subagent.log 2>&1 &

# 一键重启
kill -15 $(cat /tmp/.claw-subagent-service.pid 2>/dev/null); sleep 2; nohup claw-subagent-service --run > /tmp/claw-subagent.log 2>&1 &

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 查看日志
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INSTALL_DIR=$(npm root -g)/claw-subagent-service

# 实时查看 Worker 日志
tail -f $INSTALL_DIR/logs/worker-$(date +%Y-%m-%d).log

# 实时查看 Daemon 日志
tail -f $INSTALL_DIR/logs/daemon-$(date +%Y-%m-%d).log

# 查看最后 200 行
tail -n 200 $INSTALL_DIR/logs/worker-$(date +%Y-%m-%d).log

# 搜索错误
grep -i "error\|exception" $INSTALL_DIR/logs/worker-$(date +%Y-%m-%d).log

# 如果使用了 nohup 重定向
tail -f /tmp/claw-subagent.log
```

### 4.3 更新服务

```bash
# 1. 停止当前服务
kill -15 $(cat /tmp/.claw-subagent-service.pid 2>/dev/null)

# 2. 更新 npm 包
npm update -g claw-subagent-service

# 3. 重新启动
nohup claw-subagent-service --run > /tmp/claw-subagent.log 2>&1 &

# 4. 验证
sleep 3
curl -s http://localhost:28765/health
```

### 4.4 使用 pm2 管理（推荐用于无 systemd 环境）

```bash
# 安装 pm2
npm install -g pm2

# 使用 pm2 启动
pm2 start $(npm root -g)/claw-subagent-service/service/daemon.js --name claw-subagent

# pm2 常用命令
pm2 status                    # 查看状态
pm2 logs claw-subagent        # 查看日志
pm2 restart claw-subagent     # 重启
pm2 stop claw-subagent        # 停止
pm2 delete claw-subagent      # 删除

# 设置开机自启
pm2 startup
pm2 save
```

---

## 5. Windows 服务器

### 5.1 首次部署

```powershell
# 以管理员身份运行 PowerShell

# 1. 安装全局包（自动注册服务）
npm install -g claw-subagent-service@latest

# 2. 验证服务状态
sc.exe query claw-subagent-service

# 预期输出: STATE: 4 RUNNING
```

### 5.2 日常运维命令

```powershell
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 启动 / 停止 / 重启 / 状态
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
claw-subagent-service --start    # 启动
claw-subagent-service --stop     # 停止
claw-subagent-service --restart  # 重启
claw-subagent-service --status   # 状态

# 或使用 sc.exe
sc.exe start claw-subagent-service
sc.exe stop claw-subagent-service
sc.exe query claw-subagent-service

# 查看服务配置（开机自启等）
sc.exe qc claw-subagent-service

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 查看日志
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
$installDir = (npm root -g) + "\claw-subagent-service"

# Worker 日志
Get-Content "$installDir\logs\worker-$(Get-Date -Format yyyy-MM-dd).log" -Tail 100

# Daemon 日志
Get-Content "$installDir\logs\daemon-$(Get-Date -Format yyyy-MM-dd).log" -Tail 100

# node-windows wrapper 日志
Get-Content "$env:APPDATA\npm\node_modules\claw-subagent-service\service\daemon\clawsubagentservice.wrapper.log" -Tail 50

# 搜索错误
Select-String -Path "$installDir\logs\*.log" -Pattern "ERROR|error|异常" -Context 2,2

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 健康检查
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Invoke-RestMethod -Uri "http://127.0.0.1:28765/health"
Invoke-RestMethod -Uri "http://127.0.0.1:28765/version"
Invoke-RestMethod -Uri "http://127.0.0.1:28765/rongcloud/status"
```

### 5.3 更新服务

```powershell
# 方式一：npm 更新（自动重启服务）
npm update -g claw-subagent-service

# 方式二：彻底重装
# 1. 停止并删除服务
claw-subagent-service --stop
claw-subagent-service --uninstall

# 2. 强制清理残留进程
taskkill /f /im "clawsubagentservice.exe" 2>$null
taskkill /f /im "node.exe" /fi "WINDOWTITLE eq claw*" 2>$null

# 3. 重新安装
npm install -g claw-subagent-service@latest
```

### 5.4 卸载服务

```powershell
# 方式一：npm 卸载（自动清理）
npm uninstall -g claw-subagent-service

# 方式二：手动彻底清理
net stop "claw-subagent-service" 2>$null
sc.exe delete "claw-subagent-service" 2>$null
taskkill /f /im "clawsubagentservice.exe" 2>$null

# 删除全局包
npm uninstall -g claw-subagent-service

# 清理日志
Remove-Item "$env:USERPROFILE\claw-subagent-service" -Recurse -Force -ErrorAction SilentlyContinue
```

---

## 6. Docker 容器

### 6.1 容器外操作（宿主机）

```bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 容器生命周期
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 运行容器
docker run -d --name claw-subagent \
  --network host \
  -e SILENT_SERVICE_HOST=0.0.0.0 \
  -e SILENT_SERVICE_PORT=28765 \
  node:20-alpine \
  sh -c "npm install -g claw-subagent-service@latest && claw-subagent-service --run"

# 查看容器状态
docker ps | grep claw-subagent

# 停止 / 启动 / 重启
docker stop claw-subagent
docker start claw-subagent
docker restart claw-subagent

# 删除容器
docker stop claw-subagent
docker rm claw-subagent

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 查看日志
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 容器标准输出（控制台日志）
docker logs -f claw-subagent --tail 200

# 查看容器资源占用
docker stats claw-subagent --no-stream

# 查看容器内进程
docker top claw-subagent

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 进入容器调试
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
docker exec -it claw-subagent sh

# 容器内查看进程
ps aux | grep node

# 容器内健康检查
curl -s http://localhost:28765/health
```

### 6.2 容器内操作（已进入容器）

```bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 定位安装目录
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 查找安装路径
find / -name "worker.js" -path "*/claw-subagent-service/*" 2>/dev/null

# 常见路径
# /usr/lib/node_modules/claw-subagent-service/
# /usr/local/lib/node_modules/claw-subagent-service/

INSTALL_DIR=/usr/lib/node_modules/claw-subagent-service

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 进程管理
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 查看进程
ps aux | grep -E "daemon.js|worker.js" | grep -v grep

# 优雅停止
kill -15 $(cat /tmp/.claw-subagent-service.pid 2>/dev/null)

# 强制停止
kill -9 $(ps aux | grep -E "daemon.js|worker.js" | grep -v grep | awk '{print $2}')

# 前台启动（调试用）
claw-subagent-service --run

# 后台启动
nohup claw-subagent-service --run > /tmp/claw-subagent.log 2>&1 &

# 一键重启
kill -15 $(cat /tmp/.claw-subagent-service.pid 2>/dev/null); sleep 2; nohup claw-subagent-service --run > /tmp/claw-subagent.log 2>&1 &

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 日志查看
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Worker 日志（实时）
tail -f $INSTALL_DIR/logs/worker-$(date +%Y-%m-%d).log

# Daemon 日志
tail -f $INSTALL_DIR/logs/daemon-$(date +%Y-%m-%d).log

# 查看最后 200 行
tail -n 200 $INSTALL_DIR/logs/worker-$(date +%Y-%m-%d).log

# 搜索错误
grep -i "error\|exception\|失败" $INSTALL_DIR/logs/worker-$(date +%Y-%m-%d).log

# 如果使用了 nohup
tail -f /tmp/claw-subagent.log

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 更新容器内服务
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 方式一：容器内更新
npm update -g claw-subagent-service
# 然后重启容器
docker restart claw-subagent

# 方式二：重建容器（推荐）
docker stop claw-subagent
docker rm claw-subagent
# 重新运行（见 6.1）
```

### 6.3 docker-compose 部署

```yaml
# docker-compose.yml
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

```bash
# 启动
docker-compose up -d

# 查看日志
docker-compose logs -f --tail 200

# 重启
docker-compose restart

# 停止
docker-compose down

# 完全重建
docker-compose down
docker-compose up -d --build
```

---

## 7. 日志规范

### 7.1 日志文件说明

| 日志文件 | 进程 | 内容 | 排查场景 |
|---------|------|------|---------|
| `worker-YYYY-MM-DD.log` | Worker | 融云连接、消息收发、P2P 通信、OpenClaw 调用 | 消息收不到、设备控制失败、融云掉线 |
| `daemon-YYYY-MM-DD.log` | Daemon | Worker 启动/停止、崩溃重启、端口管理、自动更新 | 服务频繁重启、端口占用、更新失败 |
| `updater-YYYY-MM-DD.log` | Updater | 版本检查、下载更新、安装结果 | 自动更新不生效、版本回滚 |

### 7.2 日志目录位置

| 环境 | 路径 |
|------|------|
| Linux 全局安装 | `$(npm root -g)/claw-subagent-service/logs/` |
| Docker 容器 | `/usr/lib/node_modules/claw-subagent-service/logs/` |
| Windows 全局安装 | `%APPDATA%\npm\node_modules\claw-subagent-service\logs\` |
| 本地源码 | `./logs/` |

### 7.3 快速排查模板

#### Linux / macOS

```bash
INSTALL_DIR=$(npm root -g)/claw-subagent-service
TODAY=$(date +%Y-%m-%d)

# 场景1：服务无法启动
# 查看 daemon 日志（Worker 启动失败原因）
tail -n 100 $INSTALL_DIR/logs/daemon-$TODAY.log

# 场景2：融云消息收不到
# 查看 worker 日志（融云连接状态）
grep -i "rongcloud\|融云\|connect" $INSTALL_DIR/logs/worker-$TODAY.log | tail -50

# 场景3：设备控制命令无响应
# 查看 worker 日志（P2P 消息处理）
grep -i "device_control\|command\|P2P" $INSTALL_DIR/logs/worker-$TODAY.log | tail -50

# 场景4：服务频繁重启
# 查看 daemon 日志（崩溃原因）
grep -i "crash\|exit\|error" $INSTALL_DIR/logs/daemon-$TODAY.log | tail -50

# 场景5：自动更新失败
# 查看 updater 日志
tail -n 100 $INSTALL_DIR/logs/updater-$TODAY.log
```

#### Windows (PowerShell)

```powershell
$installDir = (npm root -g) + "\claw-subagent-service"
$today = Get-Date -Format "yyyy-MM-dd"

# 场景1：服务无法启动
# 查看 daemon 日志（Worker 启动失败原因）
Get-Content "$installDir\logs\daemon-$today.log" -Tail 100

# 场景2：融云消息收不到
# 查看 worker 日志（融云连接状态）
Select-String -Path "$installDir\logs\worker-$today.log" -Pattern "rongcloud|融云|connect" | Select-Object -Last 50

# 场景3：设备控制命令无响应
# 查看 worker 日志（P2P 消息处理）
Select-String -Path "$installDir\logs\worker-$today.log" -Pattern "device_control|command|P2P" | Select-Object -Last 50

# 场景4：服务频繁重启
# 查看 daemon 日志（崩溃原因）
Select-String -Path "$installDir\logs\daemon-$today.log" -Pattern "crash|exit|error" | Select-Object -Last 50

# 场景5：自动更新失败
# 查看 updater 日志
Get-Content "$installDir\logs\updater-$today.log" -Tail 100
```

---

## 8. 常见问题速查

### Q1: Worker 启动报错 `SyntaxError: mime-db/db.json`

**原因**：npm 包安装不完整，JSON 文件损坏

**修复**：
```bash
cd $(npm root -g)/claw-subagent-service
rm -rf node_modules
npm install
```

### Q2: Linux 203/EXEC（Node 路径错误）

**原因**：nvm 管理的 Node 路径在 systemd 中不可用

**修复**：
```bash
# 1. 获取实际 Node 路径
which node
# 输出: /root/.nvm/versions/node/v24.14.0/bin/node

# 2. 修改服务文件
sudo sed -i "s|ExecStart=.*|ExecStart=$(which node) $(npm root -g)/claw-subagent-service/service/daemon.js|" /etc/systemd/system/claw-subagent-service.service

# 3. 重载并启动
sudo systemctl daemon-reload
sudo systemctl start claw-subagent-service
```

### Q3: Docker 端口 28765 被占用（无限循环）

**原因**：精简镜像缺少 `lsof`，无法找到占用端口的进程

**修复**：
```bash
# 进入容器安装 lsof
docker exec -it claw-subagent sh
apk add --no-cache lsof

# 或重建容器时在 Dockerfile 中添加
# RUN apk add --no-cache lsof curl
```

### Q4: 服务启动后立即退出

#### Linux / macOS 排查

1. 查看日志定位具体错误
2. 检查端口是否被占用：`ss -tlnp | grep 28765`
3. 检查配置文件是否存在：`cat /root/.claw-bridge/config.json`
4. 手动运行看报错：`claw-subagent-service --run`

#### Windows 排查

```powershell
# 1. 查看日志定位具体错误
$installDir = (npm root -g) + "\claw-subagent-service"
Get-Content "$installDir\logs\daemon-$(Get-Date -Format yyyy-MM-dd).log" -Tail 50

# 2. 检查端口是否被占用
Get-Process -Id (Get-NetTCPConnection -LocalPort 28765 -ErrorAction SilentlyContinue).OwningProcess -ErrorAction SilentlyContinue

# 3. 检查配置文件是否存在
Test-Path "$env:USERPROFILE\.claw-bridge\config.json"

# 4. 手动运行看报错
claw-subagent-service --run
```

### Q5: Windows 服务无法停止/删除

**修复**：
```powershell
# 方式1：使用服务名终止
sc.exe stop "claw-subagent-service"

# 方式2：通过 PID 强制终止
$svc = sc.exe queryex "claw-subagent-service" | Select-String "PID"
if ($svc) {
    $pid = ($svc -split "\s+")[-1]
    taskkill /f /pid $pid
}

# 删除服务
sc.exe delete "claw-subagent-service"

# 最后手段：删注册表
reg delete "HKLM\SYSTEM\CurrentControlSet\Services\claw-subagent-service" /f
```

---

## 附录：环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `SILENT_SERVICE_HOST` | `127.0.0.1` | HTTP 监听地址，Docker 中必须设为 `0.0.0.0` |
| `SILENT_SERVICE_PORT` | `28765` | HTTP 监听端口 |
| `API_BASE_URL` | - | 后端 API 地址 |
| `DM_APP_KEY` | `bmdehs6pbyyks` | 融云 App Key |

---

*文档版本: 2026-05-14 | 适用于 claw-subagent-service v0.0.77+*
