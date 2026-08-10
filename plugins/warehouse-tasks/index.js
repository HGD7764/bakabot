const fs = require('fs');
const path = require('path');
const { GoalNear } = require('mineflayer-pathfinder').goals;
const { Vec3 } = require('vec3');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = (context) => {
  const { bot, commands, pluginConfig, pluginName, webManager, state } = context;
  const configFile = path.join(__dirname, 'config.json');
  const panelFile = path.join(__dirname, 'panel.html');

  const cfg = {
    enabled: true,
    reconcileIntervalMs: 1500,
    collectPauseMs: 350,
    moveTimeoutMs: 25000,
    handoffDistance: 2.5,
    blockApproachDistance: 2,
    maxStorageBlocksScan: 128,
    warehouseMode: 'area',
    warehouseBlocks: ['chest', 'trapped_chest', 'barrel'],
    warehouseCenter: { x: 0, y: 64, z: 0 },
    warehouseSize: { x: 16, y: 8, z: 16 },
    containerSearchRadius: { x: 16, y: 8, z: 16 },
    warehouseContainers: [],
    deliveryTeleportCommand: '/tpa {player}',
    deliveryTeleportWaitMs: 3500,
    requestCommandPermissionLevel: 0,
    aliases: {},
    ...(pluginConfig || {}),
  };

  const st = state.warehouseTasks || (state.warehouseTasks = {
    nextId: 1,
    tasks: [],
    busy: false,
    lastStatus: 'idle',
    lastError: null,
    activeTaskId: null,
    stock: { items: [], scannedAt: null, lastError: null, scanning: false },
    timer: null,
  });

  const sendJSON = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  };

  const fail = (res, status, error) => sendJSON(res, status, { ok: false, error });
  const ok = (res, data = {}) => sendJSON(res, 200, { ok: true, ...data });

  const normalizeKey = (value) => String(value || '').trim().toLowerCase().replace(/^minecraft:/, '').replace(/[\s_-]+/g, '');
  const isFinitePoint = (v) => v && Number.isFinite(Number(v.x)) && Number.isFinite(Number(v.y)) && Number.isFinite(Number(v.z));

  const itemRegistry = () => (bot.registry && bot.registry.itemsByName) ? bot.registry.itemsByName : {};
  const blockRegistry = () => (bot.registry && bot.registry.blocksByName) ? bot.registry.blocksByName : {};

  const countInInventory = (itemName) => (bot.inventory && typeof bot.inventory.items === 'function')
    ? bot.inventory.items().filter((item) => item && item.name === itemName).reduce((sum, item) => sum + item.count, 0)
    : 0;

  const whisperSafe = (username, message) => {
    try { bot.whisper(username, message); } catch (err) {}
  };

  const preferredLabelForItem = (itemName, displayName = null) => {
    for (const [label, name] of Object.entries(cfg.aliases || {})) {
      if (name === itemName && /[\u3400-\u9fff]/.test(label)) return label;
    }
    return displayName || itemName;
  };

  const resolveItem = (input) => {
    const raw = String(input || '').trim();
    if (!raw) return null;
    const aliased = cfg.aliases[raw] || cfg.aliases[normalizeKey(raw)] || raw;
    const name = String(aliased).trim().toLowerCase().replace(/^minecraft:/, '');
    const registry = itemRegistry();
    if (registry[name]) {
      const meta = registry[name];
      return { name: meta.name, displayName: preferredLabelForItem(meta.name, meta.displayName || meta.name) };
    }
    for (const meta of Object.values(registry)) {
      if (!meta) continue;
      if (normalizeKey(meta.name) === normalizeKey(raw) || normalizeKey(meta.displayName || '') === normalizeKey(raw)) {
        return { name: meta.name, displayName: preferredLabelForItem(meta.name, meta.displayName || meta.name) };
      }
    }
    if (/^[a-z0-9_]+$/.test(name)) return { name, displayName: name };
    return null;
  };

  const taskTerminalStates = new Set(['cancelled', 'delivered', 'failed']);
  const isTerminal = (task) => taskTerminalStates.has(String(task && task.status || ''));
  const activeTasks = () => st.tasks.filter((task) => !isTerminal(task)).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || (a.id || 0) - (b.id || 0));
  const taskById = (id) => st.tasks.find((task) => task.id === Number(id));

  const createTask = ({ itemName, displayName, requestedCount, targetPlayer, source = 'web', autoDeliver = true }) => {
    if (st.tasks.length >= 50) throw new Error('任务太多了，先处理掉几个再加');
    const task = {
      id: st.nextId++,
      createdAt: Date.now(),
      status: 'pending',
      itemName,
      displayName,
      requestedCount,
      collectedCount: 0,
      remainingCount: requestedCount,
      progress: 0,
      targetPlayer,
      autoDeliver,
      source,
      baselineCount: countInInventory(itemName),
      lastError: null,
      lastStep: source === 'command' ? '已收到 want 指令' : '已创建',
      lastSeenAt: Date.now(),
    };
    normalizeTask(task);
    st.tasks.push(task);
    st.lastStatus = `新任务：${task.displayName || task.itemName} × ${task.requestedCount}`;
    return task;
  };

  const normalizeTask = (task) => {
    if (!task) return task;
    const have = countInInventory(task.itemName) - (task.baselineCount || 0);
    task.collectedCount = Math.max(0, Math.min(task.requestedCount || 0, have));
    task.remainingCount = Math.max(0, (task.requestedCount || 0) - task.collectedCount);
    task.progress = (task.requestedCount || 0) > 0 ? Math.min(1, task.collectedCount / task.requestedCount) : 0;
    task.lastSeenAt = Date.now();
    return task;
  };

  const normalizeAxisGroup = (value, label) => {
    if (!isFinitePoint(value)) throw new Error(`${label} 必须是 {x,y,z} 数字对象`);
    return { x: Number(value.x), y: Number(value.y), z: Number(value.z) };
  };

  const warehouseContainers = () => {
    if (String(cfg.warehouseMode || 'area') === 'list') {
      return (Array.isArray(cfg.warehouseContainers) ? cfg.warehouseContainers : [])
        .map((entry) => {
          try { return normalizeAxisGroup(entry, 'warehouseContainers'); } catch (err) { return null; }
        })
        .filter(Boolean);
    }
    return [];
  };

  const warehouseBlockIds = () => (Array.isArray(cfg.warehouseBlocks) ? cfg.warehouseBlocks : [])
    .map((name) => blockRegistry()[String(name || '').replace(/^minecraft:/, '')]?.id)
    .filter((id) => Number.isInteger(id));

  const insideWarehouse = (pos) => {
    if (!pos) return false;
    if (String(cfg.warehouseMode || 'area') === 'list') {
      return warehouseContainers().some((target) => (
        Math.abs(pos.x - target.x) <= 3 &&
        Math.abs(pos.y - target.y) <= 3 &&
        Math.abs(pos.z - target.z) <= 3
      ));
    }
    const center = cfg.warehouseCenter;
    const size = cfg.containerSearchRadius || cfg.warehouseSize;
    return Math.abs(pos.x - Number(center.x || 0)) <= Number(size.x || 0) &&
      Math.abs(pos.y - Number(center.y || 0)) <= Number(size.y || 0) &&
      Math.abs(pos.z - Number(center.z || 0)) <= Number(size.z || 0);
  };

  const warehouseFocusPoint = () => (String(cfg.warehouseMode || 'area') === 'list' ? warehouseContainers()[0] : cfg.warehouseCenter);

  const stopPathfinder = () => {
    try {
      if (bot.pathfinder && typeof bot.pathfinder.stop === 'function') return bot.pathfinder.stop();
      if (bot.pathfinder && typeof bot.pathfinder.setGoal === 'function') bot.pathfinder.setGoal(null);
    } catch (err) {}
  };

  const moveNear = async (target, distance, timeout, label) => {
    if (!bot.pathfinder) throw new Error(`未启用寻路模块，无法${label || '移动'}`);
    bot.pathfinder.setGoal(new GoalNear(Number(target.x), Number(target.y), Number(target.z), Math.max(1, Math.ceil(distance))));
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (!bot.entity || !bot.entity.position) throw new Error('机器人未进入世界');
      if (bot.entity.position.distanceTo(target) <= distance + 0.8) {
        stopPathfinder();
        return;
      }
      await sleep(200);
    }
    throw new Error(`${label || '移动'}超时`);
  };

  const moveToWarehouseCenter = async () => {
    const focus = warehouseFocusPoint();
    if (!focus) throw new Error(String(cfg.warehouseMode || 'area') === 'list' ? '未配置仓库箱子坐标' : '未配置仓库中心');
    if (insideWarehouse(bot.entity && bot.entity.position)) {
      stopPathfinder();
      return;
    }
    await moveNear(new Vec3(Number(focus.x || 0), Number(focus.y || 0), Number(focus.z || 0)), 3, cfg.moveTimeoutMs, '前往仓库');
  };

  const approachBlock = async (block) => {
    if (!block || !block.position) throw new Error('目标方块不可用');
    await moveNear(block.position, Math.max(1, Number(cfg.blockApproachDistance || 2)), cfg.moveTimeoutMs, '接近容器');
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

  const openAndClose = async (block, fn) => {
    const container = await openContainerBlock(block);
    try { return await fn(container); }
    finally {
      if (container && typeof container.close === 'function') {
        try { container.close(); } catch (err) {}
      }
    }
  };

  const scanWarehouseStock = async () => {
    if (st.stock.scanning) return st.stock;
    st.stock.scanning = true;
    st.stock.lastError = null;
    try {
      await moveToWarehouseCenter();
      const merged = new Map();
      for (const pos of warehousePositions()) {
        const block = bot.blockAt(pos);
        if (!block) continue;
        try {
          await approachBlock(block);
          await openAndClose(block, async (container) => {
            for (const item of containerItems(container)) {
              if (!item || !item.name) continue;
              const current = merged.get(item.name) || {
                name: item.name,
                displayName: preferredLabelForItem(item.name, item.displayName || item.name),
                count: 0,
              };
              current.count += item.count || 0;
              merged.set(item.name, current);
            }
          });
        } catch (err) {
          st.stock.lastError = err.message;
        }
      }
      st.stock.items = Array.from(merged.values()).sort((a, b) => b.count - a.count || a.displayName.localeCompare(b.displayName, 'zh-CN'));
      st.stock.scannedAt = Date.now();
      return st.stock;
    } finally {
      st.stock.scanning = false;
    }
  };

  const warehousePositions = () => {
    const ids = warehouseBlockIds();
    if (!ids.length) return [];
    if (String(cfg.warehouseMode || 'area') === 'list') {
      return warehouseContainers().filter((pos) => {
        const block = bot.blockAt(pos);
        return !!(block && ids.includes(block.type));
      });
    }
    if (typeof bot.findBlocks !== 'function') return [];
    const center = bot.entity && bot.entity.position
      ? bot.entity.position
      : new Vec3(Number(cfg.warehouseCenter.x || 0), Number(cfg.warehouseCenter.y || 0), Number(cfg.warehouseCenter.z || 0));
    const maxDistance = Math.max(Number(cfg.warehouseSize.x || 0), Number(cfg.warehouseSize.y || 0), Number(cfg.warehouseSize.z || 0)) + 8;
    try {
      return (bot.findBlocks({ point: center, matching: ids, maxDistance, count: cfg.maxStorageBlocksScan }) || []).filter(insideWarehouse);
    } catch (err) {
      return [];
    }
  };

  const withdrawFromContainer = async (container, item, amount) => {
    const count = Math.max(1, Math.floor(Number(amount || 0)));
    if (count <= 0) return;
    if (typeof container.withdraw === 'function') {
      return container.withdraw(item.type, item.metadata, count);
    }
    throw new Error('当前容器不支持取出物品');
  };

  const collectTask = async (task) => {
    task.status = 'collecting';
    task.lastError = null;
    normalizeTask(task);
    if (task.remainingCount <= 0) return;
    await moveToWarehouseCenter();
    const positions = warehousePositions();
    if (!positions.length) throw new Error('没有找到任何仓库箱子');
    let remaining = task.remainingCount;
    for (const pos of positions) {
      if (remaining <= 0) break;
      const block = bot.blockAt(pos);
      if (!block) continue;
      try {
        await approachBlock(block);
        await openAndClose(block, async (container) => {
          const stack = containerItems(container).find((item) => item && item.name === task.itemName && item.count > 0);
          if (!stack) return;
          const amount = Math.min(remaining, stack.count);
          await withdrawFromContainer(container, stack, amount);
          remaining -= amount;
          task.lastStep = `从 ${block.name} 取出 ${amount}`;
          await sleep(Math.max(100, Number(cfg.collectPauseMs || 0)));
        });
      } catch (err) {
        task.lastError = err.message;
      }
      normalizeTask(task);
    }
    normalizeTask(task);
    if (task.remainingCount > 0) throw new Error(`仓库还差 ${task.remainingCount} 个`);
  };

  const tossSpecific = async (item, count) => {
    const amount = Math.max(1, Math.floor(Number(count || 0)));
    if (amount <= 0) return;
    if (typeof bot.toss === 'function') {
      try {
        if (bot.toss.length >= 4) {
          return await new Promise((resolve, reject) => {
            bot.toss(item.type, item.metadata, amount, (err) => (err ? reject(err) : resolve()));
          });
        }
        return await bot.toss(item.type, item.metadata, amount);
      } catch (err) {
        if (amount === item.count && typeof bot.tossStack === 'function') return bot.tossStack(item);
        throw err;
      }
    }
    if (amount === item.count && typeof bot.tossStack === 'function') return bot.tossStack(item);
    throw new Error('当前机器人不支持丢出指定数量物品');
  };

  const deliverTask = async (task) => {
    task.status = 'delivering';
    task.lastError = null;
    normalizeTask(task);
    const targetName = String(task.targetPlayer || '').trim();
    if (!targetName) throw new Error('未指定收货玩家');
    let player = bot.players && bot.players[targetName];
    if (!player || !player.entity) {
      const tpl = String(cfg.deliveryTeleportCommand || '').trim();
      if (tpl) {
        bot.chat(tpl.replace('{player}', targetName));
        await sleep(Math.max(500, Number(cfg.deliveryTeleportWaitMs || 3000)));
        player = bot.players && bot.players[targetName];
      }
    }
    if (!player || !player.entity) throw new Error(`玩家 ${targetName} 不在线或不在视野内`);

    const started = Date.now();
    while (Date.now() - started < cfg.moveTimeoutMs) {
      if (!player.entity || !player.entity.position) throw new Error(`玩家 ${targetName} 不可见`);
      const pos = player.entity.position;
      if (bot.entity && bot.entity.position && bot.entity.position.distanceTo(pos) <= Number(cfg.handoffDistance || 2.5) + 0.8) {
        stopPathfinder();
        break;
      }
      await moveNear(pos, Math.max(1, Number(cfg.handoffDistance || 2.5)), 3000, '靠近收货玩家').catch(() => {});
      await sleep(250);
      player = bot.players && bot.players[targetName] ? bot.players[targetName] : player;
    }

    if (!player.entity || !player.entity.position) throw new Error(`玩家 ${targetName} 不可见`);
    const want = Math.min(task.requestedCount || 0, countInInventory(task.itemName));
    if (want <= 0) throw new Error(`背包里没有 ${task.displayName || task.itemName}`);
    await bot.lookAt(player.entity.position.offset(0, 1.5, 0), true).catch(() => {});
    const invItems = bot.inventory.items().filter((item) => item && item.name === task.itemName);
    let remaining = want;
    for (const item of invItems) {
      if (remaining <= 0) break;
      const amount = Math.min(remaining, item.count);
      await tossSpecific(item, amount);
      remaining -= amount;
    }
    if (remaining > 0) throw new Error(`交付时少了 ${remaining} 个 ${task.displayName || task.itemName}`);
    task.deliveredAt = Date.now();
  };

  const notifyTaskFailure = (task, message) => {
    if (!task || !task.targetPlayer || task.notifiedFailure === message) return;
    task.notifiedFailure = message;
    whisperSafe(task.targetPlayer, `> 备货失败：${message}`);
  };

  const notifyTaskAccepted = (task) => {
    if (!task || task.notifiedAccepted || !task.targetPlayer) return;
    task.notifiedAccepted = true;
    whisperSafe(task.targetPlayer, `> 已收到需求：${task.itemName} × ${task.requestedCount}，开始在仓库里查找。`);
  };

  const summary = () => {
    const tasks = st.tasks;
    return {
      pending: tasks.filter((t) => t.status === 'pending').length,
      collecting: tasks.filter((t) => t.status === 'collecting').length,
      ready: tasks.filter((t) => t.status === 'ready').length,
      delivering: tasks.filter((t) => t.status === 'delivering').length,
      delivered: tasks.filter((t) => t.status === 'delivered').length,
      cancelled: tasks.filter((t) => t.status === 'cancelled').length,
      failed: tasks.filter((t) => t.status === 'failed').length,
    };
  };

  const taskPayload = (task) => normalizeTask({ ...task });
  const statusPayload = () => ({
    enabled: !!cfg.enabled,
    busy: !!st.busy,
    lastStatus: st.lastStatus,
    lastError: st.lastError,
    activeTaskId: st.activeTaskId,
    stock: st.stock,
    summary: summary(),
    tasks: st.tasks.map(taskPayload),
    settings: {
      warehouseMode: cfg.warehouseMode,
      warehouseCenter: cfg.warehouseCenter,
      warehouseSize: cfg.warehouseSize,
      warehouseBlocks: cfg.warehouseBlocks,
      warehouseContainers: cfg.warehouseContainers,
      containerSearchRadius: cfg.containerSearchRadius,
      handoffDistance: cfg.handoffDistance,
      blockApproachDistance: cfg.blockApproachDistance,
      reconcileIntervalMs: cfg.reconcileIntervalMs,
      moveTimeoutMs: cfg.moveTimeoutMs,
      collectPauseMs: cfg.collectPauseMs,
    },
  });

  const persistConfig = () => {
    fs.writeFileSync(configFile, JSON.stringify({
      enabled: cfg.enabled,
      reconcileIntervalMs: cfg.reconcileIntervalMs,
      collectPauseMs: cfg.collectPauseMs,
      moveTimeoutMs: cfg.moveTimeoutMs,
      handoffDistance: cfg.handoffDistance,
      blockApproachDistance: cfg.blockApproachDistance,
      maxStorageBlocksScan: cfg.maxStorageBlocksScan,
      warehouseMode: cfg.warehouseMode,
      warehouseBlocks: cfg.warehouseBlocks,
      warehouseCenter: cfg.warehouseCenter,
      warehouseSize: cfg.warehouseSize,
      containerSearchRadius: cfg.containerSearchRadius,
      warehouseContainers: cfg.warehouseContainers,
      deliveryTeleportCommand: cfg.deliveryTeleportCommand,
      deliveryTeleportWaitMs: cfg.deliveryTeleportWaitMs,
      requestCommandPermissionLevel: cfg.requestCommandPermissionLevel,
      aliases: cfg.aliases,
    }, null, 2));
  };

  const reconcile = async () => {
    if (!cfg.enabled || st.busy) return;
    const task = activeTasks()[0];
    if (!task) {
      st.lastStatus = 'idle';
      st.activeTaskId = null;
      return;
    }
    st.busy = true;
    st.activeTaskId = task.id;
    try {
      notifyTaskAccepted(task);
      normalizeTask(task);
      if (task.status === 'pending') task.status = 'collecting';
      if (task.remainingCount > 0) {
        await collectTask(task);
        normalizeTask(task);
      }
      if (task.remainingCount <= 0) {
        if (task.autoDeliver) {
          task.status = 'delivering';
          await deliverTask(task);
          task.status = 'delivered';
          st.lastStatus = `已交付 ${task.displayName || task.itemName} 给 ${task.targetPlayer}`;
          whisperSafe(task.targetPlayer, `> 已备好并交付：${task.itemName} × ${task.requestedCount}`);
        } else {
          task.status = 'ready';
          st.lastStatus = `已备齐 ${task.displayName || task.itemName}`;
        }
      } else {
        task.status = 'collecting';
      }
    } catch (err) {
      task.lastError = err.message;
      st.lastError = err.message;
      if (/仓库还差/.test(err.message)) {
        task.status = 'failed';
        notifyTaskFailure(task, `仓库里没有足够的 ${task.itemName}，还差 ${task.remainingCount} 个。`);
      } else if (task.status === 'delivering') {
        task.status = 'ready';
        notifyTaskFailure(task, `货已经取到，但暂时没法交给你：${err.message}`);
      } else {
        task.status = 'collecting';
      }
      st.lastStatus = `任务 ${task.id} 处理中断`;
    } finally {
      st.busy = false;
    }
  };

  const ep = (method, rel, handler) => {
    webManager.registerEndpoint(method, `/api/plugins/${pluginName}/${rel}`, async (req, res, url, body) => {
      try {
        await handler(req, res, url, body);
      } catch (err) {
        fail(res, 400, err.message);
      }
    }, pluginName);
  };

  ep('GET', 'panel', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(panelFile, 'utf8'));
  });

  ep('GET', 'status', (req, res) => ok(res, { status: statusPayload() }));

  ep('GET', 'items', (req, res) => {
    const items = Object.values(itemRegistry())
      .filter((item) => item && item.name)
      .map((item) => ({ name: item.name, displayName: item.displayName || item.name }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-CN'));
    ok(res, { items });
  });

  ep('GET', 'stock', async (req, res) => {
    const stock = await scanWarehouseStock();
    ok(res, { stock });
  });

  ep('POST', 'tasks', async (req, res, url, body) => {
    let obj;
    try { obj = JSON.parse(body || 'null') || {}; } catch (err) { throw new Error('无效 JSON'); }
    const resolved = resolveItem(obj.item || obj.itemName || obj.name);
    const requestedCount = Math.max(1, Math.floor(Number(obj.count || obj.requestedCount || 0)));
    const targetPlayer = String(obj.player || obj.targetPlayer || '').trim();
    if (!resolved) throw new Error('无法识别物品');
    if (!targetPlayer) throw new Error('请填写收货玩家');
    if (!Number.isFinite(requestedCount) || requestedCount <= 0) throw new Error('数量必须大于 0');
    const task = createTask({
      itemName: resolved.name,
      displayName: resolved.displayName,
      requestedCount,
      targetPlayer,
      source: 'web',
      autoDeliver: obj.autoDeliver !== false,
    });
    ok(res, { task: taskPayload(task), status: statusPayload() });
  });

  ep('POST', 'task-action', (req, res, url, body) => {
    let obj;
    try { obj = JSON.parse(body || 'null') || {}; } catch (err) { throw new Error('无效 JSON'); }
    const task = taskById(obj.id);
    if (!task) throw new Error('任务不存在');
    const action = String(obj.action || '').trim().toLowerCase();
    if (!action) throw new Error('缺少 action');
    if (action === 'cancel') {
      if (!isTerminal(task)) {
        task.status = 'cancelled';
        task.lastStep = '已取消';
      }
    } else if (action === 'deliver') {
      if (task.status === 'cancelled') throw new Error('任务已取消');
      task.autoDeliver = true;
      if (task.status === 'pending') task.status = 'ready';
      if (task.status === 'ready' || task.status === 'collecting') task.status = 'delivering';
    } else if (action === 'retry') {
      if (task.status === 'cancelled' || task.status === 'delivered') throw new Error('这个任务已经结束了');
      task.status = 'pending';
      task.lastError = null;
      task.lastStep = '重新排队';
    } else {
      throw new Error('不支持的 action');
    }
    ok(res, { task: taskPayload(task), status: statusPayload() });
  });

  ep('POST', 'scan', async (req, res) => {
    const stock = await scanWarehouseStock();
    ok(res, { stock });
  });

  ep('PUT', 'settings', (req, res, url, body) => {
    let obj;
    try { obj = JSON.parse(body || 'null') || {}; } catch (err) { throw new Error('无效 JSON'); }
    if (typeof obj.enabled !== 'undefined') cfg.enabled = !!obj.enabled;
    if (typeof obj.reconcileIntervalMs !== 'undefined') cfg.reconcileIntervalMs = Number(obj.reconcileIntervalMs);
    if (typeof obj.collectPauseMs !== 'undefined') cfg.collectPauseMs = Number(obj.collectPauseMs);
    if (typeof obj.moveTimeoutMs !== 'undefined') cfg.moveTimeoutMs = Number(obj.moveTimeoutMs);
    if (typeof obj.handoffDistance !== 'undefined') cfg.handoffDistance = Number(obj.handoffDistance);
    if (typeof obj.blockApproachDistance !== 'undefined') cfg.blockApproachDistance = Number(obj.blockApproachDistance);
    if (typeof obj.maxStorageBlocksScan !== 'undefined') cfg.maxStorageBlocksScan = Number(obj.maxStorageBlocksScan);
    if (typeof obj.deliveryTeleportCommand !== 'undefined') cfg.deliveryTeleportCommand = String(obj.deliveryTeleportCommand || '');
    if (typeof obj.deliveryTeleportWaitMs !== 'undefined') cfg.deliveryTeleportWaitMs = Number(obj.deliveryTeleportWaitMs);
    if (typeof obj.requestCommandPermissionLevel !== 'undefined') cfg.requestCommandPermissionLevel = Number(obj.requestCommandPermissionLevel);
    if (typeof obj.warehouseMode !== 'undefined') {
      const mode = String(obj.warehouseMode || '').trim().toLowerCase();
      if (!['area', 'list'].includes(mode)) throw new Error('warehouseMode 只能是 area 或 list');
      cfg.warehouseMode = mode;
    }
    if (obj.warehouseCenter) cfg.warehouseCenter = normalizeAxisGroup(obj.warehouseCenter, 'warehouseCenter');
    if (obj.warehouseSize) cfg.warehouseSize = normalizeAxisGroup(obj.warehouseSize, 'warehouseSize');
    if (obj.containerSearchRadius) cfg.containerSearchRadius = normalizeAxisGroup(obj.containerSearchRadius, 'containerSearchRadius');
    if (Array.isArray(obj.warehouseBlocks)) cfg.warehouseBlocks = obj.warehouseBlocks;
    if (Array.isArray(obj.warehouseContainers)) cfg.warehouseContainers = obj.warehouseContainers.map((p, i) => normalizeAxisGroup(p, `warehouseContainers[${i}]`));
    if (obj.aliases && typeof obj.aliases === 'object' && !Array.isArray(obj.aliases)) cfg.aliases = obj.aliases;
    persistConfig();
    ok(res, { status: statusPayload() });
  });

  if (!st.timer) {
    st.timer = setInterval(() => reconcile().catch((err) => {
      st.lastError = err.message;
    }), Math.max(1000, Number(cfg.reconcileIntervalMs || 1500)));
    if (typeof st.timer.unref === 'function') st.timer.unref();
  }

  if (commands && typeof commands.register === 'function') {
    commands.register({
      name: 'want',
      permissionLevel: Number(cfg.requestCommandPermissionLevel || 0),
      description: '提交仓库备货请求: !want <物品id> <数量>',
      execute: (username, args) => {
        const itemInput = String(args[0] || '').trim();
        const countInput = Number(args[1]);
        if (!itemInput || !Number.isFinite(countInput) || countInput <= 0) {
          return whisperSafe(username, '> 用法：!want <物品id> <数量>');
        }
        const resolved = resolveItem(itemInput);
        if (!resolved) {
          return whisperSafe(username, `> 无法识别物品：${itemInput}`);
        }
        const task = createTask({
          itemName: resolved.name,
          displayName: resolved.displayName,
          requestedCount: Math.floor(countInput),
          targetPlayer: username,
          source: 'command',
          autoDeliver: true,
        });
        whisperSafe(username, `> 已接单：${task.itemName} × ${task.requestedCount}。只会在仓库范围内查找，不会去外面找方块。`);
      },
    });
  }

  webManager.registerTile({
    name: pluginName,
    title: '备货任务',
    description: '从网页下达取货与交付任务，实时显示进度',
    panel: `/api/plugins/${pluginName}/panel`,
  });

  console.log('[warehouse-tasks] 插件已加载');
};
