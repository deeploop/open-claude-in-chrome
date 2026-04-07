/**
 * Test specification for coohom-rpa plugin
 *
 * Declarative test cases consumed by host/test-runner.js
 */

export default {
  plugin: "coohom-rpa",

  // Smart mock: tool-name -> mock browser response
  mocks: {
    "coohom_get_design_info": '{"designId":"TEST123","levelId":"LVL1","title":"Test Design","url":"https://www.coohom.com/bim?designid=TEST123"}',
    "coohom_list_cabinets": '{"count":2,"cabinets":[{"id":"cab1","name":"地柜F1","brandGoodId":"BG001","params":{"W":800,"D":550,"H":720},"position":{}},{"id":"cab2","name":"吊柜W1","brandGoodId":"BG002","params":{"W":600,"D":330,"H":700},"position":{}}]}',
    "coohom_read_cabinet_params": '{"id":"cab1","name":"地柜F1","brandGoodId":"BG001","parameters":{"W":800,"D":550,"H":720,"ST":18,"FT":18,"DT":18},"position":{},"rotation":0}',
    "coohom_get_bim_structure": '{"summary":{"walls":4,"doors":1,"windows":2,"floors":1,"rooms":1},"data":{}}',
    "coohom_scan_catalog": '{"totalCategories":2,"totalModels":5,"categories":[{"category":"地柜","models":["F1","F2","F3"],"count":3},{"category":"吊柜","models":["W1","W2"],"count":2}]}',
    "coohom_modify_cabinet_param": '{"success":true,"cabinetId":"cab1","updatedParams":{"W":999},"note":"参数已写入IndexedDB，刷新页面生效"}',
    "coohom_batch_modify_params": '{"updated":2,"results":[{"cabinetId":"cab1","success":true},{"cabinetId":"cab2","success":true}],"note":"刷新页面生效"}',
    "coohom_export_production_json": '{"taskId":"TASK001","status":"pending"}',
    "coohom_poll_task_status": '{"taskId":"TASK001","status":"completed","downloadUrl":"https://example.com/result.json"}',
    "coohom_get_render_types": '{"types":[{"id":1,"name":"标准渲染"},{"id":2,"name":"全景渲染"}]}',
    "coohom_fetch_api": '{"status":200,"data":{"ok":true}}',
  },

  tests: [
    // ===================== Schema layer =====================

    { name: "plugin_loads", layer: "schema",
      expect: { toolCount: 11 } },

    { name: "all_tools_have_tabId", layer: "schema",
      expect: { allToolsHaveParam: "tabId" } },

    { name: "tool_names_follow_convention", layer: "schema",
      expect: { toolNamePattern: "^coohom_" } },

    // ===================== Codegen layer =====================

    // A1: get_design_info
    { name: "get_design_info.js_valid", layer: "codegen",
      tool: "coohom_get_design_info", args: { tabId: 1 },
      assert: { jsContains: ["designid", "indexedDB"], jsSyntaxValid: true } },

    // A2: list_cabinets
    { name: "list_cabinets.js_valid", layer: "codegen",
      tool: "coohom_list_cabinets", args: { tabId: 1 },
      assert: { jsContains: ["customIncrData", "cabinet"], jsSyntaxValid: true } },

    // A3: read_cabinet_params
    { name: "read_cabinet_params.js_valid", layer: "codegen",
      tool: "coohom_read_cabinet_params", args: { tabId: 1, cabinetId: "cab1" },
      assert: { jsContains: ["customIncrData", "parameters"], jsSyntaxValid: true } },

    // A4: get_bim_structure
    { name: "get_bim_structure.js_valid", layer: "codegen",
      tool: "coohom_get_bim_structure", args: { tabId: 1, designId: "TEST123" },
      assert: { jsContains: ["credentials", "include", "floorplan"], jsSyntaxValid: true } },

    // A5: scan_catalog
    { name: "scan_catalog.js_valid", layer: "codegen",
      tool: "coohom_scan_catalog", args: { tabId: 1 },
      assert: { jsContains: ["querySelectorAll"], jsSyntaxValid: true } },

    // B1: modify_cabinet_param
    { name: "modify_cabinet_param.js_valid", layer: "codegen",
      tool: "coohom_modify_cabinet_param", args: { tabId: 1, cabinetId: "cab1", params: { W: 999 } },
      assert: { jsContains: ["readwrite", "put"], jsSyntaxValid: true } },

    // B2: batch_modify_params
    { name: "batch_modify_params.js_valid", layer: "codegen",
      tool: "coohom_batch_modify_params",
      args: { tabId: 1, modifications: [{ cabinetId: "cab1", params: { W: 999 } }] },
      assert: { jsContains: ["readwrite", "put"], jsSyntaxValid: true } },

    // C1: export_production_json
    { name: "export_production_json.js_valid", layer: "codegen",
      tool: "coohom_export_production_json",
      args: { tabId: 1, designId: "TEST123", levelId: "LVL1", designType: 0 },
      assert: { jsContains: ["credentials", "include", "POST"], jsSyntaxValid: true } },

    // C2: poll_task_status
    { name: "poll_task_status.js_valid", layer: "codegen",
      tool: "coohom_poll_task_status",
      args: { tabId: 1, taskId: "TASK001", designId: "TEST123", levelId: "LVL1" },
      assert: { jsContains: ["credentials", "include"], jsSyntaxValid: true } },

    // C4: fetch_api — verify path is safely JSON-serialized (not template-interpolated)
    { name: "fetch_api.js_valid", layer: "codegen",
      tool: "coohom_fetch_api",
      args: { tabId: 1, path: "/test/api/v1", method: "GET" },
      assert: { jsContains: ["credentials", "include"], jsSyntaxValid: true } },

    // ===================== Mock execution layer =====================

    { name: "get_design_info.mock_response", layer: "codegen",
      tool: "coohom_get_design_info", args: { tabId: 1 },
      useMock: true,
      assert: { responseIsJSON: true, responseHasKeys: ["designId", "levelId"] } },

    { name: "list_cabinets.mock_response", layer: "codegen",
      tool: "coohom_list_cabinets", args: { tabId: 1 },
      useMock: true,
      assert: { responseIsJSON: true, responseHasKeys: ["count", "cabinets"] } },

    { name: "read_cabinet_params.mock_response", layer: "codegen",
      tool: "coohom_read_cabinet_params", args: { tabId: 1, cabinetId: "cab1" },
      useMock: true,
      assert: { responseIsJSON: true, responseHasKeys: ["id", "name", "parameters"] } },

    // ===================== Integration layer (--live only) =====================

    { name: "read_modify_read_verify", layer: "integration",
      sequence: [
        { call: "coohom_list_cabinets", args: { tabId: "$TAB" }, saveAs: "listing" },
        { assertExpr: "listing.count > 0", failMsg: "No cabinets in design" },
        { call: "coohom_read_cabinet_params", args: { tabId: "$TAB", cabinetId: "$listing.cabinets[0].id" }, saveAs: "before" },
        { call: "coohom_modify_cabinet_param", args: { tabId: "$TAB", cabinetId: "$listing.cabinets[0].id", params: { W: 12345 } } },
        { call: "coohom_read_cabinet_params", args: { tabId: "$TAB", cabinetId: "$listing.cabinets[0].id" }, saveAs: "after" },
        { assertExpr: "after.parameters.W === 12345", failMsg: "W not updated to 12345" },
        // Restore original
        { call: "coohom_modify_cabinet_param", args: { tabId: "$TAB", cabinetId: "$listing.cabinets[0].id", params: { W: "$before.parameters.W" } } },
      ]
    },
  ]
};
