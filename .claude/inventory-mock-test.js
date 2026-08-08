// .claude/inventory-mock-test.js
// web-manager 背包功能的 mock 测试：加载真实插件 + mock bot，通过真实 HTTP 接口和指令回调验证。
// 运行: node .claude/inventory-mock-test.js
'use strict';

const path = require('path');

let passed = 0;
let failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? '  —— ' + extra : ''}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- mock bot ----
const slots = Array.from({ length: 46 }, () => null);
slots[36] = { slot: 36, type: 1, metadata: 0, name: 'stone', displayName: '石头', count: 64, stackSize: 64, enchants: [] };
slots[40] = { slot: 40, type: 268, metadata: 0, name: 'diamond_sword', displayName: '钻石剑', count: 1, stackSize: 1, enchants: [{ name: 'sharpness' }] };
slots[10] = { slot: 10, type: 4, metadata: 0, name: 'cobblestone', displayName: '圆石', count: 32, stackSize: 64, enchants: [] };
slots[15] = { slot: 15, type: 4, metadata: 0, name: 'cobblestone', displayName: '圆石', count: 64, stackSize: 64, enchants: [] };
slots[16] = { slot: 16, type: 4, metadata: 0, name: 'cobblestone', displayName: '圆石', count: 16, stackSize: 64, enchants: [] };
// 重命名物品:1.21 自定义名在 custom_name 组件,displayName 仍是基础名。
// 真实形状(已验证):item.customName 是 prismarine-nbt 包装对象 {type:'string', value:'<JSON 文本组件>'}。
const renamed = (nameJson) => ({ type: 'string', value: nameJson });
slots[12] = { slot: 12, type: 268, metadata: 0, name: 'diamond_sword', displayName: '钻石剑', count: 1, stackSize: 1, enchants: [], customName: renamed('{"text":"我的神剑","color":"gold"}') };
slots[13] = { slot: 13, type: 268, metadata: 0, name: 'diamond_sword', displayName: '钻石剑', count: 1, stackSize: 1, enchants: [], customName: renamed('{"text":"另一把剑"}') };
slots[14] = { slot: 14, type: 268, metadata: 0, name: 'diamond_sword', displayName: '钻石剑', count: 1, stackSize: 5, enchants: [], customName: renamed('{"text":"我的神剑","color":"gold"}') };
slots[38] = { slot: 38, type: 268, metadata: 0, name: 'diamond_sword', displayName: '钻石剑', count: 1, stackSize: 1, enchants: [], customName: renamed('{"text":"神剑","color":"red"}') };
// 装备(盔甲栏规则测试用)
slots[17] = { slot: 17, type: 970, metadata: 0, name: 'diamond_helmet', displayName: '钻石头盔', count: 1, stackSize: 1, enchants: [] };
slots[18] = { slot: 18, type: 973, metadata: 0, name: 'diamond_boots', displayName: '钻石靴子', count: 1, stackSize: 1, enchants: [] };
// 纹理映射测试用(仓库中无 <name>.png 直接文件的物品)
slots[23] = { slot: 23, type: 355, metadata: 0, name: 'white_bed', displayName: '白床', count: 1, stackSize: 1, enchants: [] };
slots[24] = { slot: 24, type: 54, metadata: 0, name: 'chest', displayName: '箱子', count: 1, stackSize: 64, enchants: [] };
slots[25] = { slot: 25, type: 281, metadata: 0, name: 'crafter', displayName: '合成器', count: 1, stackSize: 64, enchants: [] };
slots[26] = { slot: 26, type: 345, metadata: 0, name: 'compass', displayName: '指南针', count: 1, stackSize: 64, enchants: [] };

