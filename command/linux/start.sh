#!/bin/bash

# OpenClaw 服务启动脚本
# 用法: ./start.sh [选项]
# 支持 systemd 和 Docker（无 systemd）双模式

set -e

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
is_docker() {
    if ! command -v systemctl &>/dev/null; then
        return 0  # 无 systemctl，认为是 Docker
    fi
    return 1
}

# 获取 openclaw 进程 PID
get_openclaw_pid() {
    # 优先通过端口查找进程（最可靠）
    if command -v netstat &>/dev/null; then
        local pid
        pid=$(netstat -tnlp 2>/dev/null | grep ":18789 " | head -1 | awk '{print $7}' | cut -d'/' -f1)
        if [ -n "$pid" ]; then
            echo "$pid"
            return
        fi
    fi
    
    # 降级：通过进程名查找
    pgrep openclaw | head -1 || echo ""
}

# 检查端口是否监听
check_port() {
    local port=$1
    if command -v ss &>/dev/null; then
        ss -tln | grep -q ":$port "
    elif command -v netstat &>/dev/null; then
        netstat -tln | grep -q ":$port "
    else
        # 降级：直接检查进程
        [ -n "$(get_openclaw_pid)" ]
    fi
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
        log_info "OpenClaw 服务已经在运行中。"
        if check_port "$PORT"; then
            log_info "控制界面访问地址: http://127.0.0.1:$PORT/"
        fi
        log_info "Success"
        exit 0
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
    
    # 使用 nohup 后台启动
    nohup openclaw gateway --port "$PORT" > "$log_file" 2>&1 &
    
    log_info "OpenClaw 服务启动命令已发送（PID: $!）"
    log_info "日志文件: $log_file"
    
    # 等待端口就绪
    if wait_for_port "$PORT" "$MAX_WAIT"; then
        log_info "OpenClaw 服务已完全启动！"
        log_info "控制界面访问地址: http://127.0.0.1:$PORT/"
        log_info "Success"
    else
        log_error "服务启动超时，请检查日志：$log_file"
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
