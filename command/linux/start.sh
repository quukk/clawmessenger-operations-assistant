#!/bin/bash

# OpenClaw 服务启动脚本
# 用法: ./start.sh [选项]
# 支持 systemd 和 Docker（无 systemd）双模式

# 注意：不使用 set -e，因为我们已经实现了完善的错误处理和验证逻辑
# set -e 可能导致 pgrep/pidof 找不到进程时脚本意外退出

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# 调试模式：如果 DEBUG=1，输出更多日志
DEBUG="${DEBUG:-0}"
debug_log() {
    if [ "$DEBUG" = "1" ]; then
        echo -e "${YELLOW}[DEBUG]${NC} $1"
    fi
}

SERVICE_NAME="openclaw-gateway.service"
MAX_WAIT=300  # 最长等待5分钟
PORT="18789"

# 检测是否在 Docker 环境（无 systemd）
# 注意：某些 Docker 镜像安装了 systemctl 命令但无法使用
# 所以同时检查 systemd 是否实际运行
is_docker() {
    # 方法1: 检查 systemctl 是否可用
    if ! command -v systemctl &>/dev/null; then
        return 0  # 无 systemctl，认为是 Docker
    fi
    
    # 方法2: 即使安装了 systemctl，检查 systemd 是否实际运行
    if [ ! -d "/run/systemd/system" ] && [ ! -d "/sys/fs/cgroup/systemd" ]; then
        return 0  # systemd 未运行，认为是 Docker
    fi
    
    # 方法3: 尝试执行 systemctl status，如果失败则认为是 Docker
    if ! systemctl status &>/dev/null; then
        return 0  # systemctl 无法使用，认为是 Docker
    fi
    
    return 1
}

# 获取 openclaw 进程 PID
get_openclaw_pid() {
    local port=18789
    local pid=""
    
    # 按优先级尝试多种工具（适配精简 Docker 镜像）
    # 方法1: lsof（最可靠）
    if command -v lsof &>/dev/null; then
        pid=$(lsof -i :${port} -t 2>/dev/null | head -1)
        if [ -n "$pid" ]; then
            echo "$pid"
            return
        fi
    fi
    
    # 方法2: fuser
    if command -v fuser &>/dev/null; then
        pid=$(fuser ${port}/tcp 2>/dev/null | tr -d ' ')
        if [ -n "$pid" ]; then
            echo "$pid"
            return
        fi
    fi
    
    # 方法3: ss
    if command -v ss &>/dev/null; then
        pid=$(ss -tlnp 2>/dev/null | grep ":${port} " | head -1 | sed -n 's/.*pid=\([0-9]*\).*/\1/p')
        if [ -n "$pid" ]; then
            echo "$pid"
            return
        fi
    fi
    
    # 方法4: netstat
    if command -v netstat &>/dev/null; then
        pid=$(netstat -tnlp 2>/dev/null | grep ":${port} " | head -1 | awk '{print $7}' | cut -d'/' -f1)
        if [ -n "$pid" ]; then
            echo "$pid"
            return
        fi
    fi
    
    # 方法5: 通过 /proc/net/tcp 查找（不需要外部工具）
    # 端口 18789 的十六进制 = 0x4965
    local hex_port="4965"
    for proc_dir in /proc/[0-9]*; do
        if [ -f "$proc_dir/net/tcp" ]; then
            # 检查该进程是否监听目标端口
            if grep -q "[^0-9a-fA-F]${hex_port} " "$proc_dir/net/tcp" 2>/dev/null; then
                basename "$proc_dir"
                return
            fi
        fi
    done
    
    # 方法6: 通过进程名查找（当服务未监听预期端口时）
    if command -v pgrep &>/dev/null; then
        pid=$(pgrep -f "openclaw" | head -1)
        if [ -n "$pid" ]; then
            echo "$pid"
            return
        fi
    fi
    
    if command -v pidof &>/dev/null; then
        pid=$(pidof openclaw | awk '{print $1}')
        if [ -n "$pid" ]; then
            echo "$pid"
            return
        fi
    fi
    
    # 最后尝试 ps
    pid=$(ps aux | grep -v grep | grep "openclaw" | head -1 | awk '{print $2}')
    if [ -n "$pid" ]; then
        echo "$pid"
        return
    fi
    
    echo ""
}

