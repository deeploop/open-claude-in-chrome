#!/usr/bin/env node

/**
 * Plugin Test Harness — Fast console-based testing for MCP plugins
 *
 * Usage:
 *   node host/test-plugin.js                      # List all plugins & their tools
 *   node host/test-plugin.js coohom-rpa            # List tools in coohom-rpa plugin
 *   node host/test-plugin.js coohom-rpa --dry-run  # Show tool schemas (no execution)
 *   node host/test-plugin.js coohom-rpa coohom_get_design_info '{"tabId":123}'
 *                                                  # Execute a tool with mock/real browser
 *
 * Modes:
 *   --dry-run     Validate plugin loads & print Zod schemas (no browser needed)
 *   --mock        Use mock sendToExtension (returns canned response)
 *   (default)     Connects to real MCP TCP server for live testing
 *
 * Environment:
 *   TEST_TAB_ID=12345   Default tabId for tool calls
 */

import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import { createRequire } from "node:module";

// Resolve zod from host/node_modules (same as mcp-server.js)
const hostDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
const _require = createRequire(path.join(hostDir, "node_modules", "_dummy.js"));
const { z } = _require("zod");

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith("--")));
const positional = args.filter(a => !a.startsWith("--"));

const isDryRun = flags.has("--dry-run");
const isMock = flags.has("--mock");
const isJSON = flags.has("--json");

// When --json is active, redirect human output to stderr
const out = isJSON ? process.stderr : process.stdout;
function print(msg) { out.write(msg + "\n"); }

// --- Helpers ---

function textResult(text) {
  return { content: [{ type: "text", text }] };
}
function imageResult(base64, mimeType = "image/png") {
  return { content: [{ type: "image", data: base64, mimeType }] };
}
function mixedResult(parts) {
  return { content: parts };
}

// --- Mock MCP Server that captures tool registrations ---

class MockMcpServer {
  constructor() {
    this.tools = new Map(); // name -> { description, schema, handler }
  }

  tool(name, description, schema, handler) {
    this.tools.set(name, { name, description, schema, handler });
  }

  listTools() {
    const list = [];
    for (const [name, t] of this.tools) {
      list.push({ name, description: t.description.slice(0, 80) + (t.description.length > 80 ? "..." : "") });
    }
    return list;
  }

  getToolSchema(name) {
    const t = this.tools.get(name);
    if (!t) return null;
    // Convert Zod schema to JSON-like description
    const fields = {};
    for (const [key, val] of Object.entries(t.schema)) {
      try {
        const desc = val.description || "";
        const typeName = val._def?.typeName || "unknown";
        fields[key] = { type: typeName.replace("Zod", "").toLowerCase(), description: desc };
        if (val._def?.defaultValue !== undefined) fields[key].default = val._def.defaultValue();
        if (val.isOptional && val.isOptional()) fields[key].optional = true;
      } catch {
        fields[key] = { type: "unknown" };
      }
    }
    return { name, description: t.description, fields };
  }

  async callTool(name, toolArgs) {
    const t = this.tools.get(name);
    if (!t) throw new Error(`Tool not found: ${name}`);
    return t.handler(toolArgs);
  }
}

// --- Mock sendToExtension ---

let requestIdCounter = 0;
let tcpSocket = null;
const pendingRequests = new Map();

function getPort() {
  const configPath = path.join(os.homedir(), ".config", "open-claude-in-chrome", "config.json");
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8")).port || 18765;
  } catch {
    return 18765;
  }
}

function createMockSendToExtension() {
  return async function mockSendToExtension(tool, toolArgs) {
    return { mockResult: true, tool, args: toolArgs, note: "Mock mode — no real browser execution" };
  };
}

function createLiveSendToExtension(port) {
  return function liveSendToExtension(tool, toolArgs) {
    return new Promise((resolve, reject) => {
      if (!tcpSocket || tcpSocket.destroyed) {
        reject(new Error("Not connected to MCP server. Is the extension running?"));
        return;
      }
      const id = String(++requestIdCounter);
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error("Tool request timed out after 30s"));
      }, 30000);
      pendingRequests.set(id, { resolve, reject, timer });

      // Send as a client tool_request
      tcpSocket.write(JSON.stringify({ id, type: "tool_request", tool, args: toolArgs }) + "\n");
    });
  };
}

