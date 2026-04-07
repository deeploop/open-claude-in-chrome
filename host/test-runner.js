#!/usr/bin/env node

/**
 * Automated Test Runner for MCP Plugins
 *
 * Outputs structured JSON for AI Agent consumption.
 * Supports 3 test layers: schema, codegen, integration.
 *
 * Usage:
 *   node host/test-runner.js                        # Run all plugins
 *   node host/test-runner.js coohom-rpa             # Run specific plugin
 *   node host/test-runner.js coohom-rpa --live      # Include integration tests
 *   node host/test-runner.js --verbose              # Add human-readable stderr
 */

import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import { createRequire } from "node:module";

const hostDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
const _require = createRequire(path.join(hostDir, "node_modules", "_dummy.js"));
const { z } = _require("zod");

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith("--")));
const positional = args.filter(a => !a.startsWith("--"));

const isLive = flags.has("--live");
const isVerbose = flags.has("--verbose");

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
function log(msg) {
  if (isVerbose) process.stderr.write(msg + "\n");
}

// --- MockMcpServer (captures tool registrations) ---

class MockMcpServer {
  constructor() {
    this.tools = new Map();
  }
  tool(name, description, schema, handler) {
    this.tools.set(name, { name, description, schema, handler });
  }
}

// --- Smart Mock sendToExtension ---

function createSmartMockSendToExtension(mocks) {
  // Captures JS code from javascript_tool calls and returns mock data
  const captured = { lastJsCode: null, lastTool: null, lastArgs: null };

  async function smartMockSend(tool, toolArgs) {
    captured.lastTool = tool;
    captured.lastArgs = toolArgs;

    if (tool === "javascript_tool" && toolArgs && toolArgs.text) {
      captured.lastJsCode = toolArgs.text;
    }

    // Return tool-specific mock if available
    // The mock key is looked up by the *plugin tool name* (set externally)
    if (captured.currentMockKey && mocks && mocks[captured.currentMockKey]) {
      const mockData = mocks[captured.currentMockKey];
      // Return as the extension would: raw string or object
      return typeof mockData === "string" ? mockData : JSON.stringify(mockData);
    }

    return JSON.stringify({ mockResult: true, tool, note: "No mock configured" });
  }

  smartMockSend.captured = captured;
  return smartMockSend;
}

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

// --- Live connection for integration tests ---

let tcpSocket = null;
let requestIdCounter = 0;
const pendingRequests = new Map();

function getPort() {
  const configPath = path.join(os.homedir(), ".config", "open-claude-in-chrome", "config.json");
  try { return JSON.parse(fs.readFileSync(configPath, "utf-8")).port || 18765; }
  catch { return 18765; }
}

function createLiveSendToExtension() {
  return function liveSend(tool, toolArgs) {
    return new Promise((resolve, reject) => {
      if (!tcpSocket || tcpSocket.destroyed) {
        reject(new Error("Not connected to MCP server"));
        return;
      }
      const id = String(++requestIdCounter);
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error("Tool request timed out after 30s"));
      }, 30000);
      pendingRequests.set(id, { resolve, reject, timer });
      tcpSocket.write(JSON.stringify({ id, type: "tool_request", tool, args: toolArgs }) + "\n");
    });
  };
}

