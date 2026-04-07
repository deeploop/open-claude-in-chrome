# Open Claude in Chrome — 启动诊断与安装完整指南

> 路径：`host/STARTUP-GUIDE-CN.md`
> 日期：2026-04-07

---

## 一、项目启动链路总览

```
┌─────────────────────────────────────────────────────────────────┐
│  启动链路（从安装到运行）                                         │
│                                                                 │
│  Step 1: install.ps1                                            │
│  ├── 检查 Node.js                                               │
│  ├── npm install (安装 @modelcontextprotocol/sdk)                │
│  ├── 创建 native-host-wrapper.bat                               │
│  ├── 注册 Windows 注册表 (Chrome/Edge/Brave)                     │
│  ├── 写入 NativeMessagingHost manifest JSON                     │
│  └── 注册 Claude Code MCP (claude mcp add)                      │
│                                                                 │
│  Step 2: 用户启动 Claude Code                                    │
│  ├── Claude Code 读取 MCP 配置                                   │
│  ├── 通过 stdio 启动 node mcp-server.js                         │
│  ├── mcp-server.js 绑定 TCP:18765                               │
│  ├── mcp-server.js 加载 plugins/*.js                            │
│  └── MCP 协议握手完成 (initialize → initialized)                 │
│                                                                 │
│  Step 3: 用户打开浏览器                                          │
│  ├── Chrome 加载扩展 (background.js + content.js)                │
│  ├── 扩展通过 Native Messaging 连接 native-host.js              │
│  ├── native-host.js 连接到 TCP:18765                            │
│  └── 完整通道建立：Claude ↔ MCP ↔ NativeHost ↔ Extension ↔ 浏览器│
│                                                                 │
│  Step 4: Claude 调用工具                                         │
│  ├── Claude → stdio → mcp-server.js                             │
│  ├── mcp-server.js → TCP → native-host.js                       │
│  ├── native-host.js → Native Messaging → background.js          │
│  ├── background.js → CDP → 浏览器页面执行                        │
│  └── 结果原路返回                                                │
└─────────────────────────────────────────────────────────────────┘
```

---

## 二、安装脚本 install.ps1

### 2.1 使用方法

```powershell
# 基本安装（需要扩展ID）
powershell -ExecutionPolicy Bypass -File host/install.ps1 -ExtensionIds "你的扩展ID"

# 多浏览器安装
powershell -ExecutionPolicy Bypass -File host/install.ps1 -ExtensionIds "chrome-id","edge-id"

# 卸载
powershell -ExecutionPolicy Bypass -File host/install.ps1 -Uninstall
```

### 2.2 获取扩展ID

1. 打开 `chrome://extensions`（或 `edge://extensions`）
2. 启用 **开发者模式**（右上角开关）
3. 点击 **加载已解压的扩展程序** → 选择 `extension/` 目录
4. 复制扩展名称下方显示的 **ID**

### 2.3 安装步骤详解

| 步骤 | 操作 | 产出文件 |
|------|------|---------|
| 1/6 | 检查 Node.js ≥ 18 | - |
| 2/6 | `npm install` | `host/node_modules/` |
| 3/6 | 创建 BAT 包装器 | `host/native-host-wrapper.bat` |
| 4/6 | 注册原生消息主机 | 注册表 + manifest JSON |
| 5/6 | 验证扩展目录 | - |
| 6/6 | 注册 Claude MCP | `~/.claude.json` 或 `.mcp.json` |

### 2.4 注册表路径

| 浏览器 | 注册表键 |
|--------|---------|
| Chrome | `HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.anthropic.open_claude_in_chrome` |
| Edge | `HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.anthropic.open_claude_in_chrome` |
| Brave | `HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.anthropic.open_claude_in_chrome` |

### 2.5 Manifest JSON 位置

```
Chrome: %LOCALAPPDATA%\Google\Chrome\User Data\NativeMessagingHosts\com.anthropic.open_claude_in_chrome.json
Edge:   %LOCALAPPDATA%\Microsoft\Edge\User Data\NativeMessagingHosts\com.anthropic.open_claude_in_chrome.json
Brave:  %LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data\NativeMessagingHosts\com.anthropic.open_claude_in_chrome.json
```

### 2.6 Manifest 内容格式

```json
{
  "name": "com.anthropic.open_claude_in_chrome",
  "description": "Open Claude in Chrome Native Messaging Host",
  "path": "C:\\Users\\你的用户名\\...\\host\\native-host-wrapper.bat",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://你的扩展ID/"]
}
```

---

## 三、诊断脚本 diagnose.ps1

