#!/bin/bash

# OpenClaw 服务停止脚本
# 用法: ./stop.sh [选项]
# 支持 systemd 和 Docker（无 systemd）双模式

set -e

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
is_docker() {
    if ! command -v systemctl &>/dev/null; then
        return 0  # 无 systemctl，认为是 Docker
    fi
    return 1
}

# 端口号
PORT="18789"

# 检查端口是否监听
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
    else
        # 最后降级：直接检查进程
        [ -n "$(get_openclaw_pid)" ]
        return $?
    fi
}

# 获取 openclaw 进程 PID
get_openclaw_pid() {
    local port=18789
    local pid=""
    
    # 按优先级尝试多种工具（适配精简 Docker 镜像）
    if command -v lsof &>/dev/null; then
        pid=$(lsof -i :${port} -t 2>/dev/null | head -1)
        if [ -n "$pid" ]; then
            echo "$pid"
            return
        fi
    fi
    
    if command -v fuser &>/dev/null; then
        pid=$(fuser ${port}/tcp 2>/dev/null | tr -d ' ')
        if [ -n "$pid" ]; then
            echo "$pid"
            return
        fi
    fi
    
    if command -v ss &>/dev/null; then
        pid=$(ss -tlnp 2>/dev/null | grep ":${port} " | head -1 | sed -n 's/.*pid=\\([0-9]*\\).*/\\1/p')
        if [ -n "$pid" ]; then
            echo "$pid"
            return
        fi
    fi
    
    if command -v netstat &>/dev/null; then
        pid=$(netstat -tnlp 2>/dev/null | grep ":${port} " | head -1 | awk '{print $7}' | cut -d'/' -f1)
        if [ -n "$pid" ]; then
            echo "$pid"
            return
        fi
    fi
    
    # 最后尝试 /proc 文件系统（最可靠，无需外部工具）
    for proc_dir in /proc/[0-9]*; do
        if [ -d "$proc_dir/fd" ]; then
            for fd in $proc_dir/fd/*; do
                if [ -L "$fd" ]; then
                    local target
                    target=$(readlink "$fd" 2>/dev/null)
                    if [ -n "$target" ] && echo "$target" | grep -q ":${port}"; then
                        basename "$proc_dir"
                        return
                    fi
                fi
            done
        fi
    done
    
    echo ""
}

# Docker 模式：停止服务
stop_docker() {
    local pid
    pid=$(get_openclaw_pid)
    
    # 检查服务状态
    log_info "检查 OpenClaw 服务状态..."
    if [ -z "$pid" ]; then
        log_warn "OpenClaw 服务未在运行。"
        exit 0
    fi
    
    log_info "OpenClaw 服务正在运行（PID: $pid），准备停止..."
    
    # 停止服务：先发送 SIGTERM（优雅停止）
    log_info "正在停止 OpenClaw 服务..."
    kill "$pid" &>/dev/null || true
    
    # 等待服务完全停止（最多 10 秒）
    local elapsed=0
    while [ $elapsed -lt 10 ]; do
        if [ -z "$(get_openclaw_pid)" ]; then
            log_info "OpenClaw 服务停止成功！"
            log_info "服务已成功停止。"
            log_info "Success"
            exit 0
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done
    
    # 如果还在运行，强制停止（SIGKILL）
    log_warn "服务未在 10 秒内停止，正在强制停止..."
    kill -9 "$pid" &>/dev/null || true
    
    # 等待进程消失（最多 3 秒）
    elapsed=0
    while [ $elapsed -lt 3 ]; do
        if [ -z "$(get_openclaw_pid)" ]; then
            break
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done
    
    # 验证：进程不存在或端口已关闭即为成功
    # 使用端口检测作为辅助，避免僵尸进程导致误判
    local current_pid
    current_pid=$(get_openclaw_pid)
    if [ -z "$current_pid" ]; then
        log_info "OpenClaw 服务已强制停止。"
        log_info "服务已成功停止。"
        log_info "Success"
    elif ! check_port "$PORT"; then
        # 端口已关闭但进程可能还在（僵尸状态），也认为成功
        log_info "OpenClaw 服务已停止（端口已关闭）。"
        log_info "服务已成功停止。"
        log_info "Success"
    else
        log_error "OpenClaw 服务停止失败！进程仍然存在且端口仍在监听。"
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
