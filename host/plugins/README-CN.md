# 插件系统详细技术报告

> 文件路径：`host/plugins/README-CN.md`
> 日期：2026-04-07
> 项目：open-claude-in-chrome 自定义 MCP 插件系统

---

## 一、系统架构总览

### 1.1 插件在整体架构中的位置

```
Claude Code (对话式AI)
    ↓  stdio MCP 协议
┌──────────────────────────────────────────────┐
│  host/mcp-server.js  (MCP Server 主进程)      │
│                                              │
│  ┌─────────────────────┐                     │
│  │ 内置 18 个基础工具   │  tabs, navigate,   │
│  │ (硬编码)             │  computer, find... │
│  └─────────────────────┘                     │
│                                              │
│  ┌─────────────────────┐  ← 新增插件加载器    │
│  │ host/plugins/*.js   │                     │
│  │ ├─ coohom-rpa.js    │  11 个 Coohom 工具  │
│  │ ├─ your-plugin.js   │  自定义插件...       │
│  │ └─ ...              │                     │
│  └─────────────────────┘                     │
│                                              │
│  sendToExtension() ─────────────────────┐    │
└──────────────────────────────────────────┤────┘
    ↓  TCP localhost:18765                 │
Native Host (native-host.js)               │
    ↓  Chrome Native Messaging             │
Chrome Extension (background.js)           │
    ↓  Chrome DevTools Protocol            │
浏览器页面 ←── JS在这里执行 ←──────────────┘
```

### 1.2 核心设计原则

| 原则 | 说明 |
|------|------|
| **零侵入** | 插件代码完全独立于 mcp-server.js，不修改任何核心代码 |
| **复用通道** | 所有浏览器操作通过现有 `sendToExtension()` → `javascript_tool` 通道 |
| **自动加载** | MCP Server 启动时自动扫描 `host/plugins/` 目录 |
| **热插拔** | 添加/删除 `.js` 文件即可增减工具（需重启MCP Server） |
| **独立测试** | 提供 `test-plugin.js` 测试工具，3种模式支持不同阶段调试 |

---

## 二、文件结构

```
open-claude-in-chrome/
├── host/
│   ├── mcp-server.js          ← 核心MCP服务器（已添加插件加载器）
│   ├── native-host.js         ← 原生消息桥接（不变）
│   ├── test-plugin.js         ← 🆕 插件测试工具
│   ├── package.json
│   ├── node_modules/
│   └── plugins/               ← 🆕 插件目录
│       ├── README-CN.md       ← 🆕 本报告
│       └── coohom-rpa.js      ← 🆕 Coohom RPA 插件（11个工具）
├── extension/
│   ├── background.js          ← 不变
│   ├── content.js             ← 不变
│   └── manifest.json          ← 不变
└── skills/
    └── SKILL.md               ← Coohom 知识库（保留作为参考）
```

---

## 三、插件加载机制详解

### 3.1 加载器代码（mcp-server.js 第696-713行）

```javascript
async function loadPlugins() {
  const pluginsDir = path.join(..., "plugins");
  const files = fs.readdirSync(pluginsDir)
    .filter(f => f.endsWith(".js") && !f.startsWith("_") && !f.startsWith("test"));

  for (const file of files) {
    const plugin = await import("file://" + pluginPath);
    if (typeof plugin.register === "function") {
      plugin.register(server, sendToExtension, { z, textResult, imageResult, mixedResult, callTool });
    }
  }
}
```

### 3.2 加载规则

| 规则 | 说明 |
|------|------|
| 文件后缀 | 必须 `.js` |
| 文件名前缀 | `_` 开头的跳过（临时/禁用文件） |
| 文件名前缀 | `test` 开头的跳过（测试文件） |
| 导出要求 | 必须导出 `register(server, sendToExtension, helpers)` 函数 |
| 加载顺序 | 按文件名字母序 |
| 错误处理 | 单个插件失败不影响其他插件和核心功能 |

### 3.3 插件接收的参数

```javascript
export function register(server, sendToExtension, helpers) {
  // server         — McpServer 实例，用于注册工具
  // sendToExtension — 发送请求到浏览器扩展的函数
  // helpers:
  //   z            — Zod 验证库（定义工具参数schema）
  //   textResult   — 包装文本结果
  //   imageResult  — 包装图片结果
  //   mixedResult  — 包装混合结果
  //   callTool     — 调用浏览器工具并自动包装结果
}
```

---

## 四、Coohom RPA 插件工具清单

### 4.1 A组：数据提取工具（只读、安全）