### 3.1 使用方法

```powershell
# 人类可读输出
powershell -ExecutionPolicy Bypass -File host/diagnose.ps1 -Verbose

# JSON 输出（AI Agent 使用）
powershell -ExecutionPolicy Bypass -File host/diagnose.ps1

# 自动修复模式
powershell -ExecutionPolicy Bypass -File host/diagnose.ps1 -Fix -Verbose
```

### 3.2 检查项目（8大类，21项检查）

| # | 类别 | 检查项 | 说明 |
|---|------|--------|------|
| 1 | Node.js | `node_installed` | Node.js 是否安装、版本、路径 |
| 2 | 依赖 | `npm_dependencies` | node_modules 和 @modelcontextprotocol/sdk |
| 3 | 核心文件 | `file_host_mcp-server_js` | MCP Server |
| 3 | | `file_host_native-host_js` | Native Host 桥接 |
| 3 | | `file_extension_manifest_json` | 扩展清单 |
| 3 | | `file_extension_background_js` | 扩展后台脚本 |
| 4 | 原生消息 | `nmh_chrome` | Chrome 注册表 + manifest + 主机文件 |
| 4 | | `nmh_chrome_origins` | Chrome 允许的扩展来源 |
| 4 | | `nmh_edge` / `nmh_brave` | 同上，Edge/Brave |
| 4 | | `nmh_any_browser` | 至少一个浏览器已注册 |
| 5 | TCP端口 | `config_file` | 配置文件和端口号 |
| 5 | | `tcp_port` | 端口是否被 MCP Server 占用 |
| 5 | | `pidfile` | PID文件是否过期 |
| 6 | 插件 | `plugins_dir` | plugins/ 目录和插件数量 |
| 6 | | `plugin_<name>` | 每个插件是否能加载 |
| 6 | | `plugin_tests` | __tests__/ 测试规范 |
| 7 | Claude MCP | `claude_mcp_project` | .mcp.json 配置 |
| 8 | 测试 | `test_runner` | test-runner.js 存在性 |
| 8 | | `test_results` | 自动测试是否全部通过 |

### 3.3 输出状态

| 状态 | 含义 | 颜色 |
|------|------|------|
| `[OK]` / PASS | 检查通过 | 绿色 |
| `[FAIL]` / FAIL | 检查失败，需要修复 | 红色 |
| `[WARN]` / WARN | 警告，可能需要注意 | 黄色 |
| `[FIXED]` / FIXED | 使用 -Fix 自动修复成功 | 青色 |

### 3.4 JSON 输出格式（AI Agent 使用）

```json
{
  "timestamp": "2026-04-07T16:25:18.831Z",
  "projectRoot": "C:\\Users\\W11\\Documents\\GitHub\\open-claude-in-chrome",
  "summary": { "passed": 20, "failed": 0, "warned": 1, "fixed": 0 },
  "results": [
    { "name": "node_installed", "status": "PASS", "message": "Node.js v22.13.0" },
    { "name": "npm_dependencies", "status": "FAIL", "message": "missing", "fix_hint": "cd host && npm install" }
  ]
}
```

### 3.5 -Fix 自动修复能力

| 问题 | -Fix 自动操作 |
|------|-------------|
| node_modules 缺失 | 自动运行 `npm install` |
| SDK 缺失 | 自动运行 `npm install` |
| PID 文件过期 | 自动删除过期 PID 文件 |

---

## 四、Chrome DevTools 启动脚本 devtools.ps1

### 4.1 使用方法

```powershell
# 默认启动（端口9222，打开Coohom）
powershell -ExecutionPolicy Bypass -File host/devtools.ps1

# 自定义端口
powershell -ExecutionPolicy Bypass -File host/devtools.ps1 -Port 9333

# 自定义 Chrome 路径
powershell -ExecutionPolicy Bypass -File host/devtools.ps1 -ChromePath "D:\Chrome\chrome.exe"
```

### 4.2 参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `-Port` | 9222 | 远程调试端口 |
| `-ChromePath` | `C:\Program Files (x86)\Google\Chrome\Application\chrome.exe` | Chrome 路径 |
| `-ProfileDir` | `$HOME\Documents\ChromeRPAProfile` | 独立配置文件目录 |
| `-StartUrl` | `https://www.coohom.com/pub/tool/bim/cloud` | 启动时打开的URL |

### 4.3 注意事项

- **必须关闭所有 Chrome 窗口**再启动，否则 `--remote-debugging-port` 不生效
- 使用**独立配置文件目录**，不影响日常浏览器使用
- DevTools 端口验证：浏览器打开 `http://localhost:9222/json`

