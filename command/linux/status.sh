#!/bin/bash

# OpenClaw 服务状态查看脚本
# 用法: ./status.sh [选项]
# 支持 systemd 和 Docker（无 systemd）双模式

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
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

log_header() {
    echo -e "${BLUE}=== $1 ===${NC}"
}

# 服务名称
SERVICE_NAME="openclaw-gateway.service"
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

# Docker 模式：查看状态
status_docker() {
    local quiet="$1"
    local pid
    pid=$(get_openclaw_pid)
    
    # 静默模式
    if [ "$quiet" = "1" ]; then
        if [ -n "$pid" ]; then
            echo "running"
        else
            echo "stopped"
        fi
        exit 0
    fi
    
    # 详细模式：模拟 systemctl 输出格式
    log_header "OpenClaw 服务状态"
    echo
    log_info "服务状态:"
    
    if [ -n "$pid" ]; then
        # 运行中：模拟 systemctl 的 active (running) 格式
        echo "● openclaw-gateway.service - OpenClaw Gateway"
        echo "     Loaded: loaded (Docker 模式)"
        echo "     Active: active (running)"
        echo "   Main PID: $pid (openclaw-gateway)"
        echo ""
        log_info "Success"
    else
        # 未运行：模拟 systemctl 的 inactive (dead) 格式
        echo "○ openclaw-gateway.service - OpenClaw Gateway"
        echo "     Loaded: loaded (Docker 模式)"
        echo "     Active: inactive (dead)"
        echo ""
        log_info "未启动"
    fi
    
    echo
    log_header "配置信息"
    
    # 显示配置目录
    if [ -d "$HOME/.openclaw" ]; then
        log_info "配置目录: $HOME/.openclaw"
        if [ -f "$HOME/.openclaw/openclaw.json" ]; then
            log_info "配置文件: 存在"
        else
            log_warn "配置文件: 不存在"
        fi
    else
        log_warn "配置目录不存在"
    fi
    
    echo
    log_header "访问信息"
    
    # 尝试从配置中读取端口
    local port="$PORT"
    if [ -f "$HOME/.openclaw/openclaw.json" ] && command -v jq &>/dev/null; then
        local config_port
        config_port=$(jq -r '.gateway.port // empty' "$HOME/.openclaw/openclaw.json" 2>/dev/null || echo "")
        if [ -n "$config_port" ]; then
            port="$config_port"
        fi
    fi
    
    log_info "默认访问地址: http://127.0.0.1:$port/"
    log_info "WebSocket 地址: ws://127.0.0.1:$port"
}

# Systemd 模式：查看状态
status_systemd() {
    local quiet="$1"
    
    # 检查服务是否存在
    if ! systemctl --user list-unit-files "$SERVICE_NAME" &>/dev/null; then
        if [ "$quiet" = "1" ]; then
            echo "not_installed"
        else
            log_error "服务 $SERVICE_NAME 未安装。"
        fi
        exit 1
    fi
    
    # 静默模式
    if [ "$quiet" = "1" ]; then
        if systemctl --user is-active --quiet "$SERVICE_NAME"; then
            echo "running"
        else
            echo "stopped"
        fi
        exit 0
    fi
    
    # 显示详细状态
    log_header "OpenClaw 服务状态"

    echo
    log_info "服务状态:"
    systemctl --user status "$SERVICE_NAME" --no-pager || true

    # 检查服务是否运行
    echo
    if systemctl --user status "$SERVICE_NAME" --no-pager | grep -q "active (running)"; then
        log_info "Success"
    else
        log_info "未启动"
    fi
    
    echo
    log_header "配置信息"
    
    # 显示配置目录
    if [ -d "$HOME/.openclaw" ]; then
        log_info "配置目录: $HOME/.openclaw"
        if [ -f "$HOME/.openclaw/openclaw.json" ]; then
            log_info "配置文件: 存在"
        else
            log_warn "配置文件: 不存在"
        fi
    else
        log_warn "配置目录不存在"
    fi
    
    echo
    log_header "访问信息"
    
    # 尝试从配置中读取端口
    local port="$PORT"
    if [ -f "$HOME/.openclaw/openclaw.json" ] && command -v jq &>/dev/null; then
        local config_port
        config_port=$(jq -r '.gateway.port // empty' "$HOME/.openclaw/openclaw.json" 2>/dev/null || echo "")
        if [ -n "$config_port" ]; then
            port="$config_port"
        fi
    fi
    
    log_info "默认访问地址: http://127.0.0.1:$port/"
    log_info "WebSocket 地址: ws://127.0.0.1:$port"
}

# 显示帮助信息
show_help() {
    echo "OpenClaw 服务状态查看脚本"
    echo ""
    echo "用法: $0 [选项]"
    echo ""
    echo "选项:"
    echo "  -q, --quiet         静默模式（只输出 running/stopped）"
    echo "  -h, --help          显示此帮助信息"
    echo ""
    echo "示例:"
    echo "  $0                  显示详细状态"
    echo "  $0 -q               只输出状态"
}

# 主函数
main() {
    local quiet=""
    
    # 解析命令行参数
    while [ $# -gt 0 ]; do
        case $1 in
            -q|--quiet)
                quiet="1"
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
        status_docker "$quiet"
    else
        status_systemd "$quiet"
    fi
}

# 执行主函数
main "$@"