async function connectToServer(port) {
  return new Promise((resolve, reject) => {
    tcpSocket = net.createConnection(port, "127.0.0.1", () => {
      // Send client_hello
      tcpSocket.write(JSON.stringify({ type: "client_hello" }) + "\n");
      let buffer = Buffer.alloc(0);
      tcpSocket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        let idx;
        while ((idx = buffer.indexOf(10)) !== -1) {
          const line = buffer.subarray(0, idx).toString("utf-8").trim();
          buffer = buffer.subarray(idx + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === "client_ack") {
              print(`  Connected as client #${msg.clientId}`);
              resolve();
              continue;
            }
            // Tool response
            if (msg.id && pendingRequests.has(msg.id)) {
              const { resolve: res, reject: rej, timer } = pendingRequests.get(msg.id);
              clearTimeout(timer);
              pendingRequests.delete(msg.id);
              if (msg.type === "tool_error") rej(new Error(msg.error || "Tool execution failed"));
              else res(msg.result);
            }
          } catch {}
        }
      });
    });
    tcpSocket.on("error", (err) => reject(err));
  });
}

// --- Wrap callTool like mcp-server.js does ---

function createCallTool(sendToExtension) {
  return async function callTool(toolName, toolArgs) {
    try {
      const result = await sendToExtension(toolName, toolArgs);
      if (typeof result === "string") return textResult(result);
      if (result && result.content) return result;
      return textResult(JSON.stringify(result, null, 2));
    } catch (err) {
      return textResult(`Error: ${err.message}`);
    }
  };
}

// --- Plugin discovery ---

function getPluginsDir() {
  return path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "plugins");
}

function listPluginFiles() {
  const dir = getPluginsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith(".js") && !f.startsWith("_") && !f.startsWith("test"));
}

// --- Main ---

