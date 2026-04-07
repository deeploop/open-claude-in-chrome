/**
 * Coohom RPA Plugin — MCP tools for Coohom 3D BIM platform automation
 *
 * Provides high-level tools that wrap browser-side JS execution via the
 * existing javascript_tool channel. All Coohom API calls run inside the
 * browser context (same-origin cookie auth).
 *
 * Usage: This file is auto-loaded by mcp-server.js plugin loader.
 * Test:  node host/test-plugin.js coohom-rpa
 */

export function register(server, sendToExtension, { z, textResult, callTool }) {

  // ---------------------------------------------------------------------------
  // Helper: execute JS in the Coohom tab via the existing javascript_tool path
  // ---------------------------------------------------------------------------
  async function execInBrowser(tabId, code) {
    return callTool("javascript_tool", {
      action: "javascript_exec",
      text: code,
      tabId,
    });
  }

  // ===========================================================================
  // A-Group: Data Extraction Tools (read-only, safe)
  // ===========================================================================

  // A1. Get current design info (designId, levelId, project name)
  server.tool(
    "coohom_get_design_info",
    "获取当前 Coohom 设计信息（designId、levelId、项目名称）。需要在 Coohom BIM 编辑器或同源页面上运行。",
    {
      tabId: z.number().describe("Coohom 页面的 Tab ID"),
    },
    async (args) => execInBrowser(args.tabId, `
      (async () => {
        const url = new URL(location.href);
        const designId = url.searchParams.get('designid') || url.searchParams.get('obsdesignid') || '';
        const title = document.title || '';
        // Try to get levelId from IndexedDB store names
        let levelId = '';
        try {
          const dbs = await indexedDB.databases();
          const idb = dbs.find(d => d.name === 'customIncrData');
          if (idb) {
            const db = await new Promise((res, rej) => {
              const req = indexedDB.open('customIncrData');
              req.onsuccess = () => res(req.result);
              req.onerror = () => rej(req.error);
            });
            const stores = Array.from(db.objectStoreNames);
            const cabinetStore = stores.find(s => s.includes(designId) && s.endsWith('-cabinet'));
            if (cabinetStore) levelId = cabinetStore.replace(designId + '-', '').replace('-cabinet', '');
            db.close();
          }
        } catch {}
        return JSON.stringify({ designId, levelId, title, url: location.href });
      })()
    `)
  );

  // A2. List all placed cabinets from IndexedDB
  server.tool(
    "coohom_list_cabinets",
    "列出当前 Coohom 设计中所有已放置的柜子（从 IndexedDB 读取）。返回柜子名称、型号、参数概要。",
    {
      tabId: z.number().describe("Coohom 同源页面的 Tab ID"),
      designId: z.string().optional().describe("设计ID，不填则自动从URL获取"),
    },
    async (args) => execInBrowser(args.tabId, `
      (async () => {
        const designId = ${JSON.stringify(args.designId || '')} || new URLSearchParams(location.search).get('designid') || '';
        if (!designId) return JSON.stringify({ error: 'Cannot detect designId from URL' });

        const db = await new Promise((res, rej) => {
          const req = indexedDB.open('customIncrData');
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
        const stores = Array.from(db.objectStoreNames);
        const cabinetStores = stores.filter(s => s.includes(designId) && s.endsWith('-cabinet'));
        const results = [];
        for (const storeName of cabinetStores) {
          const tx = db.transaction(storeName, 'readonly');
          const store = tx.objectStore(storeName);
          const all = await new Promise((res, rej) => {
            const req = store.getAll();
            req.onsuccess = () => res(req.result);
            req.onerror = () => rej(req.error);
          });
          for (const item of all) {
            try {
              let data = item.data || item;
              if (typeof data === 'string') {
                // might be gzip compressed, try parse
                try { data = JSON.parse(data); } catch { continue; }
              }
              if (data && data.name) {
                results.push({
                  id: data.id || item.key,
                  name: data.name,
                  brandGoodId: data.obsBrandGoodId || '',
                  params: data.parameters || {},
                  position: data.position || {},
                });
              }
            } catch {}
          }
        }
        db.close();
        return JSON.stringify({ count: results.length, cabinets: results });
      })()
    `)
  );

  // A3. Read cabinet parameters (23 manufacturing dimensions)
  server.tool(
    "coohom_read_cabinet_params",
    "读取指定柜子的完整制造参数（23项尺寸参数：W/D/H/ST/FT/DT/MT等）。",
    {
      tabId: z.number().describe("Tab ID"),
      cabinetId: z.string().describe("柜子ID（从 coohom_list_cabinets 获取）"),
      designId: z.string().optional().describe("设计ID"),
    },
    async (args) => execInBrowser(args.tabId, `
      (async () => {
        const designId = ${JSON.stringify(args.designId || '')} || new URLSearchParams(location.search).get('designid') || '';
        const cabinetId = ${JSON.stringify(args.cabinetId)};
        const db = await new Promise((res, rej) => {
          const req = indexedDB.open('customIncrData');
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
        const stores = Array.from(db.objectStoreNames).filter(s => s.includes(designId) && s.endsWith('-cabinet'));
        let found = null;
        for (const storeName of stores) {
          const tx = db.transaction(storeName, 'readonly');
          const store = tx.objectStore(storeName);
          const all = await new Promise((res, rej) => {
            const req = store.getAll();
            req.onsuccess = () => res(req.result);
            req.onerror = () => rej(req.error);
          });
          for (const item of all) {
            const data = item.data || item;
            if (data && (data.id === cabinetId || String(item.key) === cabinetId)) {
              found = data;
              break;
            }
          }
          if (found) break;
        }
        db.close();
        if (!found) return JSON.stringify({ error: 'Cabinet not found: ' + cabinetId });
        return JSON.stringify({
          id: found.id,
          name: found.name,
          brandGoodId: found.obsBrandGoodId || '',
          parameters: found.parameters || {},
          position: found.position || {},
          rotation: found.parameters?.R || 0,
        });
      })()
    `)
  );

  // A4. Get BIM structure (walls, doors, windows, floors)
  server.tool(
    "coohom_get_bim_structure",
    "获取完整 BIM 结构数据（墙体、门窗、地板），通过浏览器内 fetch 调用 Coohom 内部API。",
    {
      tabId: z.number().describe("Coohom 同源页面的 Tab ID"),
      designId: z.string().describe("设计ID"),
    },
    async (args) => execInBrowser(args.tabId, `
      (async () => {
        const resp = await fetch('/gateway/kam/api/floorplan/v2/${args.designId}?draft=false', {
          credentials: 'include',
          headers: { 'Accept': 'application/json' }
        });
        if (!resp.ok) return JSON.stringify({ error: 'HTTP ' + resp.status });
        const data = await resp.json();
        const summary = {
          walls: (data.walls || []).length,
          doors: (data.doors || []).length,
          windows: (data.windows || []).length,
          floors: (data.floors || []).length,
          rooms: (data.rooms || []).length,
        };
        return JSON.stringify({ summary, data });
      })()
    `)
  );

  // A5. Scan full cabinet catalog (143+ models)
  server.tool(
    "coohom_scan_catalog",
    "扫描 Coohom 系统柜体目录，获取所有可用型号（需要先在BIM编辑器中按 Alt+4 打开定制柜面板）。",
    {
      tabId: z.number().describe("BIM 编辑器 Tab ID"),
    },
    async (args) => execInBrowser(args.tabId, `
      (async () => {
        // Read catalog tiles from the left panel (Alt+4 must be active)
        const categories = [];
        const catHeaders = document.querySelectorAll('.custom-cabinet-panel .category-header, .cabinet-category-title, [class*="category"] > [class*="title"]');
        if (catHeaders.length === 0) {
          return JSON.stringify({ error: '未检测到柜体目录面板。请先按 Alt+4 打开定制柜面板。' });
        }
        catHeaders.forEach(h => {
          const catName = h.textContent.trim();
          const tiles = [];
          let sibling = h.nextElementSibling;
          while (sibling && !sibling.matches('[class*="category-header"], [class*="category-title"]')) {
            const tileName = sibling.querySelector('[class*="tile-name"], [class*="item-name"], .name');
            if (tileName) tiles.push(tileName.textContent.trim());
            sibling = sibling.nextElementSibling;
          }
          if (tiles.length > 0) categories.push({ category: catName, models: tiles, count: tiles.length });
        });
        return JSON.stringify({ totalCategories: categories.length, totalModels: categories.reduce((s,c)=>s+c.count,0), categories });
      })()
    `)
  );

  // ===========================================================================
  // B-Group: Design Modification Tools (write operations)
  // ===========================================================================

  // B1. Fast parameter modification via IndexedDB write
  server.tool(
    "coohom_modify_cabinet_param",
    "快速修改柜子参数（直接写入 IndexedDB，不需要点击UI）。修改后需要刷新页面生效。参数示例：W=800, D=350, H=450, ST=18 等。",
    {
      tabId: z.number().describe("Tab ID"),
      cabinetId: z.string().describe("柜子ID"),
      designId: z.string().optional().describe("设计ID"),
      params: z.record(z.union([z.number(), z.string()])).describe("要修改的参数键值对，例如 {W: 800, D: 350, H: 450}"),
    },
    async (args) => execInBrowser(args.tabId, `
      (async () => {
        const designId = ${JSON.stringify(args.designId || '')} || new URLSearchParams(location.search).get('designid') || '';
        const cabinetId = ${JSON.stringify(args.cabinetId)};
        const newParams = ${JSON.stringify(args.params)};
        const db = await new Promise((res, rej) => {
          const req = indexedDB.open('customIncrData');
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
        const stores = Array.from(db.objectStoreNames).filter(s => s.includes(designId) && s.endsWith('-cabinet'));
        let updated = false;
        for (const storeName of stores) {
          const tx = db.transaction(storeName, 'readwrite');
          const store = tx.objectStore(storeName);
          const all = await new Promise((res, rej) => {
            const req = store.getAll();
            req.onsuccess = () => res(req.result);
            req.onerror = () => rej(req.error);
          });
          const keys = await new Promise((res, rej) => {
            const req = store.getAllKeys();
            req.onsuccess = () => res(req.result);
            req.onerror = () => rej(req.error);
          });
          for (let i = 0; i < all.length; i++) {
            const data = all[i].data || all[i];
            if (data && (data.id === cabinetId || String(keys[i]) === cabinetId)) {
              if (data.parameters) {
                Object.assign(data.parameters, newParams);
                const tx2 = db.transaction(storeName, 'readwrite');
                tx2.objectStore(storeName).put(all[i], keys[i]);
                await new Promise(res => { tx2.oncomplete = res; });
                updated = true;
              }
              break;
            }
          }
          if (updated) break;
        }
        db.close();
        return JSON.stringify({ success: updated, cabinetId, updatedParams: newParams,
          note: updated ? '参数已写入IndexedDB，刷新页面生效' : '未找到该柜子' });
      })()
    `)
  );

  // B2. Batch modify multiple cabinets
  server.tool(
    "coohom_batch_modify_params",
    "批量修改多个柜子的参数（直接 IndexedDB 写入）。",
    {
      tabId: z.number().describe("Tab ID"),
      designId: z.string().optional().describe("设计ID"),
      modifications: z.array(z.object({
        cabinetId: z.string(),
        params: z.record(z.union([z.number(), z.string()])),
      })).describe("修改列表，每项包含 cabinetId 和 params"),
    },
    async (args) => execInBrowser(args.tabId, `
      (async () => {
        const designId = ${JSON.stringify(args.designId || '')} || new URLSearchParams(location.search).get('designid') || '';
        const mods = ${JSON.stringify(args.modifications)};
        const db = await new Promise((res, rej) => {
          const req = indexedDB.open('customIncrData');
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
        const stores = Array.from(db.objectStoreNames).filter(s => s.includes(designId) && s.endsWith('-cabinet'));
        const results = [];
        for (const storeName of stores) {
          const tx = db.transaction(storeName, 'readwrite');
          const store = tx.objectStore(storeName);
          const all = await new Promise(r => { const q = store.getAll(); q.onsuccess = () => r(q.result); });
          const keys = await new Promise(r => { const q = store.getAllKeys(); q.onsuccess = () => r(q.result); });
          for (const mod of mods) {
            for (let i = 0; i < all.length; i++) {
              const data = all[i].data || all[i];
              if (data && (data.id === mod.cabinetId || String(keys[i]) === mod.cabinetId) && data.parameters) {
                Object.assign(data.parameters, mod.params);
                const tx2 = db.transaction(storeName, 'readwrite');
                tx2.objectStore(storeName).put(all[i], keys[i]);
                await new Promise(r => { tx2.oncomplete = r; });
                results.push({ cabinetId: mod.cabinetId, success: true });
                break;
              }
            }
          }
        }
        db.close();
        return JSON.stringify({ updated: results.length, results, note: '刷新页面生效' });
      })()
    `)
  );

  // ===========================================================================
  // C-Group: Coohom API Tools (REST API via browser fetch)
  // ===========================================================================

  // C1. Trigger production JSON export
  server.tool(
    "coohom_export_production_json",
    "触发 Coohom 生产JSON导出任务（异步，需要 PRO+ 账号）。返回 taskId 用于后续轮询。designType: 0=厨卫, 1=全屋家具。",
    {
      tabId: z.number().describe("Coohom 同源页面 Tab ID"),
      designId: z.string().describe("设计ID"),
      levelId: z.string().describe("楼层ID"),
      designType: z.number().default(0).describe("0=厨卫(Kitchen/Bath), 1=全屋家具(Whole house)"),
    },
    async (args) => execInBrowser(args.tabId, `
      (async () => {
        const resp = await fetch('/cos/api/c/customdesign/task/${args.designId}/designType/${args.designType}/taskType/6?levelid=${args.levelId}&usePackageQuotation=false', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'x-tool-name': 'diy',
            'x-qh-appid': '3FO4K4VY9XP6',
          },
        });
        const data = await resp.json();
        return JSON.stringify(data);
      })()
    `)
  );

  // C2. Poll task status
  server.tool(
    "coohom_poll_task_status",
    "轮询 Coohom 异步任务状态（配合 coohom_export_production_json 使用）。",
    {
      tabId: z.number().describe("Tab ID"),
      taskId: z.string().describe("任务ID（从 export 返回）"),
      designId: z.string().describe("设计ID"),
      levelId: z.string().describe("楼层ID"),
    },
    async (args) => execInBrowser(args.tabId, `
      (async () => {
        const resp = await fetch('/cos/api/c/customdesign/task/status/v2?obstaskid=${args.taskId}&obsdesignid=${args.designId}&levelid=${args.levelId}', {
          credentials: 'include',
        });
        const data = await resp.json();
        return JSON.stringify(data);
      })()
    `)
  );

  // C3. Get render types catalog
  server.tool(
    "coohom_get_render_types",
    "获取 Coohom 渲染类型目录（快照类型列表）。",
    {
      tabId: z.number().describe("Tab ID"),
    },
    async (args) => execInBrowser(args.tabId, `
      (async () => {
        const resp = await fetch('/gateway/drs/data/api/c/commonsnapshottypes', { credentials: 'include' });
        const data = await resp.json();
        return JSON.stringify(data);
      })()
    `)
  );

  // C4. Call any Coohom internal API (generic)
  server.tool(
    "coohom_fetch_api",
    "通用 Coohom 内部 API 调用工具。在浏览器上下文中执行 fetch，自动携带 Cookie 认证。",
    {
      tabId: z.number().describe("Coohom 同源页面 Tab ID"),
      path: z.string().describe("API路径，例如 /gateway/kam/api/floorplan/v2/xxx"),
      method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET").describe("HTTP方法"),
      body: z.string().optional().describe("POST/PUT 请求体（JSON字符串）"),
      headers: z.record(z.string()).optional().describe("额外的请求头"),
    },
    async (args) => execInBrowser(args.tabId, `
      (async () => {
        const opts = {
          method: ${JSON.stringify(args.method || 'GET')},
          credentials: 'include',
          headers: { 'Accept': 'application/json', ...${JSON.stringify(args.headers || {})} },
        };
        if (${JSON.stringify(args.body || '')} && ['POST','PUT'].includes(opts.method)) {
          opts.body = ${JSON.stringify(args.body || '')};
          opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/json';
        }
        const resp = await fetch(${JSON.stringify(args.path)}, opts);
        const text = await resp.text();
        try { return JSON.stringify({ status: resp.status, data: JSON.parse(text) }); }
        catch { return JSON.stringify({ status: resp.status, data: text }); }
      })()
    `)
  );
}