# 检查端口是否监听
# 注意：只检查端口，不检查进程。进程存在不等于端口在监听。
check_port() {
    local port=$1
    if command -v ss &>/dev/null; then
        ss -tln 2>/dev/null | grep -q ":$port "
        return $?
    elif command -v netstat &>/dev/null; then
        netstat -tln 2>/dev/null | grep -q ":$port "
        return $?
    elif command -v lsof &>/dev/null; then
        lsof -i :$port 2>/dev/null | grep -q LISTEN
        return $?
    elif command -v fuser &>/dev/null; then
        fuser $port/tcp 2>/dev/null | grep -q '[0-9]'
        return $?
    fi
    # 如果所有工具都不可用，无法准确检查端口，保守返回 1（端口未监听）
    return 1
}

# 等待端口启动
wait_for_port() {
    local port=$1
    local max_wait=$2
    local elapsed=0
    
    log_info "等待端口 $port 启动（最长等待 ${max_wait} 秒）..."
    
    while [ $elapsed -lt $max_wait ]; do
        if check_port "$port"; then
            log_info "端口 $port 已就绪！（等待了 ${elapsed} 秒）"
            return 0
        fi
        sleep 2
        elapsed=$((elapsed + 2))
        
        # 每10秒输出一次进度
        if [ $((elapsed % 10)) -eq 0 ]; then
            log_info "已等待 ${elapsed} 秒，继续等待端口启动..."
        fi
    done
    
    log_error "等待端口 $port 超时（${max_wait} 秒）！"
    return 1
}