| # | 工具名 | 功能 | 数据来源 |
|---|--------|------|---------|
| A1 | `coohom_get_design_info` | 获取设计ID、楼层ID、项目名 | URL参数 + IndexedDB |
| A2 | `coohom_list_cabinets` | 列出所有已放置柜子 | IndexedDB `customIncrData` |
| A3 | `coohom_read_cabinet_params` | 读取柜子23项制造参数 | IndexedDB |
| A4 | `coohom_get_bim_structure` | 获取BIM结构（墙/门/窗） | REST API `/gateway/kam/` |
| A5 | `coohom_scan_catalog` | 扫描系统柜体型号目录 | DOM遍历（需Alt+4） |

### 4.2 B组：设计修改工具（写操作）

| # | 工具名 | 功能 | 注意事项 |
|---|--------|------|---------|
| B1 | `coohom_modify_cabinet_param` | 修改单个柜子参数 | 写IndexedDB，需刷新 |
| B2 | `coohom_batch_modify_params` | 批量修改多个柜子 | 写IndexedDB，需刷新 |

### 4.3 C组：API工具（REST接口）

| # | 工具名 | 功能 | 权限要求 |
|---|--------|------|---------|
| C1 | `coohom_export_production_json` | 触发生产JSON导出 | PRO+账号 |
| C2 | `coohom_poll_task_status` | 轮询异步任务状态 | PRO+账号 |
| C3 | `coohom_get_render_types` | 获取渲染类型目录 | 免费 |
| C4 | `coohom_fetch_api` | 通用API调用 | 按接口不同 |

---

## 五、Console 测试方法（快速调试）

### 5.1 三种测试模式

```bash
# ┌──────────────────────────────────────────────────────────┐
# │  模式1: 列出插件（不需要浏览器）                          │
# └──────────────────────────────────────────────────────────┘
node host/test-plugin.js
# 输出所有插件及工具列表

# ┌──────────────────────────────────────────────────────────┐
# │  模式2: Dry-Run 验证（不需要浏览器）                      │
# └──────────────────────────────────────────────────────────┘
node host/test-plugin.js coohom-rpa --dry-run
# 加载插件，显示所有工具的参数schema
# 验证插件代码无语法错误
# 不执行任何浏览器操作

# ┌──────────────────────────────────────────────────────────┐
# │  模式3: Mock 执行（不需要浏览器）                         │
# └──────────────────────────────────────────────────────────┘
node host/test-plugin.js coohom-rpa coohom_get_design_info '{"tabId":1}' --mock
# 完整执行工具handler
# sendToExtension 返回 mock 数据
# 可以看到发送给浏览器的完整JS代码

# ┌──────────────────────────────────────────────────────────┐
# │  模式4: Live 执行（需要浏览器+扩展运行中）                │
# └──────────────────────────────────────────────────────────┘
node host/test-plugin.js coohom-rpa coohom_get_design_info '{"tabId":12345}'
# 连接到运行中的MCP Server (TCP:18765)
# 通过浏览器扩展执行真实操作
# 返回实际浏览器执行结果
```

### 5.2 推荐调试流程

```
1. 编写/修改插件代码
       ↓
2. node host/test-plugin.js coohom-rpa --dry-run
   → 确认插件加载成功、schema正确
       ↓
3. node host/test-plugin.js coohom-rpa coohom_xxx '{"tabId":1}' --mock
   → 确认生成的JS代码正确
       ↓
4. 打开 Coohom BIM 编辑器（浏览器 + 扩展启动）
       ↓
5. 获取 tabId:
   node host/test-plugin.js coohom-rpa coohom_get_design_info '{"tabId":实际ID}'
       ↓
6. 在 Claude Code 中直接使用:
   "列出当前设计中所有柜子" → Claude 自动调用 coohom_list_cabinets
```

### 5.3 环境变量

```bash
# 设置默认 tabId，避免每次手动输入
export TEST_TAB_ID=12345
node host/test-plugin.js coohom-rpa coohom_list_cabinets '{}'
```

---

## 六、动态加载机制说明

### 6.1 当前的加载时机

插件在 **MCP Server 启动时** 加载（`await loadPlugins()` 在 `await start()` 之后、`server.connect()` 之前执行）。

```
MCP Server 启动流程:
  1. start()         → 绑定 TCP 端口 / 连接为 Client
  2. loadPlugins()   → 扫描 plugins/ 加载所有插件  ← 在这里
  3. server.connect() → 开始接受 Claude Code 请求
```

### 6.2 如何"热重载"插件

当前 MCP SDK **不支持运行时动态注册/注销工具**。要更新插件：

```bash
# 方法1: 重启 Claude Code 会话（推荐）
# Claude Code 每次启动会创建新的 MCP Server 进程

# 方法2: 手动重启 MCP Server
# 找到 MCP Server 进程
cat /tmp/open-claude-in-chrome-mcp-18765.pid
# 终止后 Claude Code 会自动重新创建
kill $(cat /tmp/open-claude-in-chrome-mcp-18765.pid)
```

