#!/bin/bash

# OpenClaw 服务停止脚本
# 用法: ./stop.sh [选项]
# 支持 systemd 和 Docker（无 systemd）双模式

# 注意：不使用 set -e，因为我们已经实现了完善的错误处理和验证逻辑
# set -e 可能导致 pgrep/pidof 找不到进程时脚本意外退出

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 日志函数
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 服务名称
SERVICE_NAME="openclaw-gateway.service"

# 检测是否在 Docker 环境（无 systemd）
# 注意：某些 Docker 镜像安装了 systemctl 命令但无法使用
# 所以同时检查 systemd 是否实际运行
is_docker() {
    # 方法1: 检查 systemctl 是否可用
    if ! command -v systemctl &>/dev/null; then
        return 0  # 无 systemctl，认为是 Docker
    fi
    
    # 方法2: 即使安装了 systemctl，检查 systemd 是否实际运行
    # 在 Docker 中，/run/systemd/system 通常不存在
    if [ ! -d "/run/systemd/system" ] && [ ! -d "/sys/fs/cgroup/systemd" ]; then
        return 0  # systemd 未运行，认为是 Docker
    fi
    
    # 方法3: 尝试执行 systemctl status，如果失败则认为是 Docker
    if ! systemctl status &>/dev/null; then
        return 0  # systemctl 无法使用，认为是 Docker
    fi
    
    return 1
}

# 端口号
PORT="18789"

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
    # 使用 pgrep/pidof/ps 查找 openclaw 进程
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

# Docker 模式：停止服务
stop_docker() {
    log_info "检查 OpenClaw 服务状态..."
    
    # 获取所有 openclaw 进程 PID
    local all_pids=""
    if command -v pgrep &>/dev/null; then
        all_pids=$(pgrep -f "openclaw" | tr '\n' ' ')
    elif command -v pidof &>/dev/null; then
        all_pids=$(pidof openclaw)
    else
        all_pids=$(ps aux | grep -v grep | grep "openclaw" | awk '{print $2}' | tr '\n' ' ')
    fi
    
    local pid
    pid=$(get_openclaw_pid)
    
    # 检查服务状态
    if [ -z "$pid" ] && [ -z "$all_pids" ]; then
        # 没有进程，检查端口
        if check_port "$PORT"; then
            log_warn "端口 $PORT 仍在监听，但无法获取 PID，尝试备选停止方案..."
            # 尝试通过 fuser 直接通过端口杀进程
            if command -v fuser &>/dev/null; then
                log_info "使用 fuser 通过端口停止服务..."
                fuser -k "${PORT}/tcp" &>/dev/null || true
                sleep 2
            fi
            # 尝试通过 pkill 停止 openclaw 相关进程
            if check_port "$PORT"; then
                log_info "使用 pkill 停止 openclaw 进程..."
                pkill -9 -f "openclaw" &>/dev/null || true
                sleep 2
            fi
        fi
        
        if ! check_port "$PORT" && [ -z "$(ps aux | grep -v grep | grep 'openclaw' | awk '{print $2}')" ]; then
            log_warn "OpenClaw 服务未在运行。"
            exit 0
        else
            log_error "OpenClaw 服务停止失败！"
            exit 1
        fi
    fi
    
    log_info "发现 OpenClaw 进程: $all_pids"
    
    # 直接发送 SIGKILL（强制停止），避免 SIGTERM 被忽略
    log_info "正在强制停止 OpenClaw 服务（SIGKILL）..."
    for p in $all_pids; do
        kill -9 "$p" 2>/dev/null || true
    done
    # 额外使用 pkill 确保所有相关进程都被停止
    pkill -9 -f "openclaw" 2>/dev/null || true
    
    # 等待进程退出（最多 3 秒）
    local elapsed=0
    while [ $elapsed -lt 3 ]; do
        # 检查是否还有 openclaw 进程
        local remaining_pids=""
        if command -v pgrep &>/dev/null; then
            remaining_pids=$(pgrep -f "openclaw" | tr '\n' ' ')
        elif command -v pidof &>/dev/null; then
            remaining_pids=$(pidof openclaw)
        else
            remaining_pids=$(ps aux | grep -v grep | grep "openclaw" | awk '{print $2}' | tr '\n' ' ')
        fi
        
        if [ -z "$remaining_pids" ]; then
            log_info "OpenClaw 服务已停止。（所有进程已退出）"
            log_info "服务已成功停止。"
            log_info "Success"
            exit 0
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done
    
    # 如果进程仍在，再次强制停止
    log_warn "进程仍在运行，再次强制停止..."
    pkill -9 -f "openclaw" 2>/dev/null || true
    killall -9 openclaw 2>/dev/null || true
    
    # 最终检查
    sleep 2
    local remaining_pids=""
    if command -v pgrep &>/dev/null; then
        remaining_pids=$(pgrep -f "openclaw" | tr '\n' ' ')
    elif command -v pidof &>/dev/null; then
        remaining_pids=$(pidof openclaw)
    else
        remaining_pids=$(ps aux | grep -v grep | grep "openclaw" | awk '{print $2}' | tr '\n' ' ')
    fi
    
    if [ -z "$remaining_pids" ]; then
        log_info "OpenClaw 服务已停止。"
        log_info "服务已成功停止。"
        log_info "Success"
        exit 0
    else
        log_error "OpenClaw 服务停止失败！进程仍然存在: $remaining_pids"
        exit 1
    fi
}

# Systemd 模式：停止服务
stop_systemd() {
    # 检查服务是否存在
    if ! systemctl --user list-unit-files "$SERVICE_NAME" &>/dev/null; then
        log_error "服务 $SERVICE_NAME 不存在。"
        exit 1
    fi
    
    # 检查服务状态
    log_info "检查 OpenClaw 服务状态..."
    if systemctl --user is-active --quiet "$SERVICE_NAME"; then
        log_info "OpenClaw 服务正在运行，准备停止..."
    else
        log_warn "OpenClaw 服务未在运行。"
        exit 0
    fi
    
    # 停止服务
    log_info "正在停止 OpenClaw 服务..."
    
    if systemctl --user stop "$SERVICE_NAME"; then
        log_info "OpenClaw 服务停止成功！"

        # 等待服务完全停止
        sleep 2
        
        # 验证服务状态
        if systemctl --user is-active --quiet "$SERVICE_NAME"; then
            log_warn "服务可能仍在运行，请检查进程。"
            systemctl --user status "$SERVICE_NAME" --no-pager
        else
            log_info "服务已成功停止。"
            log_info "Success"
        fi
    else
        log_error "OpenClaw 服务停止失败！"
        exit 1
    fi
}

# 显示帮助信息
show_help() {
    echo "OpenClaw 服务停止脚本"
    echo ""
    echo "用法: $0 [选项]"
    echo ""
    echo "选项:"
    echo "  -f, --force         强制停止服务"
    echo "  -h, --help          显示此帮助信息"
    echo ""
    echo "示例:"
    echo "  $0                  正常停止服务"
    echo "  $0 -f               强制停止服务"
}

# 主函数
main() {
    local force=""
    
    # 解析命令行参数
    while [ $# -gt 0 ]; do
        case $1 in
            -f|--force)
                force="1"
                shift
                ;;
            -h|--help)
                show_help
                exit 0
                ;;
            *)
                log_error "未知选项: $1"
                show_help
                exit 1
                ;;
        esac
    done
    
    if is_docker; then
        stop_docker
    else
        stop_systemd
    fi
}

# 执行主函数
main "$@"