const bot = {
  username: 'TestBot',
  entity: null,
  health: 20, food: 20,
  game: { gameMode: 'survival' },
  registry: { blocksByName: { stone: { name: 'stone' }, cobblestone: { name: 'cobblestone' } } },
  inventory: { slots, selectedItem: null, inventoryStart: 9, inventoryEnd: 45 },
  quickBarSlot: 0,
  currentWindow: null,
  _whispers: [],
  _droppedAll: null,
  _transferOpts: null,
  _qbCalls: [],
  _clicks: [],
  chat: () => {},
  whisper: (u, m) => { bot._whispers.push(m); },
  on: () => {},
  once: () => {},
  closeWindow: () => { bot.currentWindow = null; },
  setQuickBarSlot: (s) => { bot._qbCalls.push(s); bot.quickBarSlot = s; },
  tossStack: async (item) => { bot._droppedAll = { slot: item.slot, name: item.name, count: item.count }; },
  transfer: async (opts) => { bot._transferOpts = opts; },
  clickWindow: async (slot, mb, mode) => { bot._clicks.push([slot, mb, mode]); },
};

// ---- mock context ----
const registered = [];
const webManager = {
  tiles: new Map(),
  endpoints: new Map(),
  registerTile: (t) => webManager.tiles.set(t.name, t),
  registerEndpoint: (m, p, h, n, meta) => webManager.endpoints.set(`${m} ${p}`, { method: m, path: p, handler: h, pluginName: n, label: meta.label, dropdown: meta.dropdown }),
  _clearForPlugin: () => {},
  _endpointsFor: (n) => Array.from(webManager.endpoints.values()).filter(e => e.pluginName === n),
};
const context = {
  bot,
  config: { plugins: ['web-manager'] },
  state: {},
  permissions: { getLevel: () => 1 },
  pluginConfig: { host: '127.0.0.1', port: 0, token: '' },
  webManager,
  commands: { register: (c) => registered.push(c) },
};

