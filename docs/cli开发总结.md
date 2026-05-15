# cli项目架构

## 1. 项目概述

`nodejs_cli_client` 是一个静默后台服务（Silent Background Service），用于设备管理、自动启动、崩溃恢复、RongCloud 即时通讯（IM）以及与 OpenClaw AI 服务的集成。

### 1.1 项目定位
- **运行模式**：作为系统服务在后台持续运行（Windows 服务 / Linux systemd / macOS launchd）
- **核心功能**：接收远程指令、执行命令、上报设备状态、AI 聊天交互

### 1.2 技术栈
- **运行时**：Node.js（纯 JavaScript，无 Electron 依赖）
- **通信协议**：RongCloud IM（融云即时通讯）
- **进程架构**：Daemon（守护进程）+ Worker（业务进程）双进程模型
- **AI 集成**：OpenClaw Gateway（本地 HTTP 服务，端口 18789）+ OpenCode 服务（端口 4096）

---

## 2. 核心架构流程图

```mermaid
graph TD
    subgraph "进程层级"
        CLI["cli.js<br/>入口文件"] --> DAEMON["daemon.js<br/>守护进程"]
        DAEMON --> WORKER["worker.js<br/>业务进程"]
    end

    subgraph "service/modules"
        MSG_HANDLER["rongyun-message-handler.js<br/>结构化消息处理器"]
        CMD_HANDLER["command-handler.js<br/>命令处理器"]
        SCRIPT_EXEC["script-executor.js<br/>脚本执行器"]
        DASHBOARD["dashboard-collector.js<br/>仪表盘数据采集"]
        HEARTBEAT["heartbeat-dashboard.js<br/>心跳与数据上报"]
        MSG_SENDER["rongyun-message-sender.js<br/>消息发送器"]
        OPCODE_SERVICE["opencode-service.js<br/>AI 对话服务"]
        OPENCLAW_CTRL["openclaw-control.js<br/>OpenClaw 控制"]
    end

    subgraph "service/rongcloud"
        RC_CLIENT["rongcloud-client.js<br/>融云 SDK 客户端"]
        RC_HANDLER["message-handler.js<br/>消息分发器"]
        OC_CLIENT["openclaw-client.js<br/>OpenClaw 客户端"]
    end

    WORKER --> RC_CLIENT
    RC_CLIENT --> RC_HANDLER
    
    RC_HANDLER -->|普通消息| OC_CLIENT
    RC_HANDLER -->|结构化消息| MSG_HANDLER
    
    MSG_HANDLER --> CMD_HANDLER
    MSG_HANDLER --> OPCODE_SERVICE
    CMD_HANDLER --> SCRIPT_EXEC
    CMD_HANDLER --> OPENCLAW_CTRL
    
    WORKER --> HEARTBEAT
    HEARTBEAT --> MSG_SENDER
    HEARTBEAT --> DASHBOARD
    
    MSG_SENDER --> RC_CLIENT
    OC_CLIENT -->|调用| OPCODE_SERVICE
```

---

## 3. （service/modules）详解

### 3.1 核心职责范围

 `service/modules` 目录包含 **19 个文件**，覆盖以下功能域：

| 功能域 | 负责文件 | 代码行数 | 说明 |
|--------|----------|----------|------|
| **结构化消息处理** | `rongyun-message-handler.js` | 250 行 | 处理服务端发送的协议消息（COMMAND、CHAT_MESSAGE、CREATE_OPENCODE_SESSION、DELETE_OPENCODE_SESSION） |
| **命令执行** | `command-handler.js` | 152 行 | 封装 start/stop/restart/status/config_fix 命令 |
| **脚本执行引擎** | `script-executor.js` | 584 行 | 执行 bat/sh 脚本，解析状态，超时控制，进程管理 |
| **数据采集** | `dashboard-collector.js` | 588 行 | 收集 OpenClaw 会话、定时任务、审批、项目、任务、使用统计 |
| **心跳与上报** | `heartbeat-dashboard.js` | 153 行 | 定时发送心跳和仪表盘数据到服务端 |
| **消息发送** | `rongyun-message-sender.js` | 157 行 | 封装所有上行消息（连接通知、心跳、命令结果、聊天回复、仪表盘数据） |
| **AI 对话服务** | `opencode-service.js` | 337 行 | 调用 OpenCode Gateway 进行 AI 对话，流式响应处理 |
| **OpenClaw 控制** | `openclaw-control.js` | 128 行 | 执行 OpenClaw 启动/停止/重启/状态检查 |
| **服务启动** | `opencode-starter.js` | 195 行 | 检查并启动本地 OpenCode 服务（端口 4096） |
| **消息路由** | `structured-message-router.js` | 118 行 | 在 worker.js 层拦截并路由结构化消息 |
| **业务处理** | `business-message-handler.js` | 118 行 | 处理普通消息中的命令和聊天 |
| **普通消息** | `normal-message-handler.js` | 42 行 | 调用 OpenClaw AI 处理普通文本消息 |
| **工具模块** | `config.js`, `auth.js`, `mac-address.js`, `port-checker.js`, `openclaw-enum.js`, `service-manager.js`, `opencode-starter.js` | ~300 行 | 配置、认证、MAC 地址、端口检查、枚举定义、服务管理 |



