#!/bin/bash

# OpenClaw 服务重启脚本
# 用法: ./restart.sh [选项]
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

# Docker 模式：重启服务
restart_docker() {
    # 检查当前状态
    log_info "当前 OpenClaw 服务状态:"
    local pid
    pid=$(get_openclaw_pid)
    if [ -n "$pid" ]; then
        log_info "服务正在运行（PID: $pid）"
    else
        log_warn "服务未运行"
    fi
    
    # 如果正在运行，先停止（包括进程存在但端口未监听的情况）
    if [ -n "$pid" ] || check_port "$PORT"; then
        log_info "正在停止 OpenClaw 服务..."
        
        # 第一步：优雅停止所有 openclaw 进程
        log_info "发送 SIGTERM 到所有 openclaw 进程..."
        pkill -15 -f "openclaw" &>/dev/null || true
        sleep 3
        
        # 第二步：检查是否还有进程在运行
        local remaining_pids=""
        if command -v pgrep &>/dev/null; then
            remaining_pids=$(pgrep -f "openclaw" | tr '\n' ' ')
        fi
        
        if [ -n "$remaining_pids" ]; then
            log_warn "进程仍在运行: $remaining_pids，发送 SIGKILL..."
            pkill -9 -f "openclaw" &>/dev/null || true
            sleep 3
        fi
        
        # 第三步：连续监控，确保所有进程都停止（防止看门狗重启）
        log_info "进入连续监控模式，确保进程完全停止..."
        local elapsed=0
        local consecutive_empty=0
        while [ $elapsed -lt 15 ]; do
            sleep 1
            
            local current_pids=""
            if command -v pgrep &>/dev/null; then
                current_pids=$(pgrep -f "openclaw" | tr '\n' ' ')
            fi
            
            if [ -z "$current_pids" ] && ! check_port "$PORT"; then
                consecutive_empty=$((consecutive_empty + 1))
                log_info "第 $elapsed 秒: 无进程且端口未监听（连续 $consecutive_empty 次）"
                if [ $consecutive_empty -ge 3 ]; then
                    log_info "服务已完全停止"
                    break
                fi
            else
                consecutive_empty=0
                if [ -n "$current_pids" ]; then
                    log_warn "第 $elapsed 秒: 发现进程 $current_pids，再次 kill..."
                    pkill -9 -f "openclaw" &>/dev/null || true
                fi
                if check_port "$PORT"; then
                    log_warn "第 $elapsed 秒: 端口仍在监听，使用 fuser..."
                    if command -v fuser &>/dev/null; then
                        fuser -k "${PORT}/tcp" &>/dev/null || true
                    fi
                fi
            fi
            
            elapsed=$((elapsed + 1))
        done
        
        # 最终验证
        local final_pids=""
        if command -v pgrep &>/dev/null; then
            final_pids=$(pgrep -f "openclaw" | tr '\n' ' ')
        fi
        
        if [ -n "$final_pids" ] || check_port "$PORT"; then
            log_error "OpenClaw 服务停止失败！进程或端口仍在运行。"
            log_error "剩余进程: $final_pids"
            exit 1
        fi
        
        log_info "服务已停止"
    fi
    
    # 检查 openclaw 命令是否存在
    if ! command -v openclaw &>/dev/null; then
        log_error "openclaw 命令未找到，请先安装 OpenClaw。"
        exit 1
    fi
    
    # 确保日志目录存在
    local log_dir="/tmp/openclaw"
    mkdir -p "$log_dir"
    
    # 生成日志文件路径
    local log_file="$log_dir/openclaw-$(date +%Y-%m-%d).log"
    
    log_info "正在启动 OpenClaw 服务..."
    
    # 使用 setsid 创建新会话，完全脱离父进程
    # 这样即使父进程（Node.js）退出，openclaw 也不会被终止
    log_info "使用 setsid 启动，确保进程脱离父进程..."
    if command -v setsid &>/dev/null; then
        setsid bash -c "openclaw gateway run --port $PORT" > "$log_file" 2>&1 &
    else
        # 如果没有 setsid，使用 nohup 作为后备
        log_warn "setsid 不可用，使用 nohup 作为后备..."
        nohup openclaw gateway run --port "$PORT" > "$log_file" 2>&1 &
    fi
    
    log_info "OpenClaw 服务启动命令已发送（PID: $!）"
    log_info "日志文件: $log_file"
    
    # 等待端口就绪
    if wait_for_port "$PORT" "$MAX_WAIT"; then
        log_info "OpenClaw 服务已完全重启！"
        log_info "控制界面访问地址: http://127.0.0.1:$PORT/"
        log_info "Success"
    else
        log_error "服务重启超时，请检查日志：$log_file"
        exit 1
    fi
}

# Systemd 模式：重启服务
restart_systemd() {
    check_service
    
    log_info "当前 OpenClaw 服务状态:"
    if systemctl --user is-active --quiet "$SERVICE_NAME"; then
        log_info "服务正在运行"
    else
        log_warn "服务未运行"
    fi
    
    log_info "正在重启 OpenClaw 服务..."
    
    if systemctl --user restart "$SERVICE_NAME"; then
        log_info "OpenClaw 服务重启命令执行完成！"
    else
        log_error "OpenClaw 服务重启失败！"
        journalctl --user -u "$SERVICE_NAME" -n 20 --no-pager
        exit 1
    fi
    
    if wait_for_port "$PORT" "$MAX_WAIT"; then
        log_info "OpenClaw 服务已完全重启！"
        log_info "控制界面访问地址: http://127.0.0.1:$PORT/"
        log_info "Success"
    else
        log_error "服务重启超时，请检查日志："
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
    echo "OpenClaw 服务重启脚本"
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
        restart_docker
    else
        restart_systemd
    fi
}

main "$@"