async function connectToServer(port) {
  return new Promise((resolve, reject) => {
    tcpSocket = net.createConnection(port, "127.0.0.1", () => {
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
            if (msg.type === "client_ack") { resolve(); continue; }
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

// --- Plugin discovery ---

function getPluginsDir() {
  return path.join(hostDir, "plugins");
}

function listPluginFiles() {
  const dir = getPluginsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith(".js") && !f.startsWith("_") && !f.startsWith("test"));
}

function listTestFiles() {
  const dir = path.join(getPluginsDir(), "__tests__");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith(".test.js"));
}

// --- Test execution engine ---

async function runTestSpec(testSpec) {
  const results = [];
  const pluginName = testSpec.plugin;
  const pluginFile = pluginName + ".js";
  const pluginPath = path.join(getPluginsDir(), pluginFile);

  if (!fs.existsSync(pluginPath)) {
    results.push({
      name: "plugin_exists",
      layer: "schema",
      status: "fail",
      error: `Plugin file not found: ${pluginFile}`,
      durationMs: 0,
    });
    return results;
  }

  // Load plugin with smart mock
  const smartMock = createSmartMockSendToExtension(testSpec.mocks || {});
  const callTool = createCallTool(smartMock);
  const server = new MockMcpServer();

  const loadStart = Date.now();
  try {
    const plugin = await import("file://" + pluginPath.replace(/\\/g, "/") + "?t=" + Date.now());
    plugin.register(server, smartMock, { z, textResult, imageResult, mixedResult, callTool });
  } catch (err) {
    results.push({
      name: "load_plugin",
      layer: "schema",
      status: "fail",
      error: `Plugin load error: ${err.message}`,
      durationMs: Date.now() - loadStart,
    });
    return results;
  }

  // For live tests, we need a separate sendToExtension + callTool
  let liveCallTool = null;
  if (isLive) {
    try {
      const port = getPort();
      log(`Connecting to MCP server on :${port} for integration tests...`);
      await connectToServer(port);
      const liveSend = createLiveSendToExtension();
      liveCallTool = createCallTool(liveSend);
      log("Connected.");
    } catch (err) {
      log(`Cannot connect for live tests: ${err.message}`);
    }
  }

  for (const test of testSpec.tests) {
    // Skip integration tests if not --live
    if (test.layer === "integration" && !isLive) continue;

    const t0 = Date.now();
    try {
      const result = await runSingleTest(test, server, smartMock, callTool, liveCallTool, testSpec.mocks || {});
      result.durationMs = Date.now() - t0;
      results.push(result);
    } catch (err) {
      results.push({
        name: test.name,
        layer: test.layer,
        status: "fail",
        error: `Unexpected error: ${err.message}`,
        durationMs: Date.now() - t0,
      });
    }
    log(`  ${results[results.length - 1].status === "pass" ? "PASS" : "FAIL"} ${test.name}`);
  }

  return results;
}

async function runSingleTest(test, server, smartMock, callTool, liveCallTool, mocks) {
  const result = { name: test.name, layer: test.layer, status: "pass" };

  // --- Schema layer ---
  if (test.layer === "schema") {
    return runSchemaTest(test, server, result);
  }

  // --- Codegen layer ---
  if (test.layer === "codegen") {
    return await runCodegenTest(test, server, smartMock, mocks, result);
  }

  // --- Integration layer ---
  if (test.layer === "integration") {
    return await runIntegrationTest(test, server, liveCallTool, result);
  }

  result.status = "fail";
  result.error = `Unknown test layer: ${test.layer}`;
  return result;
}

function runSchemaTest(test, server, result) {
  const expect = test.expect || {};

  if (expect.toolCount !== undefined) {
    if (server.tools.size !== expect.toolCount) {
      result.status = "fail";
      result.error = `Expected ${expect.toolCount} tools, got ${server.tools.size}`;
      result.expected = expect.toolCount;
      result.actual = server.tools.size;
      result.fix_hint = "Plugin registered wrong number of tools. Check register() function.";
    }
    return result;
  }

  if (expect.allToolsHaveParam) {
    const paramName = expect.allToolsHaveParam;
    const missing = [];
    for (const [name, tool] of server.tools) {
      if (!tool.schema[paramName]) {
        missing.push(name);
      }
    }
    if (missing.length > 0) {
      result.status = "fail";
      result.error = `Tools missing '${paramName}' parameter: ${missing.join(", ")}`;
      result.expected = `All tools have '${paramName}'`;
      result.actual = `Missing in: ${missing.join(", ")}`;
      result.fix_hint = `Add '${paramName}' parameter to: ${missing.join(", ")}`;
    }
    return result;
  }

  if (expect.toolExists) {
    if (!server.tools.has(expect.toolExists)) {
      result.status = "fail";
      result.error = `Tool '${expect.toolExists}' not found`;
      result.fix_hint = `Register tool '${expect.toolExists}' in the plugin.`;
    }
    return result;
  }

  if (expect.toolNamePattern) {
    const re = new RegExp(expect.toolNamePattern);
    const bad = [];
    for (const [name] of server.tools) {
      if (!re.test(name)) bad.push(name);
    }
    if (bad.length > 0) {
      result.status = "fail";
      result.error = `Tools not matching pattern '${expect.toolNamePattern}': ${bad.join(", ")}`;
      result.fix_hint = `Rename tools to match pattern: ${expect.toolNamePattern}`;
    }
    return result;
  }

  // Default: plugin loaded = pass
  return result;
}

async function runCodegenTest(test, server, smartMock, mocks, result) {
  const tool = server.tools.get(test.tool);
  if (!tool) {
    result.status = "fail";
    result.error = `Tool '${test.tool}' not found in plugin`;
    result.fix_hint = `Register tool '${test.tool}' in the plugin.`;
    return result;
  }

  // Set current mock key so smartMock returns the right data
  smartMock.captured.currentMockKey = test.tool;
  smartMock.captured.lastJsCode = null;

  // Call the tool handler
  let toolResult;
  try {
    toolResult = await tool.handler(test.args || {});
  } catch (err) {
    result.status = "fail";
    result.error = `Tool handler threw: ${err.message}`;
    result.fix_hint = `Fix the handler for '${test.tool}'. Error: ${err.message}`;
    return result;
  }

  const jsCode = smartMock.captured.lastJsCode || "";
  const assert = test.assert || {};

  // jsContains check
  if (assert.jsContains) {
    for (const fragment of assert.jsContains) {
      if (!jsCode.toLowerCase().includes(fragment.toLowerCase())) {
        result.status = "fail";
        result.error = `Missing '${fragment}' in generated JS code`;
        result.expected = `code contains '${fragment}'`;
        result.actual = jsCode.length > 300 ? jsCode.slice(0, 300) + "..." : jsCode;
        result.fix_hint = `The execInBrowser call for '${test.tool}' is not generating code containing '${fragment}'`;
        return result;
      }
    }
  }

  // jsNotContains check
  if (assert.jsNotContains) {
    for (const fragment of assert.jsNotContains) {
      if (jsCode.includes(fragment)) {
        result.status = "fail";
        result.error = `Found forbidden '${fragment}' in generated JS code`;
        result.expected = `code does NOT contain '${fragment}'`;
        result.actual = jsCode.length > 300 ? jsCode.slice(0, 300) + "..." : jsCode;
        result.fix_hint = `Security issue: generated JS for '${test.tool}' contains '${fragment}'`;
        return result;
      }
    }
  }

  // jsSyntaxValid check
  if (assert.jsSyntaxValid) {
    try {
      new Function(jsCode);
    } catch (err) {
      result.status = "fail";
      result.error = `JS syntax error: ${err.message}`;
      result.expected = "Valid JavaScript syntax";
      result.actual = err.message;
      result.fix_hint = `Fix JS syntax in '${test.tool}' code generation`;
      return result;
    }
  }

  // Mock response assertions (when useMock is true)
  if (test.useMock && toolResult) {
    const text = extractText(toolResult);

    if (assert.responseIsJSON) {
      try {
        JSON.parse(text);
      } catch {
        result.status = "fail";
        result.error = "Mock response is not valid JSON";
        result.expected = "Valid JSON";
        result.actual = text.length > 200 ? text.slice(0, 200) + "..." : text;
        result.fix_hint = `Mock data for '${test.tool}' is not valid JSON`;
        return result;
      }
    }

    if (assert.responseHasKeys) {
      try {
        const parsed = JSON.parse(text);
        const missing = assert.responseHasKeys.filter(k => !(k in parsed));
        if (missing.length > 0) {
          result.status = "fail";
          result.error = `Mock response missing keys: ${missing.join(", ")}`;
          result.expected = `Keys: ${assert.responseHasKeys.join(", ")}`;
          result.actual = `Keys: ${Object.keys(parsed).join(", ")}`;
          result.fix_hint = `Update mock data for '${test.tool}' to include: ${missing.join(", ")}`;
          return result;
        }
      } catch {
        result.status = "fail";
        result.error = "Cannot parse mock response to check keys";
        return result;
      }
    }
  }

  return result;
}

async function runIntegrationTest(test, server, liveCallTool, result) {
  if (!liveCallTool) {
    result.status = "fail";
    result.error = "No live connection available for integration test";
    result.fix_hint = "Start browser with extension and use --live flag";
    return result;
  }

  if (!test.sequence) {
    result.status = "fail";
    result.error = "Integration test missing 'sequence'";
    return result;
  }

  const tabId = Number(process.env.TEST_TAB_ID || 0);
  if (!tabId) {
    result.status = "fail";
    result.error = "TEST_TAB_ID environment variable not set";
    result.fix_hint = "Set TEST_TAB_ID=<tabId> before running --live tests";
    return result;
  }

  const context = {};

  for (const step of test.sequence) {
    // Resolve $variables in args
    if (step.call) {
      const resolvedArgs = resolveVars(step.args || {}, context, tabId);
      log(`    call ${step.call}(${JSON.stringify(resolvedArgs)})`);

      const tool = server.tools.get(step.call);
      if (!tool) {
        result.status = "fail";
        result.error = `Tool '${step.call}' not found`;
        return result;
      }

      try {
        const resp = await tool.handler(resolvedArgs);
        if (step.saveAs) {
          const text = extractText(resp);
          try { context[step.saveAs] = JSON.parse(text); }
          catch { context[step.saveAs] = text; }
        }
      } catch (err) {
        result.status = "fail";
        result.error = `Step '${step.call}' failed: ${err.message}`;
        return result;
      }
    }

    // assertExpr
    if (step.assertExpr) {
      try {
        const fn = new Function(...Object.keys(context), `return (${step.assertExpr})`);
        const ok = fn(...Object.values(context));
        if (!ok) {
          result.status = "fail";
          result.error = step.failMsg || `Assertion failed: ${step.assertExpr}`;
          result.expected = step.assertExpr;
          result.actual = JSON.stringify(context);
          return result;
        }
      } catch (err) {
        result.status = "fail";
        result.error = `Assertion error: ${err.message}`;
        return result;
      }
    }
  }

  return result;
}

// --- Utilities ---

function extractText(toolResult) {
  if (!toolResult || !toolResult.content) return "";
  for (const part of toolResult.content) {
    if (part.type === "text") return part.text;
  }
  return "";
}

function resolveVars(obj, context, tabId) {
  if (typeof obj === "string") {
    if (obj === "$TAB") return tabId;
    // Handle $varName.path.to.value
    const match = obj.match(/^\$(\w+)((?:\.\w+|\[\d+\])*)$/);
    if (match) {
      const [, varName, pathStr] = match;
      let val = context[varName];
      if (val !== undefined && pathStr) {
        // Parse path segments
        const segments = pathStr.match(/\.(\w+)|\[(\d+)\]/g) || [];
        for (const seg of segments) {
          if (seg.startsWith(".")) val = val?.[seg.slice(1)];
          else if (seg.startsWith("[")) val = val?.[parseInt(seg.slice(1, -1))];
        }
      }
      return val;
    }
    return obj;
  }
  if (Array.isArray(obj)) return obj.map(v => resolveVars(v, context, tabId));
  if (typeof obj === "object" && obj !== null) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = resolveVars(v, context, tabId);
    }
    return out;
  }
  return obj;
}

// --- Main ---

async function main() {
  const targetPlugin = positional[0] || null;
  const testFiles = listTestFiles();
  const allResults = [];

  for (const testFile of testFiles) {
    const pluginName = testFile.replace(/\.test\.js$/, "");
    if (targetPlugin && pluginName !== targetPlugin) continue;

    log(`\nRunning tests for: ${pluginName}`);
    const testPath = path.join(getPluginsDir(), "__tests__", testFile);
    let testSpec;
    try {
      const mod = await import("file://" + testPath.replace(/\\/g, "/") + "?t=" + Date.now());
      testSpec = mod.default;
    } catch (err) {
      allResults.push({
        plugin: pluginName,
        error: `Failed to load test spec: ${err.message}`,
        tests: [],
      });
      continue;
    }

    const tests = await runTestSpec(testSpec);
    const passed = tests.filter(t => t.status === "pass").length;
    const failed = tests.filter(t => t.status === "fail").length;

    log(`\n  ${pluginName}: ${passed} passed, ${failed} failed, ${tests.length} total`);

    allResults.push({
      plugin: pluginName,
      timestamp: new Date().toISOString(),
      summary: { total: tests.length, passed, failed },
      tests,
    });
  }

  // If targeting a specific plugin but no test file found, run basic schema tests
  if (targetPlugin && !testFiles.some(f => f.startsWith(targetPlugin))) {
    log(`No test spec for ${targetPlugin}, running basic schema validation...`);
    const pluginFile = targetPlugin + ".js";
    const pluginPath = path.join(getPluginsDir(), pluginFile);

    if (!fs.existsSync(pluginPath)) {
      allResults.push({
        plugin: targetPlugin,
        timestamp: new Date().toISOString(),
        summary: { total: 1, passed: 0, failed: 1 },
        tests: [{ name: "plugin_exists", layer: "schema", status: "fail", error: `Plugin file not found: ${pluginFile}`, durationMs: 0 }],
      });
    } else {
      const t0 = Date.now();
      const server = new MockMcpServer();
      const mockSend = createSmartMockSendToExtension({});
      const ct = createCallTool(mockSend);
      try {
        const plugin = await import("file://" + pluginPath.replace(/\\/g, "/") + "?t=" + Date.now());
        plugin.register(server, mockSend, { z, textResult, imageResult, mixedResult, callTool: ct });
        allResults.push({
          plugin: targetPlugin,
          timestamp: new Date().toISOString(),
          summary: { total: 1, passed: 1, failed: 0 },
          tests: [{ name: "load_plugin", layer: "schema", status: "pass", durationMs: Date.now() - t0, toolCount: server.tools.size }],
        });
      } catch (err) {
        allResults.push({
          plugin: targetPlugin,
          timestamp: new Date().toISOString(),
          summary: { total: 1, passed: 0, failed: 1 },
          tests: [{ name: "load_plugin", layer: "schema", status: "fail", error: err.message, durationMs: Date.now() - t0 }],
        });
      }
    }
  }

  // Compute overall exit code
  const totalFailed = allResults.reduce((s, r) => s + (r.summary?.failed || 0), 0);

  // Output
  const output = allResults.length === 1 ? { ...allResults[0], exitCode: totalFailed > 0 ? 1 : 0 } : {
    timestamp: new Date().toISOString(),
    plugins: allResults,
    summary: {
      total: allResults.reduce((s, r) => s + (r.summary?.total || 0), 0),
      passed: allResults.reduce((s, r) => s + (r.summary?.passed || 0), 0),
      failed: totalFailed,
    },
    exitCode: totalFailed > 0 ? 1 : 0,
  };

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");

  // Cleanup
  if (tcpSocket && !tcpSocket.destroyed) tcpSocket.destroy();
  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  if (tcpSocket && !tcpSocket.destroyed) tcpSocket.destroy();
  process.exit(2);
});
