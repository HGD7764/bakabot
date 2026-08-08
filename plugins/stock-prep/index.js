const fs = require('fs');
const path = require('path');
const { GoalNear } = require('mineflayer-pathfinder').goals;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = (context) => {
  const { bot, commands, pluginConfig, pluginName, webManager, state } = context;
  const configFile = path.join(__dirname, 'config.json');

  const cfg = {
    autoDeliverByDefault: true,
    reconcileIntervalMs: 1500,
    handoffDistance: 2.5,
    deliveryMoveTimeoutMs: 25000,
    blockApproachDistance: 2,
    collectPauseMs: 400,
    maxTasks: 50,
    maxStorageBlocksScan: 128,
    warehouseBlocks: ['chest', 'trapped_chest', 'barrel'],
    warehouseCenter: { x: 0, y: 64, z: 0 },
    warehouseSize: { x: 16, y: 8, z: 16 },
    tpaCommand: '/tpa {player}',
    aliases: {
      dirt: 'dirt',
      mud: 'mud',
      cobble: 'cobblestone',
      stone: 'stone',
      emerald: 'emerald',
      netherrack: 'netherrack',
      oaklog: 'oak_log',
      plank: 'oak_planks',
      planks: 'oak_planks',
      泥土: 'dirt',
      泥巴: 'mud',
      圆石: 'cobblestone',
      石头: 'stone',
      绿宝石: 'emerald',
      下界岩: 'netherrack',
      原木: 'oak_log',
      木板: 'oak_planks',
      火把: 'torch',
      沙子: 'sand',
      砂砾: 'gravel',
      箱子: 'chest',
      面包: 'bread',
      鱼竿: 'fishing_rod',
    },
    ...(pluginConfig || {}),
  };

  const st = state.stockPrep || (state.stockPrep = {
    nextId: 1,
    tasks: [],
    activeDeliveryId: null,
    deliveryPromise: null,
    activeFulfillmentId: null,
    fulfillmentPromise: null,
    activeRequestId: null,
    timer: null,
    stock: {
      items: [],
      scannedAt: null,
      lastError: null,
      scanning: false,
      timer: null,
    },
  });

  const htmlFile = path.join(__dirname, 'panel.html');

  const persistConfig = () => {
    fs.writeFileSync(configFile, JSON.stringify({
      autoDeliverByDefault: cfg.autoDeliverByDefault,
      reconcileIntervalMs: cfg.reconcileIntervalMs,
      handoffDistance: cfg.handoffDistance,
      deliveryMoveTimeoutMs: cfg.deliveryMoveTimeoutMs,
      blockApproachDistance: cfg.blockApproachDistance,
      collectPauseMs: cfg.collectPauseMs,
      maxTasks: cfg.maxTasks,
      maxStorageBlocksScan: cfg.maxStorageBlocksScan,
      warehouseBlocks: cfg.warehouseBlocks,
      warehouseCenter: cfg.warehouseCenter,
      warehouseSize: cfg.warehouseSize,
      tpaCommand: cfg.tpaCommand,
      aliases: cfg.aliases,
    }, null, 2));
  };

  const ok = (res, data = {}) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, ...data }));
  };

  const fail = (res, status, error) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error }));
  };

  const normalizeKey = (value) => String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, '')
    .replace(/[\s_-]+/g, '');

  const inventoryItems = () => (bot.inventory && typeof bot.inventory.items === 'function')
    ? bot.inventory.items()
    : [];

  const countInInventory = (itemName) => inventoryItems()
    .filter((item) => item && item.name === itemName)
    .reduce((sum, item) => sum + item.count, 0);

  const isChineseText = (value) => /[\u3400-\u9fff]/.test(String(value || ''));

  const preferredLabelForItem = (itemName, displayName = null) => {
    const pair = Object.entries(cfg.aliases || {})
      .find(([key, value]) => value === itemName && isChineseText(key));
    if (pair) return pair[0];
    return displayName || itemName;
  };

  const stockLookupMap = () => {
    const lookup = new Map();
    for (const entry of st.stock.items || []) {
      for (const raw of [entry.itemName, entry.displayName, entry.label]) {
        const key = normalizeKey(raw);
        if (key) lookup.set(key, entry);
      }
    }
    return lookup;
  };

  const resolveItem = (input) => {
    const raw = String(input || '').trim();
    if (!raw) return null;

    const aliasValue = cfg.aliases[raw] || cfg.aliases[normalizeKey(raw)];
    const candidate = aliasValue || raw;
    const cleanName = String(candidate).trim().toLowerCase().replace(/^minecraft:/, '');
    const registry = bot.registry && bot.registry.itemsByName ? bot.registry.itemsByName : null;

    if (registry && registry[cleanName]) {
      const it = registry[cleanName];
      return {
        name: it.name,
        displayName: preferredLabelForItem(it.name, it.displayName || it.name),
        input: raw,
      };
    }

    const stockMatch = stockLookupMap().get(normalizeKey(raw));
    if (stockMatch) {
      return {
        name: stockMatch.itemName,
        displayName: stockMatch.label || stockMatch.displayName || stockMatch.itemName,
        input: raw,
      };
    }

    if (registry) {
      const normalized = normalizeKey(raw);
      for (const it of Object.values(registry)) {
        if (normalizeKey(it.name) === normalized || normalizeKey(it.displayName || '') === normalized) {
          return {
            name: it.name,
            displayName: preferredLabelForItem(it.name, it.displayName || it.name),
            input: raw,
          };
        }
      }
    }

    if (/^[a-z0-9_]+$/.test(cleanName)) {
      return {
        name: cleanName,
        displayName: cleanName,
        input: raw,
      };
    }

    return null;
  };

  const taskLabel = (task) => task.displayName && task.displayName !== task.itemName
    ? `${task.displayName} (${task.itemName})`
    : task.itemName;

  const taskById = (id) => st.tasks.find((task) => task.id === id);

  const itemPresets = () => {
    const registry = bot.registry && bot.registry.itemsByName ? bot.registry.itemsByName : {};
    return Object.values(registry)
      .filter((item) => item && item.name)
      .map((item) => ({
        name: item.name,
        displayName: preferredLabelForItem(item.name, item.displayName || item.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  const insideWarehouse = (position) => {
    if (!position || !cfg.warehouseCenter || !cfg.warehouseSize) return false;
    const dx = Math.abs(position.x - Number(cfg.warehouseCenter.x || 0));
    const dy = Math.abs(position.y - Number(cfg.warehouseCenter.y || 0));
    const dz = Math.abs(position.z - Number(cfg.warehouseCenter.z || 0));
    return dx <= Number(cfg.warehouseSize.x || 0) &&
      dy <= Number(cfg.warehouseSize.y || 0) &&
      dz <= Number(cfg.warehouseSize.z || 0);
  };

  const summarizeTask = (task) => ({
    id: task.id,
    itemName: task.itemName,
    displayName: task.displayName,
    requestedInput: task.requestedInput,
    targetPlayer: task.targetPlayer,
    requestedCount: task.requestedCount,
    collectedCount: task.collectedCount,
    remainingCount: Math.max(0, task.requestedCount - task.collectedCount),
    progress: task.requestedCount > 0 ? Math.min(1, task.collectedCount / task.requestedCount) : 0,
    status: task.status,
    stage: task.stage || null,
    stageLabel: task.stageLabel || null,
    autoDeliver: !!task.autoDeliver,
    lastError: task.lastError || null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    readyAt: task.readyAt || null,
    deliveredAt: task.deliveredAt || null,
  });

  const setTaskStage = (task, stage, label) => {
    task.stage = stage || null;
    task.stageLabel = label || null;
    task.updatedAt = Date.now();
  };

  const reconcileTask = (task) => {
    if (!task || task.status === 'cancelled' || task.status === 'delivered' || task.status === 'failed') return;

    task.collectedCount = countInInventory(task.itemName);
    task.updatedAt = Date.now();
    const enough = task.collectedCount >= task.requestedCount;

    if (st.activeDeliveryId === task.id) {
      task.status = 'delivering';
      return;
    }

    if (st.activeFulfillmentId === task.id || st.activeRequestId === task.id) {
      task.status = 'collecting';
      return;
    }

    if (enough) {
      if (task.status !== 'ready') task.readyAt = Date.now();
      task.status = 'ready';
      setTaskStage(task, 'ready', '已备齐，等待交付');
      return;
    }

    task.readyAt = null;
    task.status = 'pending';
    if (!task.stage) setTaskStage(task, 'pending', '等待补货');
  };

  const reconcileAll = () => {
    for (const task of st.tasks) reconcileTask(task);

    if (!st.fulfillmentPromise) {
      const nextNeed = st.tasks.find((task) => task.status === 'pending' || task.status === 'collecting');
      if (nextNeed) {
        st.fulfillmentPromise = fulfillTask(nextNeed.id).catch((err) => {
          const task = taskById(nextNeed.id);
          if (task) {
            task.lastError = err.message;
            task.updatedAt = Date.now();
          }
        }).finally(() => {
          st.fulfillmentPromise = null;
          st.activeFulfillmentId = null;
        });
      }
    }

    if (!st.deliveryPromise) {
      const next = st.tasks.find((task) => task.status === 'ready' && task.autoDeliver);
      if (next) {
        st.deliveryPromise = deliverTask(next.id, 'auto').finally(() => {
          st.deliveryPromise = null;
        });
      }
    }
  };

  const waitUntilNear = async (entity, distance, timeoutMs) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (!bot.entity || !entity || !entity.position) throw new Error('机器人或目标实体不可用');
      if (bot.entity.position.distanceTo(entity.position) <= distance) return;
      await sleep(200);
    }
    throw new Error(`接近目标超时（>${Math.round(timeoutMs / 1000)} 秒）`);
  };

  const waitUntilNearPoint = async (point, distance, timeoutMs) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (!bot.entity || !point) throw new Error('机器人位置不可用');
      if (bot.entity.position.distanceTo(point) <= distance) return;
      await sleep(200);
    }
    throw new Error(`接近目标超时（>${Math.round(timeoutMs / 1000)} 秒）`);
  };

  const moveToWarehouseCenter = async (task = null) => {
    if (!cfg.warehouseCenter) throw new Error('未配置仓库中心坐标');
    if (!bot.entity) throw new Error('机器人尚未进入世界');
    if (!bot.pathfinder) throw new Error('未检测到寻路模块，请先启用 navigator 插件');

    const center = cfg.warehouseCenter;
    const targetPoint = { x: Number(center.x || 0), y: Number(center.y || 0), z: Number(center.z || 0) };
    const radius = Math.max(1, Math.min(
      Number(cfg.warehouseSize.x || 0),
      Number(cfg.warehouseSize.z || 0),
      3
    ));

    if (insideWarehouse(bot.entity.position)) return;

    if (task) setTaskStage(task, 'warehouse', '正在前往仓库中心');
    bot.pathfinder.setGoal(new GoalNear(targetPoint.x, targetPoint.y, targetPoint.z, radius));
    await waitUntilNearPoint(targetPoint, Math.max(radius + 1, 3), cfg.deliveryMoveTimeoutMs);
    await sleep(500);
  };

  const approachPlayer = async (playerName) => {
    const player = bot.players && bot.players[playerName];
    if (!player || !player.entity) throw new Error(`无法定位玩家 ${playerName}`);

    if (bot.entity && bot.entity.position.distanceTo(player.entity.position) <= cfg.handoffDistance) {
      return player.entity;
    }

    if (!bot.pathfinder) throw new Error('未检测到寻路模块，请先启用 navigator 插件');

    bot.pathfinder.setGoal(new GoalNear(
      player.entity.position.x,
      player.entity.position.y,
      player.entity.position.z,
      Math.max(1, Math.ceil(cfg.handoffDistance))
    ));

    await waitUntilNear(player.entity, cfg.handoffDistance, cfg.deliveryMoveTimeoutMs);
    return player.entity;
  };

  const tossExact = async (itemName, count) => {
    let remaining = count;
    while (remaining > 0) {
      const stack = inventoryItems().find((item) => item && item.name === itemName);
      if (!stack) throw new Error(`库存不足，还差 ${remaining}`);
      const amount = Math.min(remaining, stack.count);
      await bot.toss(stack.type, stack.metadata, amount);
      remaining -= amount;
      await sleep(120);
    }
  };

  const blockIds = (names) => {
    const reg = bot.registry && bot.registry.blocksByName ? bot.registry.blocksByName : {};
    return names.map((name) => reg[name] && reg[name].id).filter((id) => Number.isInteger(id));
  };

  const warehouseContainerPositions = () => {
    if (typeof bot.findBlocks !== 'function') return [];
    const ids = blockIds(cfg.warehouseBlocks);
    if (!ids.length) return [];
    const maxDistance = Math.max(
      Number(cfg.warehouseSize.x || 0),
      Number(cfg.warehouseSize.y || 0),
      Number(cfg.warehouseSize.z || 0)
    ) + 8;
    const center = bot.entity && bot.entity.position
      ? bot.entity.position
      : cfg.warehouseCenter;
    try {
      return (bot.findBlocks({
        point: center,
        matching: ids,
        maxDistance,
        count: cfg.maxStorageBlocksScan,
      }) || []).filter(insideWarehouse);
    } catch (err) {
      return [];
    }
  };

  const scanWarehouseInventory = async (reason = 'manual') => {
    if (st.stock.scanning) {
      return {
        items: st.stock.items,
        scannedAt: st.stock.scannedAt,
        lastError: st.stock.lastError,
        skipped: true,
      };
    }

    st.stock.scanning = true;
    st.stock.lastError = null;
    try {
      await moveToWarehouseCenter();
      const positions = warehouseContainerPositions();
      const merged = new Map();

      for (const pos of positions) {
        const block = bot.blockAt(pos);
        if (!block) continue;
        try {
          await approachBlock(block, 2);
          const container = await openContainerBlock(block);
          try {
            for (const item of containerItems(container)) {
              if (!item || !item.name || !item.count) continue;
              const existing = merged.get(item.name) || {
                itemName: item.name,
                displayName: item.displayName || item.name,
                label: preferredLabelForItem(item.name, item.displayName || item.name),
                count: 0,
              };
              existing.count += item.count;
              merged.set(item.name, existing);
            }
          } finally {
            if (typeof container.close === 'function') {
              try { container.close(); } catch (err) {}
            }
          }
        } catch (err) {
          st.stock.lastError = `扫描 ${block.name} 失败: ${err.message}`;
        }
      }

      st.stock.items = Array.from(merged.values()).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
      st.stock.scannedAt = Date.now();
      console.log(`[stock-prep] 已完成仓库库存扫描 (${reason})，共 ${st.stock.items.length} 种物品`);
      return {
        items: st.stock.items,
        scannedAt: st.stock.scannedAt,
        lastError: st.stock.lastError,
      };
    } finally {
      st.stock.scanning = false;
    }
  };

  const approachBlock = async (block, distance = cfg.blockApproachDistance) => {
    if (!block || !block.position) throw new Error('目标方块不可用');
    if (!bot.pathfinder) throw new Error('未检测到寻路模块，请先启用 navigator 插件');
    bot.pathfinder.setGoal(new GoalNear(
      block.position.x,
      block.position.y,
      block.position.z,
      Math.max(1, Math.ceil(distance))
    ));
    await waitUntilNearPoint(block.position, distance + 0.8, cfg.deliveryMoveTimeoutMs);
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

  const withdrawFromStorage = async (task, needed) => {
    const positions = warehouseContainerPositions();
    if (!positions.length) return 0;

    let taken = 0;
    for (const pos of positions) {
      if (taken >= needed) break;
      const block = bot.blockAt(pos);
      if (!block) continue;

      try {
        setTaskStage(task, 'storage', `前往 ${block.name} 取货`);
        await approachBlock(block, 2);
        const container = await openContainerBlock(block);
        try {
          const stack = containerItems(container).find((item) => item && item.name === task.itemName);
          if (!stack) continue;
          const amount = Math.min(needed - taken, stack.count);
          setTaskStage(task, 'storage', `从 ${block.name} 取出 ${task.itemName} × ${amount}`);
          await container.withdraw(stack.type, stack.metadata, amount);
          taken += amount;
          await sleep(cfg.collectPauseMs);
        } finally {
          if (typeof container.close === 'function') {
            try { container.close(); } catch (err) {}
          }
        }
      } catch (err) {
        task.lastError = `仓库取货失败: ${err.message}`;
      }
    }
    return taken;
  };

  async function fulfillTask(id) {
    const task = taskById(id);
    if (!task) throw new Error('任务不存在');
    if (task.status === 'cancelled' || task.status === 'delivered') return summarizeTask(task);

    st.activeFulfillmentId = task.id;
    task.lastError = null;
    task.status = 'collecting';
    setTaskStage(task, 'collect', '开始补货');
    reconcileTask(task);
    await moveToWarehouseCenter(task);

    const need = () => Math.max(0, task.requestedCount - countInInventory(task.itemName));

    while (need() > 0) {
      const missing = need();
      const pulled = await withdrawFromStorage(task, missing);
      if (pulled > 0) {
        task.collectedCount = countInInventory(task.itemName);
        setTaskStage(task, 'storage', `已从仓库补到 ${task.collectedCount}/${task.requestedCount}`);
      }

      if (need() <= 0) break;
      throw new Error(`仓库内没有足够的 ${task.itemName}，当前仍缺少 ${need()} 个`);

      await sleep(cfg.collectPauseMs);
    }

    reconcileTask(task);
    return summarizeTask(task);
  }

  async function deliverTask(id, source = 'manual') {
    const task = taskById(id);
    if (!task) throw new Error('任务不存在');
    if (task.status === 'cancelled') throw new Error('任务已取消');
    if (task.status === 'delivered') throw new Error('任务已完成');
    if (st.activeDeliveryId && st.activeDeliveryId !== task.id) throw new Error('已有其他任务正在交付');

    reconcileTask(task);
    if (task.collectedCount < task.requestedCount) throw new Error(`库存不足，还差 ${task.requestedCount - task.collectedCount}`);

    st.activeDeliveryId = task.id;
    task.status = 'delivering';
    task.lastError = null;
    task.updatedAt = Date.now();

    try {
      const targetEntity = await approachPlayer(task.targetPlayer);
      if (typeof bot.lookAt === 'function') {
        await bot.lookAt(targetEntity.position.offset(0, 1.2, 0), true);
      }
      await tossExact(task.itemName, task.requestedCount);
      task.collectedCount = 0;
      task.status = 'delivered';
      setTaskStage(task, 'delivered', '已交付完成');
      task.deliveredAt = Date.now();
      task.updatedAt = task.deliveredAt;
      console.log(`[stock-prep] 任务 #${task.id} 已交付给 ${task.targetPlayer}: ${taskLabel(task)} x${task.requestedCount} (${source})`);
      if (typeof bot.whisper === 'function') {
        bot.whisper(task.targetPlayer, `> 你的备货已送达：${taskLabel(task)} × ${task.requestedCount}`);
      }
      return summarizeTask(task);
    } catch (err) {
      task.lastError = err.message;
      task.updatedAt = Date.now();
      reconcileTask(task);
      throw err;
    } finally {
      st.activeDeliveryId = null;
    }
  }

  const createTask = (payload) => {
    if (st.tasks.filter((task) => task.status !== 'delivered' && task.status !== 'cancelled').length >= cfg.maxTasks) {
      throw new Error(`任务过多，最多保留 ${cfg.maxTasks} 个未结束任务`);
    }

    const item = resolveItem(payload.item);
    if (!item) throw new Error('无法识别物品，请填写原版物品 ID 或在配置里增加别名');

    const requestedCount = Math.floor(Number(payload.count));
    if (!Number.isInteger(requestedCount) || requestedCount <= 0) {
      throw new Error('数量必须是正整数');
    }

    const targetPlayer = String(payload.targetPlayer || '').trim();
    if (!targetPlayer) throw new Error('目标玩家不能为空');

    const task = {
      id: st.nextId++,
      itemName: item.name,
      displayName: item.displayName,
      requestedInput: item.input,
      targetPlayer,
      requestedCount,
      collectedCount: 0,
      status: 'pending',
      stage: 'pending',
      stageLabel: '等待补货',
      autoDeliver: payload.autoDeliver == null ? !!cfg.autoDeliverByDefault : !!payload.autoDeliver,
      lastError: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      readyAt: null,
      deliveredAt: null,
    };

    reconcileTask(task);
    st.tasks.unshift(task);
    console.log(`[stock-prep] 新任务 #${task.id}: ${taskLabel(task)} x${task.requestedCount} -> ${task.targetPlayer}`);
    return summarizeTask(task);
  };

  const removeTask = (id) => {
    const idx = st.tasks.findIndex((task) => task.id === id);
    if (idx === -1) throw new Error('任务不存在');
    if (st.activeDeliveryId === id) throw new Error('任务正在交付中，不能删除');
    const [task] = st.tasks.splice(idx, 1);
    return summarizeTask(task);
  };

  const cancelTask = (id) => {
    const task = taskById(id);
    if (!task) throw new Error('任务不存在');
    if (st.activeDeliveryId === id) throw new Error('任务正在交付中，不能取消');
    task.status = 'cancelled';
    setTaskStage(task, 'cancelled', '任务已取消');
    task.lastError = null;
    task.updatedAt = Date.now();
    return summarizeTask(task);
  };

  const statusPayload = () => {
    reconcileAll();
    return {
      activeDeliveryId: st.activeDeliveryId,
      inventoryReady: !!(bot.inventory && bot.inventory.slots),
      onlinePlayers: Object.values(bot.players || {})
        .filter((p) => p && p.username)
        .map((p) => ({
          username: p.username,
          visible: !!p.entity,
        }))
        .sort((a, b) => a.username.localeCompare(b.username)),
      tasks: st.tasks.map(summarizeTask),
      aliases: cfg.aliases,
      warehouseBlocks: cfg.warehouseBlocks,
      warehouseCenter: cfg.warehouseCenter,
      warehouseSize: cfg.warehouseSize,
      tpaCommand: cfg.tpaCommand,
      itemPresets: itemPresets(),
      stock: {
        items: st.stock.items,
        scannedAt: st.stock.scannedAt,
        lastError: st.stock.lastError,
        scanning: st.stock.scanning,
      },
    };
  };

  const settingsPayload = () => ({
    warehouseCenter: cfg.warehouseCenter,
    warehouseSize: cfg.warehouseSize,
    warehouseBlocks: cfg.warehouseBlocks,
    tpaCommand: cfg.tpaCommand,
    maxStorageBlocksScan: cfg.maxStorageBlocksScan,
  });

  const fillTemplate = (template, params) => {
    let result = String(template || '');
    for (const [key, value] of Object.entries(params || {})) {
      result = result.replaceAll(`{${key}}`, String(value));
    }
    return result;
  };

  const requestByCommand = async (username, itemInput, countInput) => {
    const item = resolveItem(itemInput);
    if (!item) throw new Error('无法识别物品，请使用原版物品 ID');
    const count = Math.floor(Number(countInput));
    if (!Number.isInteger(count) || count <= 0) throw new Error('数量必须是正整数');

    const task = {
      id: st.nextId++,
      itemName: item.name,
      displayName: item.displayName,
      requestedInput: item.input,
      targetPlayer: username,
      requestedCount: count,
      collectedCount: 0,
      status: 'collecting',
      stage: 'storage',
      stageLabel: '正在仓库查找',
      autoDeliver: false,
      lastError: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      readyAt: null,
      deliveredAt: null,
    };

    st.tasks.unshift(task);
    st.activeRequestId = task.id;
    try {
      await fulfillTask(task.id);
      task.status = 'ready';
      setTaskStage(task, 'tpa', '已找到物品，准备 TPA');
      const tpaCommand = fillTemplate(cfg.tpaCommand, {
        player: username,
        username,
        item: task.itemName,
        count: task.requestedCount,
      }).trim();
      if (!tpaCommand) throw new Error('tpaCommand 未配置');
      bot.chat(tpaCommand);
      bot.whisper(username, `> 已在仓库找到 ${task.itemName} × ${task.requestedCount}，已向你发起 TPA。`);
      return summarizeTask(task);
    } catch (err) {
      task.status = 'failed';
      task.lastError = err.message;
      setTaskStage(task, 'failed', `仓库未找到足够物品：${err.message}`);
      bot.whisper(username, `> 仓库里暂时没有足够的 ${item.name} × ${count}。${err.message}`);
      throw err;
    } finally {
      st.activeRequestId = null;
    }
  };

  const jsonBody = (body) => {
    try {
      return JSON.parse(body || 'null');
    } catch (err) {
      throw new Error('无效 JSON');
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
    if (!fs.existsSync(htmlFile)) return fail(res, 404, '面板文件不存在');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(htmlFile, 'utf8'));
  });

  ep('GET', 'status', (req, res) => ok(res, statusPayload()));

  ep('GET', 'settings', (req, res) => ok(res, { settings: settingsPayload() }));

  ep('POST', 'scan', async (req, res) => {
    const result = await scanWarehouseInventory('manual');
    ok(res, {
      stock: {
        items: result.items,
        scannedAt: result.scannedAt,
        lastError: result.lastError,
        scanning: st.stock.scanning,
      },
    });
  });

  ep('PUT', 'settings', (req, res, url, body) => {
    const payload = jsonBody(body) || {};
    const { warehouseCenter, warehouseSize, warehouseBlocks, tpaCommand, maxStorageBlocksScan } = payload;

    const parseAxisGroup = (value, label) => {
      if (!value || typeof value !== 'object') throw new Error(`${label} 必须是对象`);
      const x = Number(value.x);
      const y = Number(value.y);
      const z = Number(value.z);
      if (![x, y, z].every(Number.isFinite)) throw new Error(`${label} 的 x/y/z 必须是数字`);
      return { x, y, z };
    };

    if (warehouseCenter !== undefined) cfg.warehouseCenter = parseAxisGroup(warehouseCenter, 'warehouseCenter');
    if (warehouseSize !== undefined) {
      const nextSize = parseAxisGroup(warehouseSize, 'warehouseSize');
      if (nextSize.x < 0 || nextSize.y < 0 || nextSize.z < 0) throw new Error('warehouseSize 不能为负数');
      cfg.warehouseSize = nextSize;
    }
    if (warehouseBlocks !== undefined) {
      if (!Array.isArray(warehouseBlocks) || warehouseBlocks.some((v) => typeof v !== 'string' || !v.trim())) {
        throw new Error('warehouseBlocks 必须是字符串数组');
      }
      cfg.warehouseBlocks = warehouseBlocks.map((v) => v.trim());
    }
    if (tpaCommand !== undefined) {
      if (typeof tpaCommand !== 'string' || !tpaCommand.trim()) throw new Error('tpaCommand 不能为空');
      cfg.tpaCommand = tpaCommand.trim();
    }
    if (maxStorageBlocksScan !== undefined) {
      const n = Number(maxStorageBlocksScan);
      if (!Number.isInteger(n) || n <= 0) throw new Error('maxStorageBlocksScan 必须是正整数');
      cfg.maxStorageBlocksScan = n;
    }

    persistConfig();
    ok(res, { settings: settingsPayload() });
  });

  ep('POST', 'create', (req, res, url, body) => {
    const task = createTask(jsonBody(body) || {});
    ok(res, { task });
  });

  ep('POST', 'cancel', (req, res, url, body) => {
    const payload = jsonBody(body) || {};
    ok(res, { task: cancelTask(Number(payload.id)) });
  });

  ep('POST', 'delete', (req, res, url, body) => {
    const payload = jsonBody(body) || {};
    ok(res, { task: removeTask(Number(payload.id)) });
  });

  ep('POST', 'deliver', async (req, res, url, body) => {
    const payload = jsonBody(body) || {};
    const task = await deliverTask(Number(payload.id), 'web');
    ok(res, { task });
  });

  commands.register({
    name: 'stocktasks',
    permissionLevel: 1,
    description: '查看当前备货任务概览',
    execute: (username) => {
      reconcileAll();
      if (!st.tasks.length) return bot.whisper(username, '> 当前没有备货任务。');
      const lines = st.tasks.slice(0, 3).map((task) => `#${task.id} ${taskLabel(task)} ${task.collectedCount}/${task.requestedCount} -> ${task.targetPlayer} [${task.status}]`);
      bot.whisper(username, `> 备货任务：${lines.join(' | ')}${st.tasks.length > 3 ? ` | 另有 ${st.tasks.length - 3} 个` : ''}`);
    },
  });

  commands.register({
    name: 'deliverstock',
    permissionLevel: 1,
    description: '手动交付备货任务: !deliverstock <任务ID>',
    execute: (username, args) => {
      const id = Number(args[0]);
      if (!Number.isInteger(id) || id <= 0) return bot.whisper(username, '> 用法: !deliverstock <任务ID>');
      deliverTask(id, `command:${username}`)
        .then((task) => bot.whisper(username, `> 任务 #${task.id} 已交付给 ${task.targetPlayer}。`))
        .catch((err) => bot.whisper(username, `> 交付失败: ${err.message}`));
    },
  });

  commands.register({
    name: 'iwant',
    permissionLevel: 0,
    description: '仓库申请物品: !iwant <物品id> <数量>',
    execute: (username, args) => {
      if (args.length < 2) return bot.whisper(username, '> 用法: !iwant <物品id> <数量>');
      if (st.activeRequestId) return bot.whisper(username, '> 当前已有一个仓库申请正在处理中，请稍后再试。');
      requestByCommand(username, args[0], args[1]).catch(() => {});
    },
  });

  if (!st.timer) {
    st.timer = setInterval(reconcileAll, Math.max(500, cfg.reconcileIntervalMs));
    if (typeof st.timer.unref === 'function') st.timer.unref();
  }

  if (!st.stock.timer) {
    st.stock.timer = setInterval(() => {
      scanWarehouseInventory('timer').catch((err) => {
        st.stock.lastError = err.message;
      });
    }, 10 * 60 * 1000);
    if (typeof st.stock.timer.unref === 'function') st.stock.timer.unref();
  }

  webManager.registerTile({
    name: pluginName,
    title: '备货中心',
    description: '网页下达备货任务，实时查看进度，并将货物交给指定玩家',
    panel: `/api/plugins/${pluginName}/panel`,
    endpoints: {},
  });

  console.log('[stock-prep] 插件已加载');
};