### 6.3 与运行中的 Chrome 扩展的关系

**Chrome 扩展不需要重启**。插件系统只影响 MCP Server 层：

```
扩展侧 (background.js):
  接收 javascript_tool 请求 → 在页面执行JS → 返回结果
  ↑
  扩展不关心请求来自"内置工具"还是"插件工具"
  都通过同一个 sendToExtension() 通道
```

因此：
- 添加新插件 → 只需重启 MCP Server
- 修改插件的JS代码 → 只需重启 MCP Server
- Chrome 扩展始终运行，无需任何操作

---

## 七、编写自定义插件指南

### 7.1 最小插件模板

```javascript
// host/plugins/my-plugin.js

export function register(server, sendToExtension, { z, textResult, callTool }) {

  server.tool(
    "my_tool_name",                    // 工具名（Claude 调用时使用）
    "工具描述（Claude 看到的说明）",     // 工具描述
    {                                  // 参数 schema (Zod)
      tabId: z.number().describe("Tab ID"),
      myParam: z.string().describe("我的参数"),
    },
    async (args) => {                  // 处理函数
      // 方式A: 通过 callTool 调用浏览器工具
      return callTool("javascript_tool", {
        action: "javascript_exec",
        text: `document.title`,
        tabId: args.tabId,
      });

      // 方式B: 纯服务端逻辑（不需要浏览器）
      // return textResult("Hello from plugin!");

      // 方式C: 直接调用 sendToExtension（更底层）
      // const result = await sendToExtension("navigate", { url: "...", tabId: args.tabId });
      // return textResult(JSON.stringify(result));
    }
  );
}
```

### 7.2 认证说明

Coohom API 调用依赖浏览器 Cookie（同源策略）：

```javascript
// ✅ 正确: 在浏览器内 fetch（自动携带 Cookie）
const code = `fetch('/api/xxx', { credentials: 'include' }).then(r => r.json())`;
return callTool("javascript_tool", { action: "javascript_exec", text: code, tabId });

// ❌ 错误: 在 Node.js MCP Server 中直接 fetch（没有 Cookie）
// const resp = await fetch('https://www.coohom.com/api/xxx');  // 401 Unauthorized
```

### 7.3 命名规范

| 项目 | 规范 | 示例 |
|------|------|------|
| 插件文件名 | `kebab-case.js` | `coohom-rpa.js` |
| 工具名 | `snake_case`，带前缀 | `coohom_list_cabinets` |
| 工具描述 | 中文，简洁明了 | `"列出当前设计中所有柜子"` |

---

## 八、与 skills/SKILL.md 的关系

```
┌─────────────────────────────────────────────────────────────┐
│  skills/SKILL.md (84KB)                                     │
│                                                             │
│  作用: Claude 的"知识库"                                     │
│  - DOM选择器参考                                             │
│  - 143+ 柜体型号目录                                         │
│  - IndexedDB 数据结构说明                                    │
│  - API 调用模式文档                                          │
│  - 完整会话流程示例                                          │
│                                                             │
│  Claude 读取 SKILL.md 理解"怎么做"                           │
└────────────────────────────────┬────────────────────────────┘
                                 │
                                 ↓ 脚本封装为
┌─────────────────────────────────────────────────────────────┐
│  host/plugins/coohom-rpa.js (11个工具)                      │
│                                                             │
│  作用: Claude 的"工具箱"                                     │
│  - 一键调用，不需要手动组合JS                                 │
│  - 参数验证（Zod schema）                                    │
│  - 标准化输出格式                                            │
│  - 可独立测试                                                │
│                                                             │
│  Claude 调用 coohom_* 工具直接执行操作                       │
└─────────────────────────────────────────────────────────────┘
```

**两者互补**：
- SKILL.md 提供**领域知识**（Claude 理解 Coohom 平台）
- plugins/coohom-rpa.js 提供**可执行工具**（Claude 直接调用）
- 复杂/非标准任务：Claude 结合 SKILL.md 知识 + `javascript_tool` 手动编写
- 常见任务：Claude 直接调用 `coohom_*` 工具

---

## 九、FAQ

### Q1: 插件加载失败怎么排查？

```bash
# 查看 MCP Server 的 stderr 日志
# 插件加载成功会输出: "Plugin loaded: coohom-rpa.js"
# 加载失败会输出: "Plugin load error (xxx.js): 错误信息"

# 快速验证:
node host/test-plugin.js coohom-rpa --dry-run
```

### Q2: 如何获取正确的 tabId？

```bash
# 在 Claude Code 中:
# 1. 调用 tabs_context_mcp 查看所有标签页
# 2. 或调用 coohom_get_design_info 传入预期的 tabId

# 在测试工具中:
# 使用 --mock 模式不需要真实 tabId
```

### Q3: 修改插件后为什么 Claude 还是用旧版？

