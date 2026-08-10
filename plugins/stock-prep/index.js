const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { GoalNear } = require('mineflayer-pathfinder').goals;
const { Vec3 } = require('vec3');
const zhCnItems = require('./zh_cn_items.json');

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
    containerOpenTimeoutMs: 8000,
    maxTasks: 50,
    maxStorageBlocksScan: 128,
    warehouseMode: 'area',
    warehouseBlocks: ['chest', 'trapped_chest', 'barrel'],
    warehouseCenter: { x: 0, y: 64, z: 0 },
    warehouseSize: { x: 16, y: 8, z: 16 },
    warehouseContainers: [],
    tpaCommand: '/tpa {player}',
    homeCommand: '/home',
    fallbackToTpaOnDeliveryTimeout: true,
    postCollectTpaDelayMs: 800,
    postTpaAutoDeliverDelayMs: 3000,
    postTpaAutoDeliverRetryMs: 25000,
    postTpaAutoDeliverMaxAttempts: 8,
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
    },
    projection: {
      fileName: null,
      blocks: [],
      scannedAt: null,
      lastError: null,
      targetPlayer: '',
      totalRequired: 0,
      totalAvailable: 0,
      totalMissing: 0,
    },
  });

  // 插件从网页重载时会复用共享 state；只清理上一轮残留的扫描标记。
  if (st.stock) st.stock.scanning = false;

  const htmlFile = path.join(__dirname, 'panel.html');

  const persistConfig = () => {
    fs.writeFileSync(configFile, JSON.stringify({
      autoDeliverByDefault: cfg.autoDeliverByDefault,
      reconcileIntervalMs: cfg.reconcileIntervalMs,
      handoffDistance: cfg.handoffDistance,
      deliveryMoveTimeoutMs: cfg.deliveryMoveTimeoutMs,
      blockApproachDistance: cfg.blockApproachDistance,
      collectPauseMs: cfg.collectPauseMs,
      containerOpenTimeoutMs: cfg.containerOpenTimeoutMs,
      maxTasks: cfg.maxTasks,
      maxStorageBlocksScan: cfg.maxStorageBlocksScan,
      warehouseMode: cfg.warehouseMode,
      warehouseBlocks: cfg.warehouseBlocks,
      warehouseCenter: cfg.warehouseCenter,
      warehouseSize: cfg.warehouseSize,
      warehouseContainers: cfg.warehouseContainers,
      tpaCommand: cfg.tpaCommand,
      homeCommand: cfg.homeCommand,
      fallbackToTpaOnDeliveryTimeout: cfg.fallbackToTpaOnDeliveryTimeout,
      postCollectTpaDelayMs: cfg.postCollectTpaDelayMs,
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
    if (zhCnItems[itemName]) return zhCnItems[itemName];
    const pair = Object.entries(cfg.aliases || {})
      .find(([key, value]) => value === itemName && isChineseText(key));
    if (pair) return pair[0];
    return displayName || itemName;
  };

  const registryItems = () => {
    const registry = bot.registry && bot.registry.itemsByName ? bot.registry.itemsByName : {};
    return Object.values(registry).filter((item) => item && item.name);
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

    const zhMatchName = Object.entries(zhCnItems).find(([, label]) => normalizeKey(label) === normalizeKey(raw));
    if (zhMatchName) {
      return {
        name: zhMatchName[0],
        displayName: zhMatchName[1],
        input: raw,
      };
    }

    const normalized = normalizeKey(raw);
    const candidates = registryItems();
    for (const it of candidates) {
      const labels = [
        it.name,
        it.displayName || '',
        preferredLabelForItem(it.name, it.displayName || it.name),
      ];
      if (labels.some((value) => normalizeKey(value) === normalized)) {
        return {
          name: it.name,
          displayName: preferredLabelForItem(it.name, it.displayName || it.name),
          input: raw,
        };
      }
    }

    const looseMatch = candidates.find((it) => {
      const labels = [
        it.name,
        it.displayName || '',
        preferredLabelForItem(it.name, it.displayName || it.name),
      ].map((value) => normalizeKey(value));
      return labels.some((value) => value && (value.includes(normalized) || normalized.includes(value)));
    });
    if (looseMatch) {
      return {
        name: looseMatch.name,
        displayName: preferredLabelForItem(looseMatch.name, looseMatch.displayName || looseMatch.name),
        input: raw,
      };
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

  const taskById = (id) => st.tasks.find((task) => task.id === id);

  const itemPresets = () => {
    return registryItems()
      .filter((item) => item && item.name)
      .map((item) => ({
        name: item.name,
        displayName: preferredLabelForItem(item.name, item.displayName || item.name),
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-CN'));
  };

  const taskTerminalStates = new Set(['delivered', 'cancelled', 'failed']);
  const taskStateRank = (status) => ({
    pending: 0,
    collecting: 1,
    awaiting_partial: 2,
    ready: 3,
    delivering: 4,
    failed: 5,
    cancelled: 6,
    delivered: 7,
  })[status] ?? 7;

  const compareTasks = (a, b) => taskStateRank(a.status) - taskStateRank(b.status) ||
    (a.createdAt || 0) - (b.createdAt || 0) ||
    (a.id || 0) - (b.id || 0);

  const isTaskTerminal = (task) => taskTerminalStates.has(String(task && task.status || ''));

  const activeTasks = () => st.tasks.filter((task) => !isTaskTerminal(task)).sort(compareTasks);

  const taskQueuePosition = (task) => {
    const idx = activeTasks().findIndex((entry) => entry.id === task.id);
    return idx >= 0 ? idx + 1 : null;
  };

  const normalizeTaskItems = (task) => {
    if (!task) return [];
    if (!Array.isArray(task.items) || !task.items.length) {
      const itemName = String(task.itemName || '').trim();
      const requestedCount = Math.max(0, Math.floor(Number(task.requestedCount || 0)));
      if (itemName && requestedCount > 0) {
        task.items = [{
          itemName,
          displayName: task.displayName || itemName,
          requestedInput: task.requestedInput || itemName,
          requestedCount,
          collectedCount: Math.max(0, Math.floor(Number(task.collectedCount || 0))),
        }];
      } else {
        task.items = [];
      }
    }

    const merged = new Map();
    for (const item of task.items) {
      const itemName = String(item && (item.itemName || item.name) || '').trim();
      const requestedCount = Math.max(0, Math.floor(Number(item && (item.requestedCount ?? item.count) || 0)));
      if (!itemName || requestedCount <= 0) continue;
      const existing = merged.get(itemName) || {
        itemName,
        displayName: String(item.displayName || item.label || itemName),
        requestedInput: String(item.requestedInput || item.input || itemName),
        requestedCount: 0,
        collectedCount: 0,
      };
      existing.requestedCount += requestedCount;
      existing.collectedCount += Math.max(0, Math.floor(Number(item && item.collectedCount || 0)));
      if (!existing.displayName && (item.displayName || item.label)) existing.displayName = String(item.displayName || item.label);
      if (!existing.requestedInput && (item.requestedInput || item.input)) existing.requestedInput = String(item.requestedInput || item.input);
      merged.set(itemName, existing);
    }

    task.items = Array.from(merged.values());
    return task.items;
  };

  const refreshTaskCounts = (task) => {
    const items = normalizeTaskItems(task);
    let requestedCount = 0;
    let collectedCount = 0;

    for (const item of items) {
      const actualCount = Math.min(countInInventory(item.itemName), item.requestedCount);
      item.collectedCount = actualCount;
      requestedCount += item.requestedCount;
      collectedCount += actualCount;
    }

    task.requestedCount = requestedCount;
    task.collectedCount = collectedCount;
    task.remainingCount = Math.max(0, requestedCount - collectedCount);
    task.progress = requestedCount > 0 ? Math.min(1, collectedCount / requestedCount) : 0;

    if (items.length) {
      task.itemName = items[0].itemName;
      task.requestedInput = items.length === 1
        ? items[0].requestedInput
        : items.map((item) => item.requestedInput).join(' + ');
      const labels = items.slice(0, 3).map((item) => (
        item.displayName && item.displayName !== item.itemName ? item.displayName : item.itemName
      ));
      task.displayName = items.length === 1
        ? (items[0].displayName || items[0].itemName)
        : `${labels.join('、')}${items.length > 3 ? '…' : ''}`;
    }

    return items;
  };

  const taskLabel = (task) => {
    const items = refreshTaskCounts(task);
    if (!items.length) return task.displayName && task.displayName !== task.itemName
      ? `${task.displayName} (${task.itemName})`
      : task.itemName || '未命名任务';
    if (items.length === 1) {
      return items[0].displayName && items[0].displayName !== items[0].itemName
        ? `${items[0].displayName} (${items[0].itemName})`
        : items[0].itemName;
    }
    const labels = items.slice(0, 3).map((item) => (
      item.displayName && item.displayName !== item.itemName ? item.displayName : item.itemName
    ));
    return `${labels.join('、')}${items.length > 3 ? '…' : ''}（${items.length}种）`;
  };

  const taskDisplayLabel = (task) => taskLabel(task);

  const findOpenTaskForPlayer = (playerName) => {
    const target = String(playerName || '').trim();
    if (!target) return null;
    return activeTasks().find((task) => task.targetPlayer === target) || null;
  };

  const queueNoticeText = (task) => {
    const queuePosition = taskQueuePosition(task);
    if (!queuePosition || queuePosition <= 1) return `> 已收到你的备货申请：${taskDisplayLabel(task)} × ${task.requestedCount}。`;
    return `> 已收到你的备货申请：${taskDisplayLabel(task)} × ${task.requestedCount}，你当前在队列第 ${queuePosition} 位。`;
  };

  const promptBeforeTpa = (task) => {
    if (typeof bot.whisper !== 'function') return;
    bot.whisper(task.targetPlayer, `> ${taskDisplayLabel(task)} 已备好，我准备发起传送送货，你现在方便接货吗？`);
  };

  const startTpaDelivery = (task, source = 'auto', force = false) => {
    if (!task || task.status !== 'ready' || (!force && !task.autoDeliver)) return false;
    if (task.tpaSentAt && task.stage === 'tpa') return false;
    promptBeforeTpa(task);
    sendTpaForTask(task);
    task.tpaSentAt = Date.now();
    task.tpaSource = source;
    setTaskStage(task, 'tpa', '已发起传送，等待自动交付');
    scheduleAutoDeliver(task.id, 1);
    return true;
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
        try {
          return normalizeAxisGroup(entry, 'warehouseContainers');
        } catch (err) {
          return null;
        }
      })
      .filter(Boolean);
  };

  const warehouseContainerVec3s = () => normalizedWarehouseContainers()
    .map((pos) => new Vec3(Number(pos.x), Number(pos.y), Number(pos.z)))
    .filter((pos) => Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z));

  const warehouseFocusPoint = () => {
    if (String(cfg.warehouseMode || 'area') === 'list') {
      const targets = normalizedWarehouseContainers();
      return targets[0] || null;
    }
    return cfg.warehouseCenter || null;
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
    queuePosition: taskQueuePosition(task),
    itemCount: Array.isArray(task.items) ? task.items.length : 0,
    items: (task.items || []).map((item) => ({
      itemName: item.itemName,
      displayName: item.displayName,
      requestedInput: item.requestedInput,
      requestedCount: item.requestedCount,
      collectedCount: Math.min(countInInventory(item.itemName), item.requestedCount),
      remainingCount: Math.max(0, item.requestedCount - Math.min(countInInventory(item.itemName), item.requestedCount)),
    })),
    status: task.status,
    stage: task.stage || null,
    stageLabel: task.stageLabel || null,
    deliveryMode: task.deliveryMode || 'direct',
    autoDeliver: !!task.autoDeliver,
    lastError: task.lastError || null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    readyAt: task.readyAt || null,
    deliveredAt: task.deliveredAt || null,
    partialPromptedAt: task.partialPromptedAt || null,
  });

  const setTaskStage = (task, stage, label) => {
    task.stage = stage || null;
    task.stageLabel = label || null;
    task.updatedAt = Date.now();
  };

  const stopPathfinder = () => {
    try {
      if (bot.pathfinder && typeof bot.pathfinder.stop === 'function') {
        bot.pathfinder.stop();
        return;
      }
      if (bot.pathfinder && typeof bot.pathfinder.setGoal === 'function') {
        bot.pathfinder.setGoal(null);
      }
    } catch (err) {}
  };

  const currentAvailableForTask = (task) => normalizeTaskItems(task)
    .map((item) => {
      const availableCount = Math.min(countInInventory(item.itemName), item.requestedCount);
      return {
        itemName: item.itemName,
        displayName: item.displayName,
        requestedInput: item.requestedInput,
        requestedCount: item.requestedCount,
        availableCount,
        missingCount: Math.max(0, item.requestedCount - availableCount),
      };
    })
    .filter((item) => item.availableCount > 0);

  const partialDeliverySummary = (task) => {
    const availableItems = currentAvailableForTask(task);
    const availableCount = availableItems.reduce((sum, item) => sum + item.availableCount, 0);
    return {
      availableItems,
      availableCount,
      missingCount: Math.max(0, task.requestedCount - availableCount),
    };
  };

  const promptPartialDeliveryChoice = (task) => {
    if (typeof bot.whisper !== 'function') return;
    const partial = partialDeliverySummary(task);
    if (!partial.availableCount) return;
    bot.whisper(task.targetPlayer, `> ${taskDisplayLabel(task)} 目前只备到 ${partial.availableCount}/${task.requestedCount}，请到网页选择“取消任务”或“先送已有物品”。`);
  };

  const markAwaitingPartial = (task, reason = '') => {
    const partial = partialDeliverySummary(task);
    if (!partial.availableCount) throw new Error(reason || `仓库内没有足够的 ${taskDisplayLabel(task)}`);
    task.status = 'awaiting_partial';
    task.lastError = reason || `库存不足，还差 ${partial.missingCount}`;
    task.partialPromptedAt = Date.now();
    setTaskStage(task, 'partial', `库存不足，待网页选择（已备 ${partial.availableCount}/${task.requestedCount}）`);
    promptPartialDeliveryChoice(task);
    return summarizeTask(task);
  };

  const stockItemCount = (itemName) => {
    const entry = (st.stock.items || []).find((item) => item && item.itemName === itemName);
    return entry ? Math.max(0, Number(entry.count || 0)) : 0;
  };

  const simplifyBlockStateName = (value) => String(value || '')
    .trim()
    .replace(/^minecraft:/, '')
    .replace(/\[.*$/, '');

  const readNbtPayload = (buffer) => {
    const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const source = data.length > 2 && data[0] === 0x1f && data[1] === 0x8b
      ? zlib.gunzipSync(data)
      : data;
    let offset = 0;

    const ensure = (size) => {
      if (offset + size > source.length) throw new Error('NBT 数据损坏');
    };

    const readU8 = () => { ensure(1); return source.readUInt8(offset++); };
    const readI8 = () => { ensure(1); return source.readInt8(offset++); };
    const readI16 = () => { ensure(2); const value = source.readInt16BE(offset); offset += 2; return value; };
    const readU16 = () => { ensure(2); const value = source.readUInt16BE(offset); offset += 2; return value; };
    const readI32 = () => { ensure(4); const value = source.readInt32BE(offset); offset += 4; return value; };
    const readBigI64 = () => {
      ensure(8);
      const value = source.readBigInt64BE(offset);
      offset += 8;
      return value;
    };
    const readF32 = () => { ensure(4); const value = source.readFloatBE(offset); offset += 4; return value; };
    const readF64 = () => { ensure(8); const value = source.readDoubleBE(offset); offset += 8; return value; };
    const readString = () => {
      const length = readU16();
      ensure(length);
      const value = source.toString('utf8', offset, offset + length);
      offset += length;
      return value;
    };
    const readByteArray = () => {
      const length = readI32();
      ensure(length);
      const value = source.slice(offset, offset + length);
      offset += length;
      return value;
    };
    const readIntArray = () => {
      const length = readI32();
      const value = [];
      for (let i = 0; i < length; i += 1) value.push(readI32());
      return value;
    };
    const readLongArray = () => {
      const length = readI32();
      const value = [];
      for (let i = 0; i < length; i += 1) value.push(readBigI64());
      return value;
    };
    const readTagPayload = (type) => {
      switch (type) {
        case 0: return null;
        case 1: return readI8();
        case 2: return readI16();
        case 3: return readI32();
        case 4: return readBigI64();
        case 5: return readF32();
        case 6: return readF64();
        case 7: return readByteArray();
        case 8: return readString();
        case 9: {
          const itemType = readU8();
          const length = readI32();
          const list = [];
          for (let i = 0; i < length; i += 1) list.push(readTagPayload(itemType));
          return list;
        }
        case 10: {
          const compound = {};
          while (true) {
            const innerType = readU8();
            if (innerType === 0) break;
            const name = readString();
            compound[name] = readTagPayload(innerType);
          }
          return compound;
        }
        case 11: return readIntArray();
        case 12: return readLongArray();
        default: throw new Error(`不支持的 NBT 标签类型: ${type}`);
      }
    };

    const rootType = readU8();
    if (rootType === 0) return null;
    readString();
    return readTagPayload(rootType);
  };

  const countPackedIndices = (values, bitsPerEntry, totalEntries) => {
    if (!Array.isArray(values) || !values.length || !bitsPerEntry) return [];
    const longs = values.map((value) => BigInt.asUintN(64, BigInt(value)));
    const mask = (1n << BigInt(bitsPerEntry)) - 1n;
    const counts = new Map();

    for (let index = 0; index < totalEntries; index += 1) {
      const bitIndex = BigInt(index * bitsPerEntry);
      const longIndex = Number(bitIndex / 64n);
      const startOffset = Number(bitIndex % 64n);
      let entry = longs[longIndex] >> BigInt(startOffset);
      const spill = startOffset + bitsPerEntry - 64;
      if (spill > 0) {
        const next = longs[longIndex + 1] || 0n;
        entry |= next << BigInt(64 - startOffset);
      }
      const paletteIndex = Number(entry & mask);
      counts.set(paletteIndex, (counts.get(paletteIndex) || 0) + 1);
    }

    return counts;
  };

  const decodeLitematicProjection = (buffer, fileName = '') => {
    const root = readNbtPayload(buffer);
    const regions = root && root.Regions && typeof root.Regions === 'object' ? root.Regions : null;
    if (!regions) throw new Error('没有找到 Litematica 区域数据');
    const merged = new Map();

    for (const region of Object.values(regions)) {
      if (!region) continue;
      const palette = Array.isArray(region.BlockStatePalette) ? region.BlockStatePalette : [];
      const blockStates = Array.isArray(region.BlockStates) ? region.BlockStates : [];
      const size = region.Size && typeof region.Size === 'object'
        ? [Math.abs(Number(region.Size.x || region.Size.X || 0)), Math.abs(Number(region.Size.y || region.Size.Y || 0)), Math.abs(Number(region.Size.z || region.Size.Z || 0))]
        : [0, 0, 0];
      const totalBlocks = Math.max(0, size[0] * size[1] * size[2]);
      const bitsPerEntry = Math.max(2, Math.ceil(Math.log2(Math.max(1, palette.length))));
      const counts = countPackedIndices(blockStates, bitsPerEntry, totalBlocks);

      counts.forEach((count, paletteIndex) => {
        const entry = palette[paletteIndex] || {};
        const name = simplifyBlockStateName(entry.Name || entry.name || entry.id);
        if (!name || name === 'air') return;
        merged.set(name, (merged.get(name) || 0) + count);
      });
    }

    return Array.from(merged.entries())
      .map(([itemName, requiredCount]) => ({
        itemName,
        displayName: preferredLabelForItem(itemName, itemName),
        requestedInput: itemName,
        requiredCount,
      }))
      .sort((a, b) => b.requiredCount - a.requiredCount || a.itemName.localeCompare(b.itemName, 'zh-CN'));
  };

  const decodeSchemProjection = (buffer) => {
    const root = readNbtPayload(buffer);
    if (!root || !root.Palette || !root.BlockData) throw new Error('没有找到 Schematic 数据');
    const palette = root.Palette && typeof root.Palette === 'object' ? root.Palette : {};
    const inverse = new Map(Object.entries(palette).map(([name, index]) => [Number(index), simplifyBlockStateName(name)]));
    const width = Math.max(0, Number(root.Width || 0));
    const height = Math.max(0, Number(root.Height || 0));
    const length = Math.max(0, Number(root.Length || 0));
    const totalBlocks = width * height * length;
    const bytes = Buffer.isBuffer(root.BlockData) ? root.BlockData : Buffer.from(root.BlockData || []);

    const readVarInt = (start) => {
      let numRead = 0;
      let result = 0;
      let byte;
      do {
        if (start + numRead >= bytes.length) throw new Error('Schematic 数据损坏');
        byte = bytes[start + numRead];
        const value = byte & 0x7f;
        result |= value << (7 * numRead);
        numRead += 1;
        if (numRead > 5) throw new Error('Schematic BlockData 过长');
      } while ((byte & 0x80) !== 0);
      return { value: result, length: numRead };
    };

    const merged = new Map();
    let offset = 0;
    for (let i = 0; i < totalBlocks && offset < bytes.length; i += 1) {
      const { value, length: consumed } = readVarInt(offset);
      offset += consumed;
      const name = inverse.get(value) || null;
      if (!name || name === 'air') continue;
      merged.set(name, (merged.get(name) || 0) + 1);
    }

    return Array.from(merged.entries())
      .map(([itemName, requiredCount]) => ({
        itemName,
        displayName: preferredLabelForItem(itemName, itemName),
        requestedInput: itemName,
        requiredCount,
      }))
      .sort((a, b) => b.requiredCount - a.requiredCount || a.itemName.localeCompare(b.itemName, 'zh-CN'));
  };

  const analyzeProjectionFile = (fileName, buffer) => {
    const name = String(fileName || '').toLowerCase();
    if (name.endsWith('.litematic')) return decodeLitematicProjection(buffer, fileName);
    if (name.endsWith('.schem') || name.endsWith('.schematic')) return decodeSchemProjection(buffer, fileName);
    throw new Error('只支持 .litematic / .schem / .schematic 文件');
  };

  const reconcileTask = (task) => {
    if (!task || task.status === 'cancelled' || task.status === 'delivered' || task.status === 'failed') return;
    if (task.status === 'awaiting_partial') {
      task.updatedAt = Date.now();
      setTaskStage(task, 'partial', task.stageLabel || '等待网页选择');
      return;
    }

    refreshTaskCounts(task);
    task.updatedAt = Date.now();
    const enough = task.collectedCount >= task.requestedCount && task.requestedCount > 0;
    const queuePosition = taskQueuePosition(task);

    if (st.activeDeliveryId === task.id) {
      task.status = 'delivering';
      setTaskStage(task, 'delivering', '正在交付');
      return;
    }

    if (st.activeFulfillmentId === task.id || st.activeRequestId === task.id) {
      task.status = 'collecting';
      setTaskStage(task, 'collect', '正在补货');
      return;
    }

    if (enough) {
      if (task.status !== 'ready') task.readyAt = Date.now();
      task.status = 'ready';
      if (task.autoDeliver && task.deliveryMode === 'tpa' && !task.tpaSentAt) {
        setTaskStage(task, 'queue', queuePosition && queuePosition > 1
          ? `已备齐，排队第 ${queuePosition} 位`
          : '已备齐，等待传送');
      } else {
        setTaskStage(task, 'ready', queuePosition && queuePosition > 1
          ? `已备齐，排队第 ${queuePosition} 位`
          : '已备齐，等待交付');
      }
      return;
    }

    task.readyAt = null;
    task.status = 'pending';
    if (queuePosition && queuePosition > 1) {
      setTaskStage(task, 'queue', `排队中，第 ${queuePosition} 位`);
    } else if (!task.stage || task.stage === 'queue') {
      setTaskStage(task, 'pending', '等待补货');
    }
  };

  const reconcileAll = () => {
    for (const task of st.tasks) reconcileTask(task);

    if (!st.fulfillmentPromise) {
      const nextNeed = activeTasks().find((task) => task.status === 'pending' || task.status === 'collecting');
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
      const next = activeTasks().find((task) => task.status === 'ready' && task.autoDeliver);
      if (next) {
        if (next.stage === 'tpa') return;
        if (next.deliveryMode === 'tpa') {
          if (!next.tpaSentAt) {
            next.lastError = null;
            try {
              startTpaDelivery(next, 'queue');
            } catch (err) {
              next.lastError = err.message;
              setTaskStage(next, 'ready', '发起传送失败，等待重试');
            }
            return;
          }
        } else {
          const player = bot.players && bot.players[next.targetPlayer];
          if ((!player || !player.entity) && next.stage !== 'tpa') {
            next.lastError = null;
            setTaskStage(next, 'tpa', '目标不在视线内，已发起传送');
            try {
              promptBeforeTpa(next);
              sendTpaForTask(next);
              scheduleAutoDeliver(next.id, 1);
            } catch (err) {
              next.lastError = err.message;
              setTaskStage(next, 'ready', '发起传送失败，等待重试');
            }
            return;
          }
        }
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
    const focus = warehouseFocusPoint();
    if (!focus) throw new Error(String(cfg.warehouseMode || 'area') === 'list' ? '未配置仓库箱子坐标' : '未配置仓库中心坐标');
    if (!bot.entity) throw new Error('机器人尚未进入世界');
    if (!bot.pathfinder) throw new Error('未检测到寻路模块，请先启用 navigator 插件');

    const targetPoint = { x: Number(focus.x || 0), y: Number(focus.y || 0), z: Number(focus.z || 0) };
    const radius = Math.max(1, Math.min(
      Number(cfg.warehouseSize && cfg.warehouseMode !== 'list' ? cfg.warehouseSize.x || 0 : 0),
      Number(cfg.warehouseSize && cfg.warehouseMode !== 'list' ? cfg.warehouseSize.z || 0 : 0),
      3
    ));

    if (insideWarehouse(bot.entity.position)) {
      stopPathfinder();
      return;
    }

    if (task) setTaskStage(task, 'warehouse', '正在前往仓库中心');
    bot.pathfinder.setGoal(new GoalNear(targetPoint.x, targetPoint.y, targetPoint.z, radius));
    try {
      await waitUntilNearPoint(targetPoint, Math.max(radius + 1, 3), cfg.deliveryMoveTimeoutMs);
    } catch (err) {
      if (String(err.message || '').includes('接近目标超时')) {
        throw new Error(`前往仓库超时（>${Math.round(cfg.deliveryMoveTimeoutMs / 1000)} 秒）`);
      }
      throw err;
    }
    stopPathfinder();
    await sleep(500);
  };

  const waitForPlayerArrival = async (playerName, timeoutMs) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const player = bot.players && bot.players[playerName];
      if (player && player.entity && bot.entity && bot.entity.position.distanceTo(player.entity.position) <= cfg.handoffDistance) {
        return player.entity;
      }
      await sleep(200);
    }
    throw new Error(`等待玩家接受 TPA 超时（>${Math.round(timeoutMs / 1000)} 秒）`);
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
    const ids = blockIds(cfg.warehouseBlocks);
    if (String(cfg.warehouseMode || 'area') === 'list') {
      // 指定坐标可能位于尚未加载的区块，不能在走过去之前调用 blockAt 过滤。
      return warehouseContainerVec3s();
    }
    if (typeof bot.findBlocks !== 'function') return [];
    if (!ids.length) return [];
    const maxDistance = Math.max(
      Number(cfg.warehouseSize.x || 0),
      Number(cfg.warehouseSize.y || 0),
      Number(cfg.warehouseSize.z || 0)
    ) + 8;
    const center = bot.entity && bot.entity.position
      ? bot.entity.position
      : new Vec3(Number(cfg.warehouseCenter.x || 0), Number(cfg.warehouseCenter.y || 0), Number(cfg.warehouseCenter.z || 0));
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

  let activeScanPromise = null;

  const runWarehouseScan = async (reason, allowRetry) => {
    try {
      await moveToWarehouseCenter();
      const positions = warehouseContainerPositions();
      if (!positions.length) {
        throw new Error(String(cfg.warehouseMode || 'area') === 'list'
          ? '没有可扫描的箱子坐标，请先在仓库设置里添加并保存坐标'
          : '指定范围内没有找到可扫描的容器');
      }
      const merged = new Map();

      const configuredContainerIds = blockIds(cfg.warehouseBlocks);
      for (const pos of positions) {
        let block = null;
        try {
          if (String(cfg.warehouseMode || 'area') === 'list') {
            await approachPoint(pos, 2);
            block = bot.blockAt(pos);
            if (!block) throw new Error(`坐标 ${pos.x},${pos.y},${pos.z} 处没有加载方块`);
            if (!configuredContainerIds.includes(block.type)) {
              throw new Error(`坐标 ${pos.x},${pos.y},${pos.z} 不是已配置的容器`);
            }
          } else {
            block = bot.blockAt(pos);
            if (!block) continue;
            await approachBlock(block, 2);
          }
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
          if (isWarehouseStuckError(err)) throw err;
          const targetLabel = block && block.name ? block.name : `${pos.x},${pos.y},${pos.z}`;
          st.stock.lastError = `扫描 ${targetLabel} 失败: ${err.message}`;
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
    } catch (err) {
      if (allowRetry && isWarehouseStuckError(err)) {
        st.stock.lastError = `扫描卡住，已执行回仓并重试: ${err.message}`;
        await recoverWarehouseStuck(null, '仓库扫描卡住');
        return runWarehouseScan(`${reason}:retry`, false);
      }
      throw err;
    }
  };

  const scanWarehouseInventory = (reason = 'manual') => {
    if (activeScanPromise) {
      return Promise.reject(new Error('已有扫描正在进行'));
    }

    st.stock.scanning = true;
    st.stock.lastError = null;
    activeScanPromise = runWarehouseScan(reason, true).catch((err) => {
      st.stock.lastError = err.message;
      throw err;
    }).finally(() => {
      stopPathfinder();
      st.stock.scanning = false;
      activeScanPromise = null;
    });
    return activeScanPromise;
  };

  const approachPoint = async (point, distance = cfg.blockApproachDistance) => {
    if (!point) throw new Error('目标坐标不可用');
    if (!bot.pathfinder) throw new Error('未检测到寻路模块，请先启用 navigator 插件');
    bot.pathfinder.setGoal(new GoalNear(
      point.x,
      point.y,
      point.z,
      Math.max(1, Math.ceil(distance))
    ));
    try {
      await waitUntilNearPoint(point, distance + 0.8, cfg.deliveryMoveTimeoutMs);
    } catch (err) {
      if (String(err.message || '').includes('接近目标超时')) {
        throw new Error(`接近容器超时（>${Math.round(cfg.deliveryMoveTimeoutMs / 1000)} 秒）`);
      }
      throw err;
    }
    stopPathfinder();
  };

  const approachBlock = async (block, distance = cfg.blockApproachDistance) => {
    if (!block || !block.position) throw new Error('目标方块不可用');
    await approachPoint(block.position, distance);
  };

  const openContainerBlock = async (block) => {
    const opener = typeof bot.openContainer === 'function'
      ? () => bot.openContainer(block)
      : (typeof bot.openChest === 'function' ? () => bot.openChest(block) : null);
    if (!opener) throw new Error('当前机器人不支持打开容器');
    const timeoutMs = Math.max(1000, Number(cfg.containerOpenTimeoutMs || 8000));
    return Promise.race([
      opener(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`打开容器超时（>${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs)),
    ]);
  };

  const containerItems = (container) => {
    if (!container) return [];
    if (typeof container.containerItems === 'function') return container.containerItems();
    if (typeof container.items === 'function') return container.items();
    return Array.isArray(container.slots) ? container.slots.filter(Boolean) : [];
  };

  const withdrawFromStorage = async (task, item, needed, allowRetry = true) => {
    const positions = warehouseContainerPositions();
    if (!positions.length) return 0;

    let taken = 0;
    for (const pos of positions) {
      if (taken >= needed) break;
      try {
        if (String(cfg.warehouseMode || 'area') === 'list') {
          await approachPoint(pos, 2);
        }
        const block = bot.blockAt(pos);
        if (!block) throw new Error(`坐标 ${pos.x},${pos.y},${pos.z} 处没有加载方块`);
        if (String(cfg.warehouseMode || 'area') === 'list') {
          const configuredContainerIds = blockIds(cfg.warehouseBlocks);
          if (!configuredContainerIds.includes(block.type)) {
            throw new Error(`坐标 ${pos.x},${pos.y},${pos.z} 不是已配置的容器`);
          }
        } else {
          await approachBlock(block, 2);
        }
        setTaskStage(task, 'storage', `前往 ${block.name} 取 ${item.displayName || item.itemName}`);
        const container = await openContainerBlock(block);
        try {
          const stack = containerItems(container).find((slot) => slot && slot.name === item.itemName);
          if (!stack) continue;
          const amount = Math.min(needed - taken, stack.count);
          setTaskStage(task, 'storage', `从 ${block.name} 取出 ${item.displayName || item.itemName} × ${amount}`);
          await container.withdraw(stack.type, stack.metadata, amount);
          taken += amount;
          await sleep(cfg.collectPauseMs);
        } finally {
          if (typeof container.close === 'function') {
            try { container.close(); } catch (err) {}
          }
        }
      } catch (err) {
        if (allowRetry && isWarehouseStuckError(err)) {
          task.lastError = `仓库流程卡住，已执行回仓并重试: ${err.message}`;
          await recoverWarehouseStuck(task, '仓库取货卡住');
          return taken + await withdrawFromStorage(task, item, needed - taken, false);
        }
        task.lastError = `仓库取货失败: ${item.displayName || item.itemName} - ${err.message}`;
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
    if (task.status === 'cancelled') return summarizeTask(task);

    const items = normalizeTaskItems(task).slice();
    for (const item of items) {
      if (task.status === 'cancelled') return summarizeTask(task);
      const need = () => Math.max(0, item.requestedCount - Math.min(countInInventory(item.itemName), item.requestedCount));
      while (need() > 0) {
        if (task.status === 'cancelled') return summarizeTask(task);
        const missingNow = need();
        const pulled = await withdrawFromStorage(task, item, missingNow);
        refreshTaskCounts(task);
        if (pulled > 0) {
          setTaskStage(task, 'storage', `已从仓库补到 ${taskLabel(task)} ${task.collectedCount}/${task.requestedCount}`);
        }
        if (task.status === 'cancelled') return summarizeTask(task);
        if (need() <= 0) break;
        const missing = need();
        if (task.collectedCount > 0) {
          return markAwaitingPartial(task, `仓库内没有足够的 ${item.displayName || item.itemName}，当前仍缺少 ${missing} 个`);
        }
        throw new Error(`仓库内没有足够的 ${item.displayName || item.itemName}，当前仍缺少 ${missing} 个`);
      }
    }

    reconcileTask(task);
    return summarizeTask(task);
  }

  async function deliverTask(id, source = 'manual', options = {}) {
    const task = taskById(id);
    if (!task) throw new Error('任务不存在');
    if (task.status === 'cancelled') throw new Error('任务已取消');
    if (task.status === 'delivered') throw new Error('任务已完成');
    if (st.activeDeliveryId && st.activeDeliveryId !== task.id) throw new Error('已有其他任务正在交付');

    reconcileTask(task);
    const partialAllowed = !!options.allowPartial || source === 'partial';
    if (task.collectedCount < task.requestedCount && !partialAllowed) {
      if (task.collectedCount > 0) return markAwaitingPartial(task);
      throw new Error(`库存不足，还差 ${task.requestedCount - task.collectedCount}`);
    }

    const deliveryItems = partialAllowed
      ? currentAvailableForTask(task)
      : normalizeTaskItems(task).map((item) => ({
        itemName: item.itemName,
        displayName: item.displayName,
        requestedInput: item.requestedInput,
        requestedCount: item.requestedCount,
        availableCount: item.requestedCount,
        missingCount: 0,
      }));
    const totalDeliverCount = deliveryItems.reduce((sum, item) => sum + item.availableCount, 0);
    if (!totalDeliverCount) {
      if (partialAllowed) throw new Error('当前没有可送的物品');
      throw new Error(`库存不足，还差 ${task.requestedCount - task.collectedCount}`);
    }

    st.activeDeliveryId = task.id;
    task.status = 'delivering';
    task.lastError = null;
    task.updatedAt = Date.now();

    try {
      if (!task.tpaSentAt || task.stage !== 'tpa') {
        promptBeforeTpa(task);
        sendTpaForTask(task);
        task.tpaSentAt = Date.now();
        task.tpaSource = source;
        setTaskStage(task, 'tpa', '已发起传送，等待自动交付');
      }

      const targetEntity = await waitForPlayerArrival(task.targetPlayer, cfg.deliveryMoveTimeoutMs);
      if (typeof bot.lookAt === 'function') {
        await bot.lookAt(targetEntity.position.offset(0, 1.2, 0), true);
      }
      for (const item of deliveryItems) {
        await tossExact(item.itemName, item.availableCount);
      }
      if (partialAllowed) {
        for (const delivered of deliveryItems) {
          const entry = normalizeTaskItems(task).find((item) => item.itemName === delivered.itemName);
          if (!entry) continue;
          entry.requestedCount = Math.max(0, entry.requestedCount - delivered.availableCount);
        }
        task.items = normalizeTaskItems(task).filter((item) => item.requestedCount > 0);
        refreshTaskCounts(task);
        if (!task.items.length || task.requestedCount <= 0) {
          task.status = 'delivered';
          setTaskStage(task, 'delivered', '已交付完成');
          task.deliveredAt = Date.now();
        } else {
          task.status = 'pending';
          setTaskStage(task, 'pending', '已送出当前可用物品，等待继续补货');
          task.partialPromptedAt = null;
        }
      } else {
        task.collectedCount = task.requestedCount;
        task.status = 'delivered';
        setTaskStage(task, 'delivered', '已交付完成');
        task.deliveredAt = Date.now();
        task.updatedAt = task.deliveredAt;
      }
      try {
        sendHome();
      } catch (homeErr) {
        task.lastError = `已送达，但回仓失败: ${homeErr.message}`;
      }
      console.log(`[stock-prep] 任务 #${task.id} 已交付给 ${task.targetPlayer}: ${taskLabel(task)} x${task.requestedCount} (${source})`);
      if (typeof bot.whisper === 'function') {
        bot.whisper(task.targetPlayer, `> 你的备货已送达：${taskLabel(task)} × ${task.requestedCount}`);
      }
      return summarizeTask(task);
    } catch (err) {
      const shouldFallbackToTpa = cfg.fallbackToTpaOnDeliveryTimeout &&
        typeof err.message === 'string' &&
        err.message.includes('接近目标超时') &&
        !String(source).startsWith('auto-after-tpa:');

      if (shouldFallbackToTpa) {
        task.lastError = null;
        setTaskStage(task, 'tpa', '寻路超时，已改为传送送货');
        startTpaDelivery(task, 'fallback', true);
        if (typeof bot.whisper === 'function') {
          bot.whisper(task.targetPlayer, `> 送货路上卡住了，已改为向你发起传送并继续自动交付 ${taskLabel(task)} × ${task.requestedCount}。`);
        }
        return summarizeTask(task);
      }

      task.lastError = err.message;
      task.updatedAt = Date.now();
      reconcileTask(task);
      throw err;
    } finally {
      stopPathfinder();
      st.activeDeliveryId = null;
    }
  }

  const createTask = (payload) => {
    const item = resolveItem(payload.item);
    if (!item) throw new Error('无法识别物品，请填写原版物品 ID 或在配置里增加别名');

    const requestedCount = Math.floor(Number(payload.count));
    if (!Number.isInteger(requestedCount) || requestedCount <= 0) {
      throw new Error('数量必须是正整数');
    }

    const targetPlayer = String(payload.targetPlayer || '').trim();
    if (!targetPlayer) throw new Error('目标玩家不能为空');

    const autoDeliver = payload.autoDeliver == null ? !!cfg.autoDeliverByDefault : !!payload.autoDeliver;
    const deliveryMode = String(payload.deliveryMode || 'direct').trim().toLowerCase() === 'tpa' ? 'tpa' : 'direct';
    const existingTask = findOpenTaskForPlayer(targetPlayer);
    const canMerge = !!existingTask && existingTask.status !== 'delivering';
    let task = existingTask;
    let merged = false;

    if (canMerge) {
      const items = normalizeTaskItems(task);
      const sameItem = items.find((entry) => entry.itemName === item.name);
      if (sameItem) {
        sameItem.requestedCount += requestedCount;
      } else {
        items.push({
          itemName: item.name,
          displayName: item.displayName,
          requestedInput: item.input,
          requestedCount,
          collectedCount: 0,
        });
      }
      task.autoDeliver = task.autoDeliver || autoDeliver;
      task.deliveryMode = task.deliveryMode === 'tpa' || deliveryMode === 'tpa' ? 'tpa' : 'direct';
      task.lastError = null;
      task.updatedAt = Date.now();
      refreshTaskCounts(task);
      reconcileTask(task);
      merged = true;
    } else {
      const openTaskCount = st.tasks.filter((entry) => !isTaskTerminal(entry) && entry.status !== 'delivering').length;
      if (openTaskCount >= cfg.maxTasks) {
        throw new Error(`任务过多，最多保留 ${cfg.maxTasks} 个未结束任务`);
      }

      task = {
        id: st.nextId++,
        itemName: item.name,
        displayName: item.displayName,
        requestedInput: item.input,
        targetPlayer,
        items: [{
          itemName: item.name,
          displayName: item.displayName,
          requestedInput: item.input,
          requestedCount,
          collectedCount: 0,
        }],
        requestedCount,
        collectedCount: 0,
        remainingCount: requestedCount,
        progress: 0,
        status: 'pending',
        stage: 'pending',
        stageLabel: '等待补货',
        autoDeliver,
        deliveryMode,
        lastError: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        readyAt: null,
        deliveredAt: null,
        tpaSentAt: null,
      };

      st.tasks.unshift(task);
      refreshTaskCounts(task);
      reconcileTask(task);
    }

    const queuePosition = taskQueuePosition(task);
    const display = taskDisplayLabel(task);
    console.log(`[stock-prep] ${merged ? '合并任务' : '新任务'} #${task.id}: ${display} x${task.requestedCount} -> ${task.targetPlayer}`);

    if (payload.notifyPlayer && typeof bot.whisper === 'function') {
      bot.whisper(targetPlayer, merged
        ? `> 已把 ${display} 合并到你的任务里，当前总计 ${task.requestedCount} 个。${queuePosition && queuePosition > 1 ? `你当前在队列第 ${queuePosition} 位。` : ''}`
        : queueNoticeText(task));
    }

    reconcileAll();
    return { task: summarizeTask(task), merged, queuePosition };
  };

  const createProjectionTask = (payload = {}) => {
    const projection = projectionPayload();
    const targetPlayer = String(payload.targetPlayer || projection.targetPlayer || '').trim();
    if (!targetPlayer) throw new Error('目标玩家不能为空');
    const autoDeliver = payload.autoDeliver == null ? true : !!payload.autoDeliver;
    const items = projection.blocks.filter((item) => Number(item.availableCount || 0) > 0);
    if (!items.length) throw new Error('当前投影没有可先运送的物品');

    let result = null;
    for (const item of items) {
      result = createTask({
        item: item.itemName,
        count: item.availableCount,
        targetPlayer,
        autoDeliver,
        deliveryMode: 'tpa',
        notifyPlayer: false,
      });
    }

    if (typeof bot.whisper === 'function') {
      bot.whisper(targetPlayer, `> 投影已识别：可先运送 ${projection.totalAvailable} 个，缺少 ${projection.totalMissing} 个。`);
    }

    return {
      task: result ? result.task : null,
      merged: result ? result.merged : false,
      projection: projectionPayload(),
    };
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
    if (st.activeFulfillmentId === id) st.activeFulfillmentId = null;
    if (st.activeRequestId === id) st.activeRequestId = null;
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
      tasks: st.tasks.slice().sort(compareTasks).map(summarizeTask),
      aliases: cfg.aliases,
      warehouseMode: cfg.warehouseMode,
      warehouseBlocks: cfg.warehouseBlocks,
      warehouseCenter: cfg.warehouseCenter,
      warehouseSize: cfg.warehouseSize,
      warehouseContainers: normalizedWarehouseContainers(),
      tpaCommand: cfg.tpaCommand,
      itemPresets: itemPresets(),
      stock: {
        items: st.stock.items,
        scannedAt: st.stock.scannedAt,
        lastError: st.stock.lastError,
        scanning: st.stock.scanning,
      },
      projection: projectionPayload(),
    };
  };

  const projectionPayload = () => ({
    ...st.projection,
    blocks: Array.isArray(st.projection.blocks) ? st.projection.blocks : [],
  });

  const settingsPayload = () => ({
    warehouseMode: cfg.warehouseMode,
    warehouseCenter: cfg.warehouseCenter,
    warehouseSize: cfg.warehouseSize,
    warehouseContainers: normalizedWarehouseContainers(),
    warehouseBlocks: cfg.warehouseBlocks,
    tpaCommand: cfg.tpaCommand,
    homeCommand: cfg.homeCommand,
    fallbackToTpaOnDeliveryTimeout: cfg.fallbackToTpaOnDeliveryTimeout,
    maxStorageBlocksScan: cfg.maxStorageBlocksScan,
  });

  const fillTemplate = (template, params) => {
    let result = String(template || '');
    for (const [key, value] of Object.entries(params || {})) {
      result = result.replaceAll(`{${key}}`, String(value));
    }
    return result;
  };

  const runChatCommand = (command, label) => {
    const text = String(command || '').trim();
    if (!text) throw new Error(`${label} 未配置`);
    if (typeof bot.chat !== 'function') throw new Error(`当前机器人无法执行${label}`);
    bot.chat(text);
    return text;
  };

  const isWarehouseStuckError = (err) => {
    const message = String((err && err.message) || '');
    return message.includes('前往仓库超时') ||
      message.includes('接近容器超时') ||
      message.includes('打开容器超时');
  };

  const sendTpaForTask = (task) => {
    const tpaCommand = fillTemplate(cfg.tpaCommand, {
      player: task.targetPlayer,
      username: task.targetPlayer,
      item: task.itemName,
      count: task.requestedCount,
    }).trim();
    task.updatedAt = Date.now();
    return runChatCommand(tpaCommand, 'TPA 指令');
  };

  const sendHome = () => {
    const homeCommand = String(cfg.homeCommand || '/home').trim();
    return runChatCommand(homeCommand, '回仓指令');
  };

  const recoverWarehouseStuck = async (task = null, label = '仓库流程卡住') => {
    if (task) setTaskStage(task, 'home', `${label}，正在回仓`);
    stopPathfinder();
    sendHome();
    await sleep(2000);
  };

  const scheduleAutoDeliver = (taskId, attempt = 1) => {
    const delay = attempt === 1
      ? cfg.postTpaAutoDeliverDelayMs
      : Math.max(25000, Number(cfg.postTpaAutoDeliverRetryMs || 25000));
    setTimeout(() => {
      const task = taskById(taskId);
      if (!task || task.status === 'delivered' || task.status === 'cancelled' || task.status === 'failed') return;
      if (st.activeDeliveryId && st.activeDeliveryId !== taskId) {
        return scheduleAutoDeliver(taskId, attempt);
      }

      deliverTask(taskId, `auto-after-tpa:${attempt}`).catch((err) => {
        task.lastError = err.message;
        if (attempt < cfg.postTpaAutoDeliverMaxAttempts) {
          task.tpaSentAt = null;
          setTaskStage(task, 'tpa', `已发起传送，等待交付（重试 ${attempt}/${cfg.postTpaAutoDeliverMaxAttempts}）`);
          scheduleAutoDeliver(taskId, attempt + 1);
        } else {
          task.tpaSentAt = null;
          setTaskStage(task, 'ready', '传送后自动交付超时，请手动补发');
        }
      });
    }, Math.max(0, delay));
  };

  const requestByCommand = async (username, itemInput, countInput) => {
    try {
      return createTask({
        item: itemInput,
        count: countInput,
        targetPlayer: username,
        autoDeliver: true,
        deliveryMode: 'tpa',
        notifyPlayer: true,
      });
    } catch (err) {
      if (typeof bot.whisper === 'function') {
        bot.whisper(username, `> ${err.message}`);
      }
      throw err;
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
    const { warehouseMode, warehouseCenter, warehouseSize, warehouseBlocks, warehouseContainers, tpaCommand, homeCommand, fallbackToTpaOnDeliveryTimeout, maxStorageBlocksScan } = payload;

    if (warehouseMode !== undefined) {
      const mode = String(warehouseMode || '').trim().toLowerCase();
      if (!['area', 'list'].includes(mode)) throw new Error('warehouseMode 只能是 area 或 list');
      cfg.warehouseMode = mode;
    }
    if (warehouseCenter !== undefined) cfg.warehouseCenter = normalizeAxisGroup(warehouseCenter, 'warehouseCenter');
    if (warehouseSize !== undefined) {
      const nextSize = normalizeAxisGroup(warehouseSize, 'warehouseSize');
      if (nextSize.x < 0 || nextSize.y < 0 || nextSize.z < 0) throw new Error('warehouseSize 不能为负数');
      cfg.warehouseSize = nextSize;
    }
    if (warehouseContainers !== undefined) {
      if (!Array.isArray(warehouseContainers)) throw new Error('warehouseContainers 必须是数组');
      cfg.warehouseContainers = warehouseContainers.map((entry, index) => normalizeAxisGroup(entry, `warehouseContainers[${index}]`));
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
    if (homeCommand !== undefined) {
      if (typeof homeCommand !== 'string' || !homeCommand.trim()) throw new Error('homeCommand 不能为空');
      cfg.homeCommand = homeCommand.trim();
    }
    if (fallbackToTpaOnDeliveryTimeout !== undefined) {
      cfg.fallbackToTpaOnDeliveryTimeout = !!fallbackToTpaOnDeliveryTimeout;
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
    const result = createTask(jsonBody(body) || {});
    ok(res, result);
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
    const task = await deliverTask(Number(payload.id), payload.partial ? 'partial' : 'web', { allowPartial: !!payload.partial });
    ok(res, { task });
  });

  ep('POST', 'deliver-partial', async (req, res, url, body) => {
    const payload = jsonBody(body) || {};
    const task = await deliverTask(Number(payload.id), 'partial', { allowPartial: true });
    ok(res, { task });
  });

  ep('POST', 'projection/analyze', async (req, res, url, body) => {
    const payload = jsonBody(body) || {};
    const fileName = String(payload.fileName || '').trim();
    const dataBase64 = String(payload.dataBase64 || '').trim();
    if (!fileName) throw new Error('文件名不能为空');
    if (!dataBase64) throw new Error('文件内容不能为空');

    const buffer = Buffer.from(dataBase64.replace(/^data:.*;base64,/, ''), 'base64');
    if (!buffer.length) throw new Error('文件内容无效');

    await scanWarehouseInventory('projection');
    const blocks = analyzeProjectionFile(fileName, buffer).map((item) => {
      const availableCount = stockItemCount(item.itemName);
      return {
        ...item,
        availableCount,
        missingCount: Math.max(0, item.requiredCount - availableCount),
      };
    });
    const totalRequired = blocks.reduce((sum, item) => sum + item.requiredCount, 0);
    const totalAvailable = blocks.reduce((sum, item) => sum + item.availableCount, 0);
    const totalMissing = blocks.reduce((sum, item) => sum + item.missingCount, 0);
    st.projection = {
      fileName,
      blocks,
      scannedAt: Date.now(),
      lastError: null,
      targetPlayer: String(payload.targetPlayer || '').trim(),
      totalRequired,
      totalAvailable,
      totalMissing,
    };
    ok(res, { projection: projectionPayload() });
  });

  ep('POST', 'projection/create-available', async (req, res, url, body) => {
    const payload = jsonBody(body) || {};
    const result = createProjectionTask(payload);
    ok(res, result);
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
      requestByCommand(username, args[0], args[1]).catch(() => {});
    },
  });

  if (!st.timer) {
    st.timer = setInterval(reconcileAll, Math.max(500, cfg.reconcileIntervalMs));
    if (typeof st.timer.unref === 'function') st.timer.unref();
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
