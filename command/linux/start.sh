#!/bin/bash

# OpenClaw 服务启动脚本
# 用法: ./start.sh [选项]

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

check_service() {
    if ! systemctl --user list-unit-files "$SERVICE_NAME" &>/dev/null; then
        log_error "服务 $SERVICE_NAME 不存在。请先运行 'openclaw gateway install' 安装服务。"
        exit 1
    fi
}

wait_for_port() {
    local port=$1
    local max_wait=$2
    local elapsed=0
    
    log_info "等待端口 $port 启动（最长等待 ${max_wait} 秒）..."
    
    while [ $elapsed -lt $max_wait ]; do
        if ss -tln | grep -q ":$port "; then
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

show_help() {
    echo "OpenClaw 服务启动脚本"
    echo "用法: $0 [-h|--help]"
}

main() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            -h|--help) show_help; exit 0 ;;
            *) log_error "未知选项: $1"; exit 1 ;;
        esac
    done
    
    check_service
    
    if systemctl --user is-active --quiet "$SERVICE_NAME"; then
        log_info "OpenClaw 服务已经在运行中。"
        local port="18789"
        if ss -tln | grep -q ":$port "; then
            log_info "控制界面访问地址: http://127.0.0.1:$port/"
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
    
    local port="18789"
    
    if wait_for_port "$port" "$MAX_WAIT"; then
        log_info "OpenClaw 服务已完全启动！"
        log_info "控制界面访问地址: http://127.0.0.1:$port/"
        log_info "Success"
    else
        log_error "服务启动超时，请检查日志："
        journalctl --user -u "$SERVICE_NAME" -n 30 --no-pager
        exit 1
    fi
}

main "$@"