# Docker 模式：启动服务
start_docker() {
    # 检查是否已在运行
    local pid
    pid=$(get_openclaw_pid)
    if [ -n "$pid" ]; then
        log_info "检测到 openclaw 进程 (PID: $pid)"
        if check_port "$PORT"; then
            log_info "OpenClaw 服务已经在运行中。"
            log_info "控制界面访问地址: http://127.0.0.1:$PORT/"
            log_info "Success"
            exit 0
        else
            log_warn "进程存在但端口 $PORT 未监听，进程可能未正确启动或已崩溃"
            log_warn "将停止现有进程并重新启动..."
            # 停止现有进程
            kill -15 "$pid" 2>/dev/null || true
            sleep 2
            # 检查是否还在运行
            if ps -p "$pid" > /dev/null 2>&1; then
                log_warn "进程仍在运行，强制停止..."
                kill -9 "$pid" 2>/dev/null || true
                sleep 1
            fi
        fi
    fi
    
    # 检查 openclaw 命令是否存在
    debug_log "检查 openclaw 命令..."
    if ! command -v openclaw &>/dev/null; then
        log_error "openclaw 命令未找到，请先安装 OpenClaw。"
        log_error "PATH: $PATH"
        exit 1
    fi
    debug_log "openclaw 命令存在: $(which openclaw)"
    
    # 确保日志目录存在
    local log_dir="/tmp/openclaw"
    mkdir -p "$log_dir"
    
    # 生成日志文件路径
    local log_file="$log_dir/openclaw-$(date +%Y-%m-%d).log"
    
    log_info "正在启动 OpenClaw 服务..."
    
    # 使用 nohup 后台启动，指定 host 为 0.0.0.0（Docker 环境需要）
    # 注意：openclaw gateway 可能需要不同的参数格式
    log_info "执行命令: nohup openclaw gateway --port $PORT --host 0.0.0.0"
    debug_log "当前工作目录: $(pwd)"
    debug_log "当前用户: $(whoami)"
    debug_log "环境变量 PATH: $PATH"
    
    # 先检查 openclaw 版本
    debug_log "openclaw 版本信息:"
    openclaw --version 2>&1 | head -5 || true
    
    # 检查 openclaw gateway help，确认参数格式
    debug_log "openclaw gateway help 信息:"
    openclaw gateway --help 2>&1 | head -20 || true
    
    # 尝试启动，如果失败则尝试其他参数格式
    log_info "尝试启动 openclaw gateway..."
    
    # 先尝试查看 openclaw gateway 的帮助信息，确认正确的参数格式
    log_info "检查 openclaw gateway 支持的参数..."
    openclaw gateway --help > /tmp/openclaw-help.txt 2>&1 || true
    if [ -f /tmp/openclaw-help.txt ]; then
        log_info "openclaw gateway help 输出:"
        cat /tmp/openclaw-help.txt | head -30
    fi
    
    # 检查 openclaw gateway run --help，确认 run 子命令的参数
    log_info "检查 openclaw gateway run --help..."
    openclaw gateway run --help > /tmp/openclaw-run-help.txt 2>&1 || true
    if [ -f /tmp/openclaw-run-help.txt ]; then
        log_info "openclaw gateway run help 输出:"
        cat /tmp/openclaw-run-help.txt | head -30
    fi
    
    # 先停止所有已有的 openclaw 进程，避免端口冲突
    log_info "检查并停止已有的 openclaw 进程..."
    local existing_pids=""
    if command -v pgrep &>/dev/null; then
        existing_pids=$(pgrep -f "openclaw" | tr '\n' ' ')
    elif command -v pidof &>/dev/null; then
        existing_pids=$(pidof openclaw)
    else
        existing_pids=$(ps aux | grep -v grep | grep "openclaw" | awk '{print $2}' | tr '\n' ' ')
    fi
    
    if [ -n "$existing_pids" ]; then
        log_warn "发现已有 openclaw 进程: $existing_pids，先停止它们..."
        for ep in $existing_pids; do
            log_info "停止进程 $ep..."
            kill -15 "$ep" 2>/dev/null || true
        done
        # 等待 3 秒让进程优雅退出
        sleep 3
        # 检查是否还有残留进程，如果有则强制停止
        local remaining_pids=""
        if command -v pgrep &>/dev/null; then
            remaining_pids=$(pgrep -f "openclaw" | tr '\n' ' ')
        fi
        if [ -n "$remaining_pids" ]; then
            log_warn "强制停止残留进程: $remaining_pids"
            for rp in $remaining_pids; do
                kill -9 "$rp" 2>/dev/null || true
            done
            sleep 1
        fi
    fi
    
    # 确保端口未被占用
    if command -v fuser &>/dev/null; then
        fuser -k "${PORT}/tcp" 2>/dev/null || true
    fi
    
    # 查找 openclaw 的完整路径
    local openclaw_path=""
    if command -v openclaw &>/dev/null; then
        openclaw_path=$(which openclaw)
        log_info "找到 openclaw: $openclaw_path"
    else
        # 尝试常见路径
        for path in /usr/local/bin/openclaw /usr/bin/openclaw /opt/openclaw/bin/openclaw; do
            if [ -x "$path" ]; then
                openclaw_path="$path"
                log_info "找到 openclaw: $openclaw_path"
                break
            fi
        done
    fi
    
    if [ -z "$openclaw_path" ]; then
        log_error "无法找到 openclaw 命令，请确保已安装 OpenClaw"
        exit 1
    fi
    
    # 尝试使用正确的参数启动
    # 注意：openclaw gateway 可能使用不同的参数名
    log_info "尝试启动: $openclaw_path gateway run --port $PORT"
    
    # 使用 setsid 创建新会话，完全脱离父进程
    # 这样即使父进程（Node.js）退出，openclaw 也不会被终止
    log_info "使用 setsid 启动，确保进程脱离父进程..."
    if command -v setsid &>/dev/null; then
        setsid bash -c "export PATH='$PATH'; $openclaw_path gateway run --port $PORT" > "$log_file" 2>&1 &
    else
        # 如果没有 setsid，使用 nohup 作为后备
        log_warn "setsid 不可用，使用 nohup 作为后备..."
        nohup bash -c "export PATH='$PATH'; $openclaw_path gateway run --port $PORT" > "$log_file" 2>&1 &
    fi
    local started_pid=$!
    log_info "启动的进程 PID: $started_pid"
    
    # 等待 15 秒检查进程是否启动（给更多时间初始化）
    sleep 15
    
    # 检查进程是否存在
    if ! ps -p "$started_pid" > /dev/null 2>&1; then
        log_warn "进程 $started_pid 已退出，检查日志..."
        if [ -f "$log_file" ]; then
            log_warn "openclaw 日志内容:"
            cat "$log_file" | tail -20
        fi
        log_error "启动失败，请检查日志：$log_file"
        exit 1
    fi
    
    log_info "进程 $started_pid 正在运行"
    
    # 检查进程监听的端口
    log_info "检查进程监听的端口..."
    sleep 5
    local listening_ports=$(netstat -tlnp 2>/dev/null | grep "$started_pid" || ss -tlnp 2>/dev/null | grep "$started_pid" || echo "")
    if [ -n "$listening_ports" ]; then
        log_info "进程 $started_pid 监听的端口:"
        echo "$listening_ports"
    else
        log_warn "进程 $started_pid 未监听任何端口，检查是否有子进程..."
        # 检查子进程
        local child_pids=$(pgrep -P "$started_pid" 2>/dev/null || echo "")
        if [ -n "$child_pids" ]; then
            log_info "发现子进程: $child_pids"
            for child_pid in $child_pids; do
                local child_ports=$(netstat -tlnp 2>/dev/null | grep "$child_pid" || ss -tlnp 2>/dev/null | grep "$child_pid" || echo "")
                if [ -n "$child_ports" ]; then
                    log_info "子进程 $child_pid 监听的端口:"
                    echo "$child_ports"
                fi
            done
        fi
    fi
    
    log_info "OpenClaw 服务启动命令已发送（PID: $started_pid）"
    log_info "日志文件: $log_file"
    
    # 等待端口就绪
    if wait_for_port "$PORT" "$MAX_WAIT"; then
        log_info "OpenClaw 服务已完全启动！"
        log_info "控制界面访问地址: http://127.0.0.1:$PORT/"
        log_info "Success"
    else
        log_error "服务启动超时，请检查日志：$log_file"
        log_info "openclaw 进程状态:"
        ps aux | grep -v grep | grep openclaw || true
        log_info "端口监听状态:"
        netstat -tlnp 2>/dev/null | grep openclaw || ss -tlnp 2>/dev/null | grep openclaw || true
        exit 1
    fi
}

