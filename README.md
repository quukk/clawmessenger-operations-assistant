# silent-service

虾说后台服务。作为 Windows 系统服务运行，负责融云消息监听、心跳上报、自动更新。

## 使用

```bash
# 前台运行（调试用）
claw-subagent-service --run

# 安装为 Windows 系统服务（需管理员权限）
claw-subagent-service --install

# 卸载系统服务
claw-subagent-service --uninstall

# 启动服务（需先安装）
claw-subagent-service --start

# 停止服务
claw-subagent-service --stop

# 重启服务
claw-subagent-service --restart

# 查看服务状态
claw-subagent-service --status
```

## 服务生命周期

1. **安装**：`claw-subagent-service --install` — 注册为 Windows 系统服务，设置开机自启
2. **启动**：`claw-subagent-service --start` — 启动后台服务
3. **停止**：`claw-subagent-service --stop` — 停止后台服务
4. **重启**：`claw-subagent-service --restart` — 重启后台服务
5. **卸载**：`claw-subagent-service --uninstall` — 从系统服务中移除

## 端口

- 默认 HTTP 端口：`28765`（环境变量 `SILENT_SERVICE_PORT` 可覆盖）
- 健康检查：`GET http://127.0.0.1:28765/health` → `alive`