### 3.2 开发的关键流程

#### 3.2.1 命令执行流程

```mermaid
sequenceDiagram
    participant Server as 服务端
    participant RC as 融云 SDK
    participant Worker as worker.js
    participant MsgHandler as rongyun-message-handler.js
    participant CmdHandler as command-handler.js
    participant ScriptExec as script-executor.js
    participant Script as start.bat/stop.bat

    Server->>RC: 发送 COMMAND 消息<br/>{msg_type: "command", command: "start"}
    RC->>Worker: 推送消息
    Worker->>MsgHandler: 识别结构化消息<br/>调用 handleCommand()
    MsgHandler->>CmdHandler: executeCommand("start")
    CmdHandler->>ScriptExec: executeWithStatus(START, "start.bat")
    ScriptExec->>Script: 执行脚本
    Script-->>ScriptExec: 返回输出
    ScriptExec-->>CmdHandler: 解析状态<br/>{status: "starting_success"}
    CmdHandler-->>MsgHandler: 返回结果
    MsgHandler->>MsgHandler: 调用 sendResponse()<br/>发送 COMMAND_RESULT
    MsgHandler->>RC: 发送结果到服务端
    RC->>Server: 推送结果
```

#### 3.2.2 AI 聊天流程

```mermaid
sequenceDiagram
    participant User as 用户
    participant Server as 服务端
    participant RC as 融云 SDK
    participant Worker as worker.js
    participant MsgHandler as rongyun-message-handler.js
    participant Opencode as opencode-service.js
    participant Gateway as OpenCode Gateway<br/>端口 4096

    User->>Server: 发送聊天消息
    Server->>RC: 发送 CHAT_MESSAGE<br/>{msg_type: "chat_message", content: "..."}
    RC->>Worker: 推送消息
    Worker->>MsgHandler: 调用 handleChatMessage()
    MsgHandler->>Opencode: forwardChatMessage(sessionId, content)
    Opencode->>Gateway: POST /session/{id}/message
    Gateway-->>Opencode: 返回 AI 回复
    Opencode-->>MsgHandler: 流式返回内容
    MsgHandler->>RC: 发送 CHAT_MESSAGE 回复
    RC->>Server: 推送回复
    Server->>User: 展示回复
```

#### 3.2.3 心跳与仪表盘上报流程

```mermaid
sequenceDiagram
    participant Worker as worker.js
    participant Heartbeat as heartbeat-dashboard.js
    participant Collector as dashboard-collector.js
    participant Sender as rongyun-message-sender.js
    participant RC as 融云 SDK
    participant Server as 服务端

    loop 每 20 秒
        Worker->>Heartbeat: 触发心跳
        Heartbeat->>Sender: sendProtocolMessage(HEARTBEAT)
        Sender->>RC: 发送心跳消息
        RC->>Server: 推送心跳
    end

    loop 每 30 秒
        Worker->>Heartbeat: 触发仪表盘上报
        Heartbeat->>Collector: collectDashboardData()
        Collector->>Collector: 收集会话/任务/项目/统计
        Heartbeat->>Sender: 分片发送<br/>DASHBOARD_SESSIONS<br/>DASHBOARD_JOBS<br/>DASHBOARD_PROJECTS<br/>...
        Sender->>RC: 发送数据
        RC->>Server: 推送仪表盘数据
    end
```

---

## 4. （service/rongcloud）详解

### 4.1 核心职责范围

 `service/rongcloud` 目录包含 **8 个文件**，专注于 **RongCloud IM SDK 的底层封装**：

| 功能域 | 负责文件 | 代码行数 | 说明 |
|--------|----------|----------|------|
| **融云客户端** | `rongcloud-client.js` | 331 行 | SDK 初始化、连接管理、消息收发、已读回执、去重过滤 |
| **消息分发** | `message-handler.js` | 172 行 | 消息类型判断、@提及解析、分发到 OpenClawClient 或普通处理器 |
| **OpenClaw 调用** | `openclaw-client.js` | 463 行 | 通过 CLI 调用 openclaw agent，gateway 启动，环境修复 |
| **类型定义** | `types.js`, `message-types.js` | 31 行 | 消息类型枚举 |
| **模块导出** | `index.js` | 19 行 | 统一导出 |
| **环境适配** | `env-polyfill.js`, `openclaw-config.js` | ~100 行 | 环境变量修复、配置加载 |

