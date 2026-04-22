#!/bin/bash

# OpenClaw 服务停止脚本
# 用法: ./stop.sh [选项]

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

# 检查服务是否存在
check_service() {
    if ! systemctl --user list-unit-files "$SERVICE_NAME" &>/dev/null; then
        log_error "服务 $SERVICE_NAME 不存在。"
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
    while [[ $# -gt 0 ]]; do
        case $1 in
            -f|--force)
                force="--force"
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
    check_service
    
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

# 执行主函数
main "$@"