async function main() {
  const pluginFiles = listPluginFiles();
  const jsonResult = { status: "ok", plugin: null, tool: null, result: null };

  // No args: list all plugins
  if (positional.length === 0) {
    print("\n=== Plugin Test Harness ===\n");
    print("Available plugins:");
    const pluginList = [];
    for (const f of pluginFiles) {
      const server = new MockMcpServer();
      try {
        const pluginPath = path.join(getPluginsDir(), f);
        const plugin = await import("file://" + pluginPath.replace(/\\/g, "/"));
        const mockSend = createMockSendToExtension();
        plugin.register(server, mockSend, { z, textResult, imageResult, mixedResult, callTool: createCallTool(mockSend) });
        const tools = server.listTools();
        print(`\n  ${f} (${server.tools.size} tools):`);
        for (const t of tools) {
          print(`    - ${t.name}: ${t.description}`);
        }
        pluginList.push({ file: f, toolCount: server.tools.size, tools });
      } catch (err) {
        print(`\n  ${f} (LOAD ERROR): ${err.message}`);
        pluginList.push({ file: f, error: err.message });
      }
    }
    print("\nUsage:");
    print("  node host/test-plugin.js <plugin-name> --dry-run              # Show schemas");
    print("  node host/test-plugin.js <plugin-name> <tool> '{\"tabId\":1}'    # Execute tool");
    print("  node host/test-plugin.js <plugin-name> <tool> '{...}' --mock   # Mock execution");
    if (isJSON) {
      jsonResult.plugins = pluginList;
      process.stdout.write(JSON.stringify(jsonResult, null, 2) + "\n");
    }
    return;
  }

  // Load specific plugin
  const pluginName = positional[0].replace(/\.js$/, "");
  const pluginFile = pluginName + ".js";
  const pluginPath = path.join(getPluginsDir(), pluginFile);
  jsonResult.plugin = pluginName;

  if (!fs.existsSync(pluginPath)) {
    print(`Plugin not found: ${pluginFile}`);
    print(`Available: ${pluginFiles.join(", ")}`);
    if (isJSON) {
      jsonResult.status = "error";
      jsonResult.error = `Plugin not found: ${pluginFile}`;
      process.stdout.write(JSON.stringify(jsonResult, null, 2) + "\n");
    }
    process.exit(1);
  }

  // Determine sendToExtension mode
  let sendToExtension;
  if (isDryRun || isMock) {
    sendToExtension = createMockSendToExtension();
  } else {
    const port = getPort();
    print(`Connecting to MCP server on :${port}...`);
    try {
      await connectToServer(port);
    } catch (err) {
      print(`Cannot connect to MCP server: ${err.message}`);
      print("Use --mock for mock mode or --dry-run to just inspect schemas.");
      if (isJSON) {
        jsonResult.status = "error";
        jsonResult.error = `Cannot connect: ${err.message}`;
        process.stdout.write(JSON.stringify(jsonResult, null, 2) + "\n");
      }
      process.exit(1);
    }
  }

  const callTool = createCallTool(sendToExtension);
  const server = new MockMcpServer();
  const plugin = await import("file://" + pluginPath.replace(/\\/g, "/"));
  plugin.register(server, sendToExtension, { z, textResult, imageResult, mixedResult, callTool });

  print(`\nPlugin: ${pluginName} (${server.tools.size} tools loaded)\n`);

  // No tool specified: list tools
  if (positional.length === 1 || isDryRun) {
    const schemas = [];
    for (const [name] of server.tools) {
      const schema = server.getToolSchema(name);
      print(`--- ${schema.name} ---`);
      print(`  ${schema.description}`);
      print("  Parameters:");
      for (const [k, v] of Object.entries(schema.fields)) {
        print(`    ${k}: ${v.type}${v.optional ? " (optional)" : ""}${v.default !== undefined ? ` [default: ${v.default}]` : ""} — ${v.description || ""}`);
      }
      print("");
      schemas.push(schema);
    }
    if (isDryRun) {
      print("  [dry-run] All schemas validated successfully.");
    }
    if (isJSON) {
      jsonResult.toolCount = server.tools.size;
      jsonResult.schemas = schemas;
      process.stdout.write(JSON.stringify(jsonResult, null, 2) + "\n");
    }
    cleanup();
    return;
  }

  // Execute specific tool
  const toolName = positional[1];
  jsonResult.tool = toolName;
  let toolArgs = {};
  if (positional[2]) {
    try {
      toolArgs = JSON.parse(positional[2]);
    } catch {
      print(`Invalid JSON args: ${positional[2]}`);
      if (isJSON) {
        jsonResult.status = "error";
        jsonResult.error = `Invalid JSON args: ${positional[2]}`;
        process.stdout.write(JSON.stringify(jsonResult, null, 2) + "\n");
      }
      process.exit(1);
    }
  }

  // Apply default tabId from env
  if (process.env.TEST_TAB_ID && !toolArgs.tabId) {
    toolArgs.tabId = Number(process.env.TEST_TAB_ID);
  }

  print(`Calling: ${toolName}(${JSON.stringify(toolArgs)})`);
  print("---");

  try {
    const result = await server.callTool(toolName, toolArgs);
    if (isJSON) {
      jsonResult.result = result;
      process.stdout.write(JSON.stringify(jsonResult, null, 2) + "\n");
    } else {
      if (result && result.content) {
        for (const part of result.content) {
          if (part.type === "text") {
            try { print(JSON.stringify(JSON.parse(part.text), null, 2)); }
            catch { print(part.text); }
          } else if (part.type === "image") {
            print(`[Image: ${part.mimeType}, ${part.data.length} chars base64]`);
          }
        }
      } else {
        print(JSON.stringify(result, null, 2));
      }
    }
  } catch (err) {
    print(`Tool error: ${err.message}`);
    if (isJSON) {
      jsonResult.status = "error";
      jsonResult.error = err.message;
      process.stdout.write(JSON.stringify(jsonResult, null, 2) + "\n");
    }
  }

  cleanup();
}

function cleanup() {
  if (tcpSocket && !tcpSocket.destroyed) tcpSocket.destroy();
  // Allow exit
  setTimeout(() => process.exit(0), 100);
}

main().catch(err => {
  process.stderr.write(`${err}\n`);
  cleanup();
});