**总计：约 1,100+ 行代码**

### 4.2 开发的关键流程

#### 4.2.1 融云连接与消息接收流程

```mermaid
sequenceDiagram
    participant Worker as worker.js
    participant RC as rongcloud-client.js
    participant SDK as 融云 SDK
    participant Handler as message-handler.js
    participant OC as openclaw-client.js

    Worker->>RC: new RongCloudClient(config)
    RC->>SDK: RongIMLib.init({appkey})
    RC->>SDK: 注册事件监听器<br/>MESSAGES / CONNECTED / DISCONNECT
    RC->>SDK: RongIMLib.connect(token)
    SDK-->>RC: 连接成功

    loop 持续监听
        SDK->>RC: 推送新消息
        RC->>RC: 过滤离线消息
        RC->>RC: 过滤自己发送的消息
        RC->>RC: 消息去重（UId）
        RC->>Handler: handleMessage(msg)
        Handler->>Handler: 解析@提及
        Handler->>Handler: 判断消息类型<br/>claw / command / normal
        
        alt 消息类型 = "claw"
            Handler->>OC: chat(content, senderId)
            OC->>OC: 确保 gateway 运行
            OC->>OC: spawn openclaw agent
            OC-->>Handler: 返回 AI 回复
            Handler->>RC: sendMessage(reply)
        else 消息类型 = "normal"
            Handler->>Handler: handleNormalMessage(msg)
            Handler->>RC: sendMessage(reply)
        end
    end
```

#### 4.2.2 消息过滤机制

 `rongcloud-client.js` 中实现了四层消息过滤：

```mermaid
graph TD
    A[收到消息] --> B{isOffLineMessage?}
    B -->|是| C[忽略离线消息]
    B -->|否| D{messageDirection=1?}
    D -->|是| E[忽略自己发送的消息]
    D -->|否| F{senderUserId === accountId?}
    F -->|是| G[忽略自己的消息]
    F -->|否| H{messageUId 在发送缓存中?}
    H -->|是| I[忽略 SDK 回传消息]
    H -->|否| J{messageUId 已处理过?}
    J -->|是| K[去重过滤]
    J -->|否| L[传递给 message-handler.js]
```

---

## 5. 消息类型技术分析

### 5.1 两种消息类型的本质区别

| 维度 | 普通消息（RC:TxtMsg） | 自定义消息（自定义协议） |
|------|----------------------|------------------------|
| **融云 SDK 标识** | `messageType: "RC:TxtMsg"` | `messageType: "claw"` 或自定义类型 |
| **内容格式** | 纯文本字符串 | JSON 结构化数据 |
| **适用场景** | 用户聊天、简单文本交互 | 机器间通信、协议指令 |
| **扩展性** | 低（需解析文本） | 高（可直接解析 JSON 字段） |
| **消息体示例** | `"启动服务"` | `{"msg_type":"command","command":"start"}` |

### 5.2 实际代码中的消息处理路径

在 `worker.js` 中，两条路径**并行存在**，互不干扰：

```javascript
// worker.js 中的消息处理逻辑（第 316-382 行）

messageHandler.handleMessage = async (msg) => {
    // 路径 1：结构化消息处理
    if (msg.content 包含 msg_type) {
        // 解析 JSON，提取 command/chat_message 等
        await rongyunMessageHandler.handle(messageData);  
        return;
    }
    
    // 路径 2：普通消息处理
    return originalHandleMessage(msg);  
};
```

### 

---

## 6. 业务流程图总结

```mermaid
graph LR
    subgraph "（service/modules）"
        direction TB
        A1[业务逻辑层]
        A2[命令执行]
        A3[AI 对话]
        A4[数据采集]
        A5[状态上报]
        A6[协议封装]
    end

    subgraph "（service/rongcloud）"
        direction TB
        B1[通信底层]
        B2[SDK 连接]
        B3[消息收发]
        B4[连接管理]
        B5[已读回执]
        B6[消息过滤]
    end

    A1 -->|调用| B1
    B1 -->|推送消息| A1
```

| 维度 | service/modules | service/rongcloud |
|------|------|------|
| **代码量** | ~3,100+ 行 | ~1,100+ 行 |
| **文件数** | 19 个文件 | 8 个文件 |
| **职责层次** | 业务逻辑层 | 通信底层 |
| **核心能力** | 命令执行、AI 对话、数据上报 | SDK 连接、消息收发、连接保活 |
| **对外依赖** | 依赖SDK 连接 | 依赖融云 SDK |
| **独立程度** | 可独立测试业务逻辑 | 可独立测试连接功能 |
| **与消息类型关系** | 决定消息内容格式 | 不感知消息内容格式 |

---