---

## 五、常见故障排查

### 5.1 `/mcp` 重连失败

**症状**：Claude Code 中执行 `/mcp` 显示 "Failed to reconnect"

**原因与解决**：

| 原因 | 解决方法 |
|------|---------|
| MCP Server 进程已崩溃 | 重新启动 Claude Code 会话 |
| 端口被占用（TIME_WAIT） | 等待30秒后重试，或重启会话 |
| `process.stdin.resume()` 竞态 | 已在 mcp-server.js 中修复 |
| SDK 版本不匹配（Zod 4 vs 3） | `cd host && npm install @modelcontextprotocol/sdk@1.12.1` |

### 5.2 插件加载后 MCP 无响应

**症状**：MCP Server 启动，plugin loaded，但 Claude Code 收不到初始化响应

**根因**：`process.stdin.resume()` 在 `server.connect()` 之前将 stdin 置为流式模式，`await import()` 插件期间 stdin 数据被消费丢失

**修复**：已移除 `process.stdin.resume()`，stdin end 监听移至 `server.connect()` 之后

### 5.3 Native Messaging 连接失败

```powershell
# 检查注册表
powershell -ExecutionPolicy Bypass -File host/diagnose.ps1 -Verbose

# 重新安装
powershell -ExecutionPolicy Bypass -File host/install.ps1 -ExtensionIds "你的ID"
```

### 5.4 扩展加载但工具调用超时

**可能原因**：
1. 浏览器 debugger 被用户关闭（点了"取消"按钮）
2. 页面 WebGL 阻塞主线程（Coohom BIM 常见）
3. Native Host 未连接到 TCP 端口

**解决**：
1. 刷新页面重试
2. 使用同源的非 WebGL 页面（如 workbench）执行 JS
3. 运行 `diagnose.ps1` 检查 TCP 连接状态

### 5.5 `npm install` 安装了错误的 SDK 版本

**症状**：`tools/list` 返回 `Cannot read properties of undefined (reading '_zod')`

**原因**：`package.json` 使用 `^1.12.1`，npm 解析为 1.29.0（依赖 Zod 4），与内置代码的 Zod 3 不兼容

**修复**：
```bash
cd host
rm -rf node_modules package-lock.json
npm install @modelcontextprotocol/sdk@1.12.1
```

---

## 六、完整文件清单

```
open-claude-in-chrome/
├── host/
│   ├── mcp-server.js              ← MCP Server 主进程 (723行)
│   ├── native-host.js             ← Native Messaging 桥接
│   ├── native-host-wrapper.bat    ← Windows BAT 包装器 (install.ps1 生成)
│   ├── native-host-manifest.json  ← 参考 manifest 模板
│   ├── package.json               ← 依赖: @modelcontextprotocol/sdk ^1.12.1
│   ├── install.ps1                ← Windows 安装脚本 (321行)
│   ├── diagnose.ps1               ← 诊断脚本 (362行, 21项检查)
│   ├── devtools.ps1               ← Chrome DevTools 启动器
│   ├── test-plugin.js             ← 插件手动测试工具
│   ├── test-runner.js             ← 自动测试运行器
│   └── plugins/
│       ├── coohom-rpa.js          ← Coohom RPA 插件 (11个工具)
│       ├── README-CN.md           ← 插件系统中文文档
│       └── __tests__/
│           └── coohom-rpa.test.js ← 测试规范 (16个测试)
├── extension/
│   ├── manifest.json              ← 扩展清单 (v3)
│   ├── background.js              ← Service Worker (938行)
│   └── content.js                 ← 内容脚本 (463行)
├── skills/
│   └── SKILL.md                   ← Coohom RPA 知识库 (84KB)
└── STARTUP-GUIDE-CN.md            ← 本文档
```

---

## 七、当前系统状态（2026-04-07 诊断结果）

```
=== 诊断结果: 20 PASS / 0 FAIL / 1 WARN ===

[OK] Node.js v22.13.0
[OK] npm 依赖已安装 (@modelcontextprotocol/sdk 1.12.1)
[OK] 核心文件完整 (4/4)
[OK] Native Messaging 已注册 (Chrome + Edge + Brave)
[OK] TCP 端口 18765 已被 MCP Server 占用
[OK] PID 文件有效 (PID 21168)
[OK] 插件系统正常 (1 插件, coohom-rpa.js)
[OK] 自动测试全部通过 (16/16)
[WARN] 无 .mcp.json (使用 ~/.claude.json 配置，不影响功能)
```