# Systemd 模式：启动服务
start_systemd() {
    check_service
    
    if systemctl --user is-active --quiet "$SERVICE_NAME"; then
        log_info "OpenClaw 服务已经在运行中。"
        if check_port "$PORT"; then
            log_info "控制界面访问地址: http://127.0.0.1:$PORT/"
        fi
        log_info "Success"
        exit 0
    fi
    
    log_info "正在启动 OpenClaw 服务..."
    
    if systemctl --user start "$SERVICE_NAME"; then
        log_info "OpenClaw 服务启动命令执行完成！"
    else
        log_error "OpenClaw 服务启动失败！"
        journalctl --user -u "$SERVICE_NAME" -n 20 --no-pager
        exit 1
    fi
    
    if wait_for_port "$PORT" "$MAX_WAIT"; then
        log_info "OpenClaw 服务已完全启动！"
        log_info "控制界面访问地址: http://127.0.0.1:$PORT/"
        log_info "Success"
    else
        log_error "服务启动超时，请检查日志："
        journalctl --user -u "$SERVICE_NAME" -n 30 --no-pager
        exit 1
    fi
}

# 检查 systemd 服务是否存在
check_service() {
    if ! systemctl --user list-unit-files "$SERVICE_NAME" &>/dev/null; then
        log_error "服务 $SERVICE_NAME 不存在。请先运行 'openclaw gateway install' 安装服务。"
        exit 1
    fi
}

show_help() {
    echo "OpenClaw 服务启动脚本"
    echo "用法: $0 [-h|--help]"
}

main() {
    while [ $# -gt 0 ]; do
        case $1 in
            -h|--help) show_help; exit 0 ;;
            *) log_error "未知选项: $1"; exit 1 ;;
        esac
    done
    
    if is_docker; then
        start_docker
    else
        start_systemd
    fi
}

main "$@"
