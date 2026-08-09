const fs = require('fs');
const path = require('path');
const { GoalNear } = require('mineflayer-pathfinder').goals;
const zhCnItems = require('../stock-prep/zh_cn_items.json');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = (context) => {
  const { bot, commands, pluginConfig, pluginName, webManager, state } = context;
  const configFile = path.join(__dirname, 'config.json');
  const stockPrepConfigFile = path.join(__dirname, '..', 'stock-prep', 'config.json');
  const panelFile = path.join(__dirname, 'panel.html');

  const loadWarehouseDefaults = () => {
    try {
      if (fs.existsSync(stockPrepConfigFile)) {
        const cfg = JSON.parse(fs.readFileSync(stockPrepConfigFile, 'utf8'));
        return {
          warehouseMode: cfg.warehouseMode,
          warehouseCenter: cfg.warehouseCenter,
          warehouseSize: cfg.warehouseSize,
          warehouseBlocks: cfg.warehouseBlocks,
          warehouseContainers: cfg.warehouseContainers,
          maxStorageBlocksScan: cfg.maxStorageBlocksScan,
        };
      }
    } catch (err) {}
    return {};
  };

  const cfg = {
    enabled: true,
    hungerThreshold: 16,
    emergencyThreshold: 8,
    scanIntervalMs: 5000,
    eatCooldownMs: 1200,
    withdrawCount: 8,
    moveTimeoutMs: 25000,
    blockApproachDistance: 2,
    warehouseMode: 'area',
    warehouseBlocks: ['chest', 'trapped_chest', 'barrel'],
    warehouseCenter: { x: 0, y: 64, z: 0 },
    warehouseSize: { x: 16, y: 8, z: 16 },
    warehouseContainers: [],
    maxStorageBlocksScan: 128,
    ...(loadWarehouseDefaults()),
    ...(pluginConfig || {}),
  };

  const st = state.autoEat || (state.autoEat = {
    running: false,
    busy: false,
    timer: null,
    lastActionAt: 0,
    lastStatus: 'idle',
    lastError: null,
    foodStock: {
      items: [],
      scannedAt: null,
      lastError: null,
      scanning: false,
    },
  });

  const ok = (res, data = {}) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, ...data }));
  };

  const fail = (res, status, error) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error }));
  };

  const normalizeKey = (value) => String(value || '').trim().toLowerCase().replace(/^minecraft:/, '').replace(/[\s_-]+/g, '');

  const isChineseText = (value) => /[\u3400-\u9fff]/.test(String(value || ''));

  const preferredLabelForItem = (itemName, displayName = null) => {
    const cn = Object.entries(zhCnItems).find(([key, label]) => label === itemName && isChineseText(key));
    if (cn) return cn[0];
    return displayName || itemName;
  };

  const itemByName = (name) => bot.registry && bot.registry.itemsByName ? bot.registry.itemsByName[name] : null;
  const isFoodName = (name) => {
    const item = itemByName(name);
    return !!(item && (item.foodPoints || item.foodPoints === 0) && item.foodPoints > 0);
  };

  const foodInfo = (item) => {
    const meta = itemByName(item.name) || {};
    return {
      name: item.name,
      displayName: preferredLabelForItem(item.name, meta.displayName || item.displayName || item.name),
      count: item.count,
      foodPoints: meta.foodPoints || 0,
      saturation: meta.saturation || 0,
    };
  };

  const inventoryFoodItems = () => (bot.inventory && typeof bot.inventory.items === 'function')
    ? bot.inventory.items().filter((item) => item && isFoodName(item.name))
    : [];

  const chooseBestFood = (items) => {
    const scored = items.map((item) => {
      const meta = itemByName(item.name) || {};
      return {
        item,
        score: (meta.foodPoints || 0) * 1000 + (meta.saturation || 0) * 100 + (item.count || 0),
      };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0] ? scored[0].item : null;
  };

  const insideWarehouse = (position) => {
    if (!position) return false;
    if (String(cfg.warehouseMode || 'area') === 'list') {
      return normalizedWarehouseContainers().some((target) => {
        const dx = Math.abs(position.x - target.x);
        const dy = Math.abs(position.y - target.y);
        const dz = Math.abs(position.z - target.z);
        return dx <= 3 && dy <= 3 && dz <= 3;
      });
    }
    if (!cfg.warehouseCenter || !cfg.warehouseSize) return false;
    const dx = Math.abs(position.x - Number(cfg.warehouseCenter.x || 0));
    const dy = Math.abs(position.y - Number(cfg.warehouseCenter.y || 0));
    const dz = Math.abs(position.z - Number(cfg.warehouseCenter.z || 0));
    return dx <= Number(cfg.warehouseSize.x || 0) &&
      dy <= Number(cfg.warehouseSize.y || 0) &&
      dz <= Number(cfg.warehouseSize.z || 0);
  };

  const normalizeAxisGroup = (value, label) => {
    if (!value || typeof value !== 'object') throw new Error(`${label} 必须是对象`);
    const x = Number(value.x);
    const y = Number(value.y);
    const z = Number(value.z);
    if (![x, y, z].every(Number.isFinite)) throw new Error(`${label} 的 x/y/z 必须是数字`);
    return { x, y, z };
  };

  const normalizedWarehouseContainers = () => {
    if (!Array.isArray(cfg.warehouseContainers)) return [];
    return cfg.warehouseContainers
      .map((entry) => {
        try { return normalizeAxisGroup(entry, 'warehouseContainers'); }
        catch (err) { return null; }
      })
      .filter(Boolean);
  };

  const warehouseFocusPoint = () => {
    if (String(cfg.warehouseMode || 'area') === 'list') {
      return normalizedWarehouseContainers()[0] || null;
    }
    return cfg.warehouseCenter || null;
  };

  const blockIds = (names) => {
    const reg = bot.registry && bot.registry.blocksByName ? bot.registry.blocksByName : {};
    return names.map((name) => reg[name] && reg[name].id).filter((id) => Number.isInteger(id));
  };

  const warehouseContainerPositions = () => {
    const ids = blockIds(cfg.warehouseBlocks);
    if (String(cfg.warehouseMode || 'area') === 'list') {
      return normalizedWarehouseContainers().filter((pos) => {
        const block = bot.blockAt(pos);
        return !!(block && ids.includes(block.type));
      });
    }
    if (typeof bot.findBlocks !== 'function') return [];
    if (!ids.length) return [];
    const center = bot.entity && bot.entity.position ? bot.entity.position : cfg.warehouseCenter;
    const maxDistance = Math.max(Number(cfg.warehouseSize.x || 0), Number(cfg.warehouseSize.y || 0), Number(cfg.warehouseSize.z || 0)) + 8;
    try {
      return (bot.findBlocks({ point: center, matching: ids, maxDistance, count: cfg.maxStorageBlocksScan }) || []).filter(insideWarehouse);
    } catch (err) {
      return [];
    }
  };

  const moveToWarehouseCenter = async () => {
    const focus = warehouseFocusPoint();
    if (!focus) throw new Error(String(cfg.warehouseMode || 'area') === 'list' ? '未配置仓库箱子坐标' : '未配置仓库中心');
    if (!bot.pathfinder) throw new Error('未检测到寻路模块，请先启用 navigator 插件');
    if (insideWarehouse(bot.entity && bot.entity.position)) return;
    const target = focus;
    bot.pathfinder.setGoal(new GoalNear(Number(target.x || 0), Number(target.y || 0), Number(target.z || 0), 3));
    const started = Date.now();
    while (Date.now() - started < cfg.moveTimeoutMs) {
      if (!bot.entity || !bot.entity.position) throw new Error('机器人未进入世界');
      if (bot.entity.position.distanceTo({ x: Number(target.x || 0), y: Number(target.y || 0), z: Number(target.z || 0) }) <= 4) return;
      await sleep(200);
    }
    throw new Error('前往仓库超时');
  };

  const approachBlock = async (block, distance = cfg.blockApproachDistance) => {
    if (!block || !block.position) throw new Error('目标方块不可用');
    if (!bot.pathfinder) throw new Error('未检测到寻路模块，请先启用 navigator 插件');
    bot.pathfinder.setGoal(new GoalNear(block.position.x, block.position.y, block.position.z, Math.max(1, Math.ceil(distance))));
    const started = Date.now();
    while (Date.now() - started < cfg.moveTimeoutMs) {
      if (!bot.entity || !bot.entity.position) throw new Error('机器人未进入世界');
      if (bot.entity.position.distanceTo(block.position) <= distance + 0.8) return;
      await sleep(200);
    }
    throw new Error('接近容器超时');
  };

  const openContainerBlock = async (block) => {
    if (typeof bot.openContainer === 'function') return bot.openContainer(block);
    if (typeof bot.openChest === 'function') return bot.openChest(block);
    throw new Error('当前机器人不支持打开容器');
  };

  const containerItems = (container) => {
    if (!container) return [];
    if (typeof container.containerItems === 'function') return container.containerItems();
    if (typeof container.items === 'function') return container.items();
    return Array.isArray(container.slots) ? container.slots.filter(Boolean) : [];
  };

  const scanWarehouseFood = async () => {
    if (st.foodStock.scanning) return st.foodStock;
    st.foodStock.scanning = true;
    st.foodStock.lastError = null;
    try {
      await moveToWarehouseCenter();
      const merged = new Map();
      for (const pos of warehouseContainerPositions()) {
        const block = bot.blockAt(pos);
        if (!block) continue;
        try {
          await approachBlock(block, cfg.blockApproachDistance);
          const container = await openContainerBlock(block);
          try {
            for (const item of containerItems(container)) {
              if (!item || !item.name || !isFoodName(item.name)) continue;
              const current = merged.get(item.name) || {
                name: item.name,
                displayName: preferredLabelForItem(item.name, (itemByName(item.name) || {}).displayName || item.displayName || item.name),
                count: 0,
                foodPoints: (itemByName(item.name) || {}).foodPoints || 0,
                saturation: (itemByName(item.name) || {}).saturation || 0,
              };
              current.count += item.count;
              merged.set(item.name, current);
            }
          } finally {
            if (typeof container.close === 'function') {
              try { container.close(); } catch (err) {}
            }
          }
        } catch (err) {
          st.foodStock.lastError = `扫描 ${block.name} 失败: ${err.message}`;
        }
      }
      st.foodStock.items = Array.from(merged.values()).sort((a, b) => b.foodPoints - a.foodPoints || b.count - a.count || a.displayName.localeCompare(b.displayName, 'zh-CN'));
      st.foodStock.scannedAt = Date.now();
      return st.foodStock;
    } finally {
      st.foodStock.scanning = false;
    }
  };

  const withdrawFoodFromWarehouse = async () => {
    const scan = await scanWarehouseFood();
    const best = chooseBestFood(scan.items);
    if (!best) return null;
    const need = Math.max(1, Math.ceil((20 - (bot.food ?? 20)) / Math.max(1, (itemByName(best.name) || {}).foodPoints || 4)));
    let remaining = Math.min(cfg.withdrawCount, Math.max(1, need));
    for (const pos of warehouseContainerPositions()) {
      if (remaining <= 0) break;
      const block = bot.blockAt(pos);
      if (!block) continue;
      try {
        await approachBlock(block, cfg.blockApproachDistance);
        const container = await openContainerBlock(block);
        try {
          const stack = containerItems(container).find((item) => item && item.name === best.name);
          if (!stack) continue;
          const amount = Math.min(remaining, stack.count);
          await container.withdraw(stack.type, stack.metadata, amount);
          remaining -= amount;
        } finally {
          if (typeof container.close === 'function') {
            try { container.close(); } catch (err) {}
          }
        }
      } catch (err) {
        st.lastError = err.message;
      }
    }
    return chooseBestFood(inventoryFoodItems());
  };

  const eatFood = async () => {
    const item = chooseBestFood(inventoryFoodItems());
    if (!item) return false;
    if (bot.food != null && bot.food >= 20) return true;
    st.busy = true;
    try {
      st.lastStatus = `正在吃 ${preferredLabelForItem(item.name, (itemByName(item.name) || {}).displayName || item.name)}`;
      await bot.eat(item);
      st.lastActionAt = Date.now();
      st.lastStatus = '已进食';
      return true;
    } finally {
      st.busy = false;
    }
  };

  const ensureFood = async () => {
    if (!cfg.enabled || st.busy) return;
    const currentFood = bot.food ?? 20;
    if (currentFood > cfg.hungerThreshold) return;
    st.busy = true;
    try {
      st.lastStatus = `饥饿值 ${currentFood}，开始找食物`;
      if (await eatFood()) return;
      st.lastStatus = '背包没吃的，去仓库找';
      const found = await withdrawFoodFromWarehouse();
      if (found) {
        await sleep(cfg.eatCooldownMs);
        await eatFood();
      } else {
        st.lastStatus = '仓库里没有找到食物';
      }
    } catch (err) {
      st.lastError = err.message;
      st.lastStatus = '自动进食失败';
    } finally {
      st.busy = false;
    }
  };

  const persistConfig = () => {
    fs.writeFileSync(configFile, JSON.stringify({
      enabled: cfg.enabled,
      hungerThreshold: cfg.hungerThreshold,
      emergencyThreshold: cfg.emergencyThreshold,
      scanIntervalMs: cfg.scanIntervalMs,
      eatCooldownMs: cfg.eatCooldownMs,
      withdrawCount: cfg.withdrawCount,
      moveTimeoutMs: cfg.moveTimeoutMs,
      blockApproachDistance: cfg.blockApproachDistance,
      warehouseMode: cfg.warehouseMode,
      warehouseBlocks: cfg.warehouseBlocks,
      warehouseCenter: cfg.warehouseCenter,
      warehouseSize: cfg.warehouseSize,
      warehouseContainers: cfg.warehouseContainers,
      maxStorageBlocksScan: cfg.maxStorageBlocksScan,
    }, null, 2));
  };

  const statusPayload = () => ({
    enabled: cfg.enabled,
    hungerThreshold: cfg.hungerThreshold,
    emergencyThreshold: cfg.emergencyThreshold,
    scanIntervalMs: cfg.scanIntervalMs,
    eatCooldownMs: cfg.eatCooldownMs,
    withdrawCount: cfg.withdrawCount,
    warehouseMode: cfg.warehouseMode,
    warehouseCenter: cfg.warehouseCenter,
    warehouseBlocks: cfg.warehouseBlocks,
    warehouseContainers: normalizedWarehouseContainers(),
    busy: st.busy,
    lastActionAt: st.lastActionAt,
    lastStatus: st.lastStatus,
    lastError: st.lastError,
    hunger: bot.food ?? null,
    foodItems: inventoryFoodItems().map(foodInfo),
    warehouseFood: st.foodStock.items,
    scannedAt: st.foodStock.scannedAt,
  });

  const ep = (method, rel, handler) => {
    webManager.registerEndpoint(method, `/api/plugins/${pluginName}/${rel}`, async (req, res, url, body) => {
      try { await handler(req, res, url, body); }
      catch (err) { fail(res, 400, err.message); }
    }, pluginName);
  };

  ep('GET', 'panel', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(panelFile, 'utf8'));
  });

  ep('GET', 'status', (req, res) => ok(res, { status: statusPayload() }));

  ep('POST', 'scan', async (req, res) => {
    const stock = await scanWarehouseFood();
    ok(res, { stock });
  });

  ep('POST', 'eat', async (req, res) => {
    const r = await eatFood();
    ok(res, { ok: r });
  });

  ep('PUT', 'settings', (req, res, url, body) => {
    let obj;
    try { obj = JSON.parse(body || 'null') || {}; } catch (err) { return fail(res, 400, '无效 JSON'); }
    if (typeof obj.enabled !== 'undefined') cfg.enabled = !!obj.enabled;
    if (typeof obj.hungerThreshold !== 'undefined') cfg.hungerThreshold = Number(obj.hungerThreshold);
    if (typeof obj.emergencyThreshold !== 'undefined') cfg.emergencyThreshold = Number(obj.emergencyThreshold);
    if (typeof obj.scanIntervalMs !== 'undefined') cfg.scanIntervalMs = Number(obj.scanIntervalMs);
    if (typeof obj.eatCooldownMs !== 'undefined') cfg.eatCooldownMs = Number(obj.eatCooldownMs);
    if (typeof obj.withdrawCount !== 'undefined') cfg.withdrawCount = Number(obj.withdrawCount);
    if (typeof obj.warehouseMode !== 'undefined') {
      const mode = String(obj.warehouseMode || '').trim().toLowerCase();
      if (!['area', 'list'].includes(mode)) throw new Error('warehouseMode 只能是 area 或 list');
      cfg.warehouseMode = mode;
    }
    if (typeof obj.warehouseCenter === 'object') cfg.warehouseCenter = normalizeAxisGroup(obj.warehouseCenter, 'warehouseCenter');
    if (typeof obj.warehouseSize === 'object') cfg.warehouseSize = normalizeAxisGroup(obj.warehouseSize, 'warehouseSize');
    if (Array.isArray(obj.warehouseBlocks)) cfg.warehouseBlocks = obj.warehouseBlocks;
    if (Array.isArray(obj.warehouseContainers)) cfg.warehouseContainers = obj.warehouseContainers.map((entry, index) => normalizeAxisGroup(entry, `warehouseContainers[${index}]`));
    if (typeof obj.maxStorageBlocksScan !== 'undefined') cfg.maxStorageBlocksScan = Number(obj.maxStorageBlocksScan);
    persistConfig();
    ok(res, { status: statusPayload() });
  });

  commands.register({
    name: 'autoeat',
    permissionLevel: 1,
    description: '自动吃东西: !autoeat on/off/status',
    execute: async (username, args) => {
      const sub = String(args[0] || 'status').toLowerCase();
      if (sub === 'on') {
        cfg.enabled = true;
        persistConfig();
        bot.whisper(username, '> 自动吃饭已开启。');
      } else if (sub === 'off') {
        cfg.enabled = false;
        persistConfig();
        bot.whisper(username, '> 自动吃饭已关闭。');
      } else if (sub === 'scan') {
        await scanWarehouseFood();
        bot.whisper(username, '> 已扫描仓库食物。');
      } else {
        bot.whisper(username, `> 状态：${cfg.enabled ? '开启' : '关闭'}，饥饿阈值 ${cfg.hungerThreshold}，当前饥饿 ${bot.food ?? '-'}`);
      }
    },
  });

  if (!st.timer) {
    st.running = true;
    st.timer = setInterval(() => {
      ensureFood().catch((err) => {
        st.lastError = err.message;
      });
    }, Math.max(1000, cfg.scanIntervalMs));
    if (typeof st.timer.unref === 'function') st.timer.unref();
  }

  bot.on('spawn', () => {
    st.lastStatus = '已进入世界';
  });

  webManager.registerTile({
    name: pluginName,
    title: '自动吃饭',
    description: '饥饿值降低后自动吃背包食物；没有就去仓库箱子找',
    panel: `/api/plugins/${pluginName}/panel`,
    endpoints: {},
  });

  console.log('[auto-eat] 插件已加载');
};
