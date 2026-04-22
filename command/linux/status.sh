#!/bin/bash

# OpenClaw 服务状态查看脚本
# 用法: ./status.sh [选项]

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
    while [[ $# -gt 0 ]]; do
        case $1 in
            -q|--quiet)
                quiet="true"
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
    
    # 检查服务是否存在
    if ! systemctl --user list-unit-files "$SERVICE_NAME" &>/dev/null; then
        if [[ -n "$quiet" ]]; then
            echo "not_installed"
        else
            log_error "服务 $SERVICE_NAME 未安装。"
        fi
        exit 1
    fi
    
    # 如果是静默模式
    if [[ -n "$quiet" ]]; then
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
    if [[ -d "$HOME/.openclaw" ]]; then
        log_info "配置目录: $HOME/.openclaw"
        if [[ -f "$HOME/.openclaw/openclaw.json" ]]; then
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
    local port="18789"
    if [[ -f "$HOME/.openclaw/openclaw.json" ]] && command -v jq &> /dev/null; then
        local config_port=$(jq -r '.gateway.port // empty' "$HOME/.openclaw/openclaw.json" 2>/dev/null)
        if [[ -n "$config_port" ]]; then
            port="$config_port"
        fi
    fi
    
    log_info "默认访问地址: http://127.0.0.1:$port/"
    log_info "WebSocket 地址: ws://127.0.0.1:$port"
}

# 执行主函数
main "$@"