(async () => {
  // ---- 加载真实插件 ----
  const plugin = require(path.join(__dirname, '..', 'plugins', 'web-manager', 'index.js'));
  plugin({ ...context, pluginName: 'web-manager' });
  await sleep(200);
  const port = context.state.webManager.server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
  const post = async (p, obj) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
    return { status: r.status, body: await r.json() };
  };

  console.log('[1] 接口: 背包状态');
  {
    const r = await get('/api/inventory');
    ok(r.status === 200, 'GET /api/inventory → 200');
    ok(r.body.available === true, 'available = true');
    ok(r.body.slots.length === 46, 'slots 数组长度 46');
    ok(r.body.slots[36] && r.body.slots[36].name === 'stone' && r.body.slots[36].count === 64, '快捷栏第 1 格 = 石头 ×64');
    ok(r.body.slots[40] && r.body.slots[40].enchanted === true, '钻石剑 enchanted = true');
    ok(r.body.quickBarSlot === 0, 'quickBarSlot = 0');
    ok(r.body.slots[5] === null && r.body.slots[45] === null, '空槽位为 null');
    ok(r.body.slots[36].block === true, '石头 block=true(纹理走 block/ 目录)');
    ok(r.body.slots[40].block === false, '钻石剑 block=false(纹理走 item/ 目录)');
  }

  console.log('[2] 接口: 丢出');
  {
    const r = await post('/api/inventory/drop', { slot: 36, count: 'all' });
    ok(r.status === 200 && r.body.ok, '丢出整组 → ok');
    ok(r.body.dropped && r.body.dropped.name === '石头' && r.body.dropped.count === 64, '响应包含丢出物品信息');
    ok(bot._droppedAll && bot._droppedAll.slot === 36, '调用 tossStack 且槽位正确');

    const r2 = await post('/api/inventory/drop', { slot: 10, count: 1 });
    ok(r2.status === 200 && r2.body.ok, '丢出 1 个 → ok');
    ok(bot._transferOpts && bot._transferOpts.count === 1, 'transfer count = 1');
    ok(bot._transferOpts && bot._transferOpts.sourceStart === 5 && bot._transferOpts.sourceEnd === 46, 'transfer 区间 5..46（含盔甲/副手）');
    ok(bot._transferOpts && bot._transferOpts.destStart === -999, 'transfer destStart = -999（丢出）');

    const r3 = await post('/api/inventory/drop', { slot: 36, count: 999 });
    ok(r3.body.ok && r3.body.dropped.count === 64, 'count >= 堆叠数按整组丢出');

    const r4 = await post('/api/inventory/drop', { slot: 11, count: 1 });
    ok(r4.status === 400, '丢空槽位 → 400');
    const r5 = await post('/api/inventory/drop', { slot: 2, count: 1 });
    ok(r5.status === 400, '合成栏槽位(2) → 400');
    const r6 = await post('/api/inventory/drop', { slot: 99, count: 1 });
    ok(r6.status === 400, '越界槽位(99) → 400');
    const r7 = await post('/api/inventory/drop', { slot: 10, count: 'x' });
    ok(r7.status === 400, '非法 count → 400');
  }

  console.log('[3] 接口: 快捷栏切换');
  {
    const r = await post('/api/inventory/select', { slot: 2 });
    ok(r.status === 200 && r.body.quickBarSlot === 2, 'select 2 → ok');
    ok(bot.quickBarSlot === 2, 'setQuickBarSlot 被调用(2)');
    const r2 = await post('/api/inventory/select', { slot: 9 });
    ok(r2.status === 400, '越界槽位(9) → 400');
  }

  console.log('[3.5] 接口: 移动物品(拖动)');
  {
    bot._clicks.length = 0;
    // 目标为空:整组移动
    const r = await post('/api/inventory/move', { from: 10, to: 20 });
    ok(r.status === 200 && r.body.ok, '移到空槽 → ok');
    ok(bot._transferOpts && bot._transferOpts.count === 32 && bot._transferOpts.destStart === 20 && bot._transferOpts.destEnd === 21, '整组移动参数正确(32 → 槽20)');
    ok(bot._transferOpts && bot._transferOpts.sourceStart === 10 && bot._transferOpts.sourceEnd === 11, '源区间锁定单槽(10..11)');

    // 同类可叠:圆石 32 → 槽16(圆石16,空位48) → 移动 32 个
    const r2 = await post('/api/inventory/move', { from: 10, to: 16 });
    ok(r2.status === 200, '同类合并 → ok');
    ok(bot._transferOpts && bot._transferOpts.count === 32 && bot._transferOpts.destStart === 16, '同类合并 count = min(32, 48) = 32');

    // 同类已满
    const r3 = await post('/api/inventory/move', { from: 10, to: 15 });
    ok(r3.status === 400 && r3.body.error.includes('已满'), '目标同类已满 → 400');

    // 不同类型:三连击互换
    const r4 = await post('/api/inventory/move', { from: 10, to: 40 });
    ok(r4.status === 200 && r4.body.ok, '不同类型互换 → ok');
    ok(JSON.stringify(bot._clicks) === JSON.stringify([[10, 0, 0], [40, 0, 0], [10, 0, 0]]), '互换点击序列 = [10, 40, 10]');

    // 参数校验
    const r5 = await post('/api/inventory/move', { from: 11, to: 20 });
    ok(r5.status === 400 && r5.body.error.includes('空'), '源槽位为空 → 400');
    const r6 = await post('/api/inventory/move', { from: 10, to: 10 });
    ok(r6.status === 400, '同一槽位 → 400');
    const r7 = await post('/api/inventory/move', { from: 2, to: 20 });
    ok(r7.status === 400, '合成栏槽位(2) → 400');
  }

  console.log('[3.6] 接口: 重命名物品');
  {
    const r = await get('/api/inventory');
    ok(r.body.slots[12] && r.body.slots[12].customName === '我的神剑', 'customName 解析为纯文本(去 JSON/颜色码)');
    ok(r.body.slots[12] && r.body.slots[12].displayName === '钻石剑', 'displayName 仍是基础名');
    ok(r.body.slots[12] && r.body.slots[12].name === 'diamond_sword', 'name 仍是基础注册名(图标不受影响)');
    ok(r.body.slots[13] && r.body.slots[13].customName === '另一把剑', '第二个重命名物品也解析');
    ok(r.body.slots[38] && r.body.slots[38].customName === '神剑', '快捷栏中的重命名物品也解析');

    // 不同自定义名的同型物品 → 互换而不是合并
    bot._clicks.length = 0;
    const r2 = await post('/api/inventory/move', { from: 12, to: 13 });
    ok(r2.status === 200 && r2.body.ok, '不同自定义名同型物品 → 互换 ok');
    ok(JSON.stringify(bot._clicks) === JSON.stringify([[12, 0, 0], [13, 0, 0], [12, 0, 0]]), '互换点击序列 [12, 13, 12]（未误判合并）');

    // 相同自定义名 + 有空位 → 走 transfer 合并
    const r3 = await post('/api/inventory/move', { from: 12, to: 14 });
    ok(r3.status === 200 && r3.body.ok, '相同自定义名(有空位) → 合并 ok');
    ok(bot._transferOpts && bot._transferOpts.count === 1 && bot._transferOpts.destStart === 14, '合并参数 count=1 目标槽14');
  }

  console.log('[3.8] 接口: 纹理映射(仓库无直接文件物品)');
  {
    const { resolveTex, TEX_MAP, NO_TEXTURE } = require(path.join(__dirname, '..', 'plugins', 'web-manager', 'texture-map.js'));
    ok(Object.keys(TEX_MAP).length === 456, 'TEX_MAP 共 456 条(离线对 1.21.11 仓库文件树全量验证)');
    ok(TEX_MAP.compass === 'item/compass_00', 'compass → 动画第一帧 compass_00');
    ok(TEX_MAP.white_bed === 'entity/bed/white', '白床 → entity/bed/white');
    ok(TEX_MAP.chest === 'entity/chest/normal', '箱子 → entity/chest/normal');
    ok(TEX_MAP.crafter === 'block/crafter_north', '合成器 → crafter_north');
    ok(TEX_MAP.skeleton_skull === 'entity/skeleton/skeleton', '骷髅头 → entity/skeleton/skeleton');
    ok(TEX_MAP.tnt === 'block/tnt_side', 'TNT → tnt_side');
    ok(NO_TEXTURE.has('air'), 'air 在无纹理白名单');

    // resolveTex 解析出 dir/file 结构
    const r = resolveTex('compass');
    ok(r && r.dir === 'item' && r.file === 'compass_00', 'resolveTex(compass) → {dir:item, file:compass_00}');
    const r2 = resolveTex('chest');
    ok(r2 && r2.dir === 'entity/chest' && r2.file === 'normal', 'resolveTex(chest) → {dir:entity/chest, file:normal}');
    const r3 = resolveTex('air');
    ok(r3 === null, 'resolveTex(air) → null(占位符)');
    ok(resolveTex('stone') === null, 'resolveTex(stone) → null(直接文件,前端走默认目录)');
    ok(resolveTex('diamond_sword') === null, 'resolveTex(diamond_sword) → null(直接文件)');

    // HTTP 层:itemInfo 携带 texDir/texName
    const r4 = await get('/api/inventory');
    ok(r4.body.slots[23] && r4.body.slots[23].texDir === 'entity/bed' && r4.body.slots[23].texName === 'white', '白床 texDir=entity/bed texName=white');
    ok(r4.body.slots[24] && r4.body.slots[24].texDir === 'entity/chest' && r4.body.slots[24].texName === 'normal', '箱子 texDir=entity/chest texName=normal');
    ok(r4.body.slots[25] && r4.body.slots[25].texDir === 'block' && r4.body.slots[25].texName === 'crafter_north', '合成器 texDir=block texName=crafter_north');
    ok(r4.body.slots[26] && r4.body.slots[26].texDir === 'item' && r4.body.slots[26].texName === 'compass_00', '指南针 texDir=item texName=compass_00');
    ok(r4.body.slots[36] && r4.body.slots[36].texDir === null, '石头(直接文件) texDir=null → 前端走默认 block/');
  }

  console.log('[3.7] 接口: 装备栏限制');
  {
    // 头盔 → 头部槽(5) 允许
    const r = await post('/api/inventory/move', { from: 17, to: 5 });
    ok(r.status === 200 && r.body.ok, '头盔 → 头部槽 → ok');
    ok(bot._transferOpts && bot._transferOpts.destStart === 5, '整组移入头部槽(transfer destStart=5)');

    // 头盔 → 脚部槽(8) 拒绝
    const r2 = await post('/api/inventory/move', { from: 17, to: 8 });
    ok(r2.status === 400 && r2.body.error.includes('装备栏'), '头盔 → 脚部槽 → 400');

    // 靴子 → 脚部槽(8) 允许
    const r3 = await post('/api/inventory/move', { from: 18, to: 8 });
    ok(r3.status === 200 && r3.body.ok, '靴子 → 脚部槽 → ok');

    // 非装备(圆石) → 头部槽 拒绝
    const r4 = await post('/api/inventory/move', { from: 10, to: 5 });
    ok(r4.status === 400 && r4.body.error.includes('装备栏'), '圆石 → 头部槽 → 400');

    // 装备从装备栏拖出 → 主背包(9) 允许
    const r5 = await post('/api/inventory/move', { from: 17, to: 9 });
    ok(r5.status === 200 && r5.body.ok, '头盔 → 主背包 → ok（可脱下）');
  }

  console.log('[4] 指令: !drop');
  {
    bot._whispers.length = 0;
    const drop = registered.find(c => c.name === 'drop');
    ok(!!drop && drop.permissionLevel === 1, '已注册 drop 指令(权限 1)');
    bot.quickBarSlot = 0; // 手持 = 槽36 石头
    drop.execute('tester', []);
    await sleep(10);
    ok(bot._droppedAll && bot._droppedAll.slot === 36, 'drop 丢出手持槽(36)');
    ok(bot._whispers.some(m => m.includes('已丢出 石头 × 64')), '私信确认: 已丢出 石头 × 64');

    bot._whispers.length = 0;
    bot.quickBarSlot = 4; // 槽40 现在是钻石剑
    drop.execute('tester', []);
    await sleep(10);
    ok(bot._whispers.some(m => m.includes('已丢出 钻石剑')), 'drop 丢出当前手持(钻石剑)');

    bot._whispers.length = 0;
    bot.inventory.slots[40] = null; // 手持变空
    drop.execute('tester', []);
    ok(bot._whispers.some(m => m.includes('当前没有手持物品')), '空手时提示');
    bot.inventory.slots[40] = { slot: 40, type: 268, metadata: 0, name: 'diamond_sword', displayName: '钻石剑', count: 1, stackSize: 1, enchants: [{ name: 'sharpness' }] };

    bot._whispers.length = 0;
    bot.quickBarSlot = 2; // 槽38 = 重命名物品(自定义名 神剑)
    drop.execute('tester', []);
    await sleep(10);
    ok(bot._whispers.some(m => m.includes('已丢出 神剑')), 'drop 提示使用自定义名(神剑)');
  }

  console.log('[5] 指令: !cginv');
  {
    const cginv = registered.find(c => c.name === 'cginv');
    ok(!!cginv && cginv.permissionLevel === 1, '已注册 cginv 指令(权限 1)');
    bot._qbCalls.length = 0; bot._whispers.length = 0;
    cginv.execute('tester', ['3']);
    ok(bot._qbCalls[bot._qbCalls.length - 1] === 2, 'cginv 3 → 快捷栏槽 2（第 3 格）');
    cginv.execute('tester', ['1']);
    ok(bot._qbCalls[bot._qbCalls.length - 1] === 0, 'cginv 1 → 槽 0');
    cginv.execute('tester', ['9']);
    ok(bot._qbCalls[bot._qbCalls.length - 1] === 8, 'cginv 9 → 槽 8');
    cginv.execute('tester', ['0']);
    ok(bot._qbCalls[bot._qbCalls.length - 1] === 0, 'cginv 0 → 槽 0');
    cginv.execute('tester', ['10']);
    ok(bot._whispers.some(m => m.includes('用法')), 'cginv 10 → 用法提示');
    cginv.execute('tester', ['abc']);
    ok(bot._whispers.some(m => m.includes('用法')), 'cginv abc → 用法提示');
    ok(bot._whispers.some(m => m.includes('第 3 格')), '切换确认消息含格子序号');
  }

  console.log('[6] 接口: 页面/认证');
  {
    const r = await fetch(base + '/');
    ok(r.status === 200 && (await r.text()).includes('背包'), '页面含背包区');
    const r2 = await get('/api/inventory?token=bad');
    ok(r2.status === 200, '无 token 配置时任意 token 放行');
  }

  context.state.webManager.server.close();
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('测试崩溃:', err);
  process.exit(1);
});