MCP Server 是长驻进程，需要重启：
1. 关闭当前 Claude Code 会话
2. 重新打开（MCP Server 自动重建）
3. 或手动 kill MCP Server 进程

### Q4: 可以在插件中使用 npm 包吗？

可以，在 `host/package.json` 中添加依赖，然后在插件中 import：

```javascript
// host/plugins/my-plugin.js
import axios from "axios";  // 需要先 npm install axios
```

### Q5: 一个插件文件最多放多少工具？

无硬性限制，建议按功能域分组：
- `coohom-rpa.js` — Coohom 相关
- `sketchup-bridge.js` — SketchUp 相关
- `erp-export.js` — ERP 导出相关

---

## 十、AI Agent 全自动测试系统

### 10.1 架构概览

```
Claude AI Agent
    ↓ 写插件代码 (Edit)
    ↓ 运行测试 (Bash)
    ↓ 解析 JSON 结果
    ↓ 失败 → 定位问题 → 修复 → 重新测试
    ↓ 全部通过 → 完成
```

### 10.2 测试层次

| 层 | 名称 | 需要浏览器 | 测试内容 |
|----|------|-----------|---------|
| 1 | Schema | 否 | 插件加载、工具数量、参数schema、命名规范 |
| 2 | Codegen | 否 | 生成的JS代码验证（关键片段、语法、安全性） |
| 3 | Integration | 是 | 读→改→验证 完整链路（仅 `--live` 模式） |

### 10.3 自动测试运行器

```bash
# 运行所有插件测试（JSON输出到stdout）
node host/test-runner.js

# 运行指定插件测试
node host/test-runner.js coohom-rpa

# 包含集成测试（需要浏览器）
TEST_TAB_ID=12345 node host/test-runner.js coohom-rpa --live

# 带人类可读输出（stderr）
node host/test-runner.js coohom-rpa --verbose
```

### 10.4 JSON 输出格式

```json
{
  "plugin": "coohom-rpa",
  "timestamp": "2026-04-07T...",
  "summary": { "total": 15, "passed": 14, "failed": 1 },
  "exitCode": 1,
  "tests": [
    {
      "name": "load_plugin",
      "layer": "schema",
      "status": "pass",
      "durationMs": 12
    },
    {
      "name": "get_design_info.js_valid",
      "layer": "codegen",
      "status": "fail",
      "error": "Missing 'indexedDB' in generated JS code",
      "expected": "code contains 'indexedDB'",
      "actual": "... (truncated) ...",
      "fix_hint": "The execInBrowser call is not generating IDB access code"
    }
  ]
}
```

### 10.5 AI Agent 自动闭环流程

Claude 在 Bash 中执行：
```bash
node host/test-runner.js coohom-rpa 2>/dev/null
```

收到 JSON → 解析 → 找到失败测试 → 读取 `fix_hint` → 编辑插件代码 → 重新运行 → 直到 `"failed": 0`。

### 10.6 编写测试规范

测试规范文件位于 `host/plugins/__tests__/<plugin-name>.test.js`：

```javascript
export default {
  plugin: "my-plugin",
  mocks: {
    "my_tool": '{"result":"mock data"}',
  },
  tests: [
    // Schema 层: 验证插件结构
    { name: "plugin_loads", layer: "schema", expect: { toolCount: 5 } },

    // Codegen 层: 验证生成的JS代码
    { name: "my_tool.js_valid", layer: "codegen",
      tool: "my_tool", args: { tabId: 1 },
      assert: { jsContains: ["fetch"], jsSyntaxValid: true } },

    // Mock 执行层: 验证mock返回结构
    { name: "my_tool.mock_response", layer: "codegen",
      tool: "my_tool", args: { tabId: 1 }, useMock: true,
      assert: { responseIsJSON: true, responseHasKeys: ["result"] } },

    // Integration 层: 完整链路（仅 --live）
    { name: "end_to_end", layer: "integration",
      sequence: [
        { call: "my_tool", args: { tabId: "$TAB" }, saveAs: "result" },
        { assertExpr: "result.ok === true", failMsg: "Expected ok=true" },
      ] },
  ]
};
```

### 10.7 test-plugin.js --json 模式

原有的 `test-plugin.js` 也支持 `--json` 输出：

```bash
# JSON 输出到 stdout，人类信息到 stderr
node host/test-plugin.js coohom-rpa --dry-run --json
node host/test-plugin.js coohom-rpa coohom_get_design_info '{"tabId":1}' --mock --json
```

---

## 十一、版本记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-04-07 | v1.0 | 初始插件系统：加载器 + coohom-rpa.js (11工具) + test-plugin.js |
| 2026-04-07 | v1.1 | AI Agent 自动测试系统：test-runner.js + 测试规范 + --json 模式 |
