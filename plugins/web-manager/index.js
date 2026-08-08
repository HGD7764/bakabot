// plugins/web-manager/index.js
// Web 管理插件：零依赖 HTTP 服务 + 插件磁贴/重载/配置/权限管理 + 插件接入接口
const http = require('http');
const fs = require('fs');
const path = require('path');
const { resolveTex } = require('./texture-map'); // 物品 → 纹理文件名映射（1.21.11 仓库验证）

module.exports = (context) => {
  const { bot, config, state, permissions, pluginConfig, webManager, commands } = context;

  const pluginsDir = path.join(__dirname, '..');
  const cfg = { host: '127.0.0.1', port: 8123, token: '', ...(pluginConfig || {}) };

  // ---- 共享状态（跨重载存活）----
  // ⚠️ 承重细节：HTTP 服务器只在首次运行时创建，重载时复用（避免 EADDRINUSE）。
  // 因此请求处理闭包里所有配置读取都必须走 wm（state），绝不能读模块运行期局部变量，
  // 否则重载后 token 校验仍用的是旧配置。
  const wm = state.webManager || (state.webManager = {
    server: null,
    routes: new Map(),
    html: null,
    auth: null,
    terminal: [],  // 终端消息缓冲区（chat/whisper/系统事件）
    hookedBot: null, // 已挂接事件的 bot 实例（重连后对新 bot 重新挂接）
  });
  wm.auth = { host: cfg.host, port: cfg.port, token: cfg.token || '' };

  // 每次运行重新读取页面文件，UI 修改后重载插件即可生效
  try {
    wm.html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  } catch (err) {
    wm.html = '<h1>index.html 缺失</h1><p>请检查 plugins/web-manager/public/ 目录。</p>';
  }

  // ---- 辅助函数 ----
  const sendJSON = (res, status, obj) => {
    try {
      const body = JSON.stringify(obj);
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
    } catch (err) {
      // socket 可能已关闭（如请求体过大被销毁时）
    }
  };

  const readBody = (req, limit = 1024 * 1024) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  const getAuthToken = (req, url) => {
    const h = req.headers.authorization;
    if (h && h.startsWith('Bearer ')) return h.slice(7);
    return url.searchParams.get('token') || null;
  };

  const authOk = (req, url) => {
    if (!wm.auth.token) return true;
    return getAuthToken(req, url) === wm.auth.token;
  };

  // 扫描 plugins 目录下所有含 index.js 的插件目录
  const scanPlugins = () => {
    if (!fs.existsSync(pluginsDir)) return [];
    return fs.readdirSync(pluginsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && fs.existsSync(path.join(pluginsDir, d.name, 'index.js')))
      .map(d => d.name);
  };

  // 通过 require.cache 判断插件是否已加载
  const pluginLoaded = (name) => {
    try {
      return !!require.cache[require.resolve(path.join(pluginsDir, name, 'index.js'))];
    } catch (err) {
      return false;
    }
  };

  // ---- 重载逻辑（与 main.js 加载器保持一致）----
  const reloadPlugin = (name) => {
    const indexFile = path.join(pluginsDir, name, 'index.js');
    const configFile = path.join(pluginsDir, name, 'config.json');
    if (!fs.existsSync(indexFile)) throw new Error(`插件 '${name}' 不存在或无 index.js`);

    // 清理旧磁贴与端点，避免残留
    webManager._clearForPlugin(name);
    // 连同插件目录下的子模块缓存一起清除（如 piano 的 player.js/nbs.js），
    // 否则 index.js 重载后 require('./player') 拿到的还是旧模块，代码修改不生效
    const dirPrefix = path.resolve(pluginsDir, name) + path.sep;
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(dirPrefix)) delete require.cache[key];
    }
    delete require.cache[require.resolve(indexFile)];

    let pluginConfig = {};
    if (fs.existsSync(configFile)) pluginConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));

    const plugin = require(indexFile);
    if (typeof plugin !== 'function') throw new Error(`插件 '${name}' 未导出函数`);
    plugin({ ...context, pluginConfig, pluginName: name });
    return { name, ok: true };
  };

  // ---- 终端（模拟聊天框）数据源 ----
  const logTerminal = (dir, type, user, msg) => {
    wm.terminal.push({ t: Date.now(), dir, type, user, msg: String(msg) });
    if (wm.terminal.length > 500) wm.terminal.splice(0, wm.terminal.length - 500);
  };

  // 只对同一 bot 实例挂载一次：包装 bot.chat/bot.whisper 记录发出的消息，
  // 监听 chat/whisper 事件记录收到的消息（机器人自己的消息走钩子，跳过回声）。
  // 自动重连重建 bot 后（新实例）会重新挂接。
  if (wm.hookedBot !== bot) {
    wm.hookedBot = bot;

    // ⚠️ 此 mineflayer fork 的插件在连接握手后异步注入（inject_allowed 事件），
    // 插件加载时 bot.chat/bot.whisper 尚未定义，必须等注入完成后再包装。
    const installHooks = () => {
      const origChat = bot.chat.bind(bot);
      bot.chat = (message) => {
        logTerminal('out', 'chat', bot.username || 'Bot', message);
        return origChat(message);
      };

      const origWhisper = bot.whisper.bind(bot);
      bot.whisper = (username, message) => {
        logTerminal('out', 'whisper', username, message);
        return origWhisper(username, message);
      };
    };

    if (typeof bot.chat === 'function') {
      installHooks(); // 兜底：若已注入则立即包装
    } else {
      // 注入完成后再包装（此时 mineflayer 聊天插件已定义 bot.chat/bot.whisper）
      bot.once('inject_allowed', installHooks);
    }

    // 接收消息：优先解析 minecraft-protocol 重发的 playerChat 事件（chatType 编号 +
    // 发送者 UUID + 明文，服务器聊天格式插件改不了这些协议字段，能稳定拿到发送者
    // 真实用户名与消息类型）。
    // 兜底走 message 事件按翻译 key 分类（无 player_chat 的环境，如旧协议/mock）。
    const { createChatResolver, createWhisperDetector, nbtComponentToText, reasonToText, parseSystemWhisper } = require('../../message-utils');
    const chatResolver = createChatResolver(bot);
    const hasPacketPath = !!(bot._client && chatResolver && chatResolver.packet);
    if (hasPacketPath) {
      bot._client.on('playerChat', (data) => {
        const info = chatResolver.packet(data);
        if (!info) return;
        if (info.sender === bot.username) return; // 机器人自己的消息回声（已由 out 钩子记录）
        logTerminal('in', info.type === 'whisper' ? 'whisper' : (info.type === 'system' ? 'system' : 'chat'), info.sender, info.content);
      });
      // 系统消息走 systemChat 事件（minecraft-protocol 重发为 formattedMessage/positionId，
      // 原始包字段为 content/isActionBar，兼容两者；nbtComponentToText 可同时处理
      // NBT 组件、JSON 字符串与普通字符串）
      bot._client.on('systemChat', (data) => {
        if (data.isActionBar === true || data.positionId === 2) return; // 动作栏消息，跳过
        const raw = data.formattedMessage != null ? data.formattedMessage : data.content;
        let text = nbtComponentToText(raw);
        if (!text) {
          try { text = typeof raw === 'string' ? raw : JSON.stringify(raw); }
          catch (err) { text = String(raw || ''); }
        }
        // 私信渲染成 '[发送者 -> 我] 内容' → 终端里归类为私信
        const w = parseSystemWhisper(text);
        if (w) {
          if (w.sender === bot.username) return; // 机器人自己的私信回声（out 钩子已记录）
          logTerminal('in', 'whisper', w.sender, w.content);
        } else {
          logTerminal('in', 'system', '', text);
        }
      });
    } else {
      const detectWhisper = createWhisperDetector(bot);
      bot.on('message', (msg, position) => {
        if (position === 'game_info') return; // 动作栏消息，跳过
        if (position === 'system' || (msg && msg.translate === 'chat.type.announcement')) {
          // 服务器系统消息 / 公告（控制台 /say 等）
          logTerminal('in', 'system', '', msg ? msg.toString() : String(msg));
          return;
        }
        const info = detectWhisper(msg);
        if (info) {
          if (info.sender === bot.username) return; // 机器人自己的私信回声（out 钩子已记录）
          logTerminal('in', 'whisper', info.sender, info.content);
          return;
        }
        const withs = (msg && msg.with) || [];
        const sender = withs[0] ? withs[0].toString() : null;
        if (sender === bot.username) return; // 机器人自己的消息回声（已由 out 钩子记录）
        const content = withs[1] ? withs[1].toString() : (msg ? msg.toString() : '');
        logTerminal('in', 'chat', sender || '未知玩家', content);
      });
    }

    bot.on('login', () => logTerminal('system', 'system', '', `机器人 ${bot.username} 已登录。`));
    bot.on('spawn', () => logTerminal('system', 'system', '', '已进入世界。'));
    bot.on('kicked', (reason) => logTerminal('system', 'system', '', `被踢出服务器: ${reasonToText(reason)}`));
    bot.on('end', (reason) => logTerminal('system', 'system', '', `连接已断开: ${reasonToText(reason)}`));
  }

  // ---- 内置路由 ----
  const addRoute = (method, pattern, handler) => wm.routes.set(`${method} ${pattern}`, { pattern, handler });

  addRoute('GET', '/', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(wm.html);
  });

  addRoute('GET', '/api/status', (req, res) => {
    const pos = bot.entity && bot.entity.position
      ? {
          x: Math.round(bot.entity.position.x),
          y: Math.round(bot.entity.position.y),
          z: Math.round(bot.entity.position.z),
        }
      : null;
    sendJSON(res, 200, {
      bot: {
        username: bot.username || null,
        connected: !!(bot._client && !bot._client.destroyed && bot._client.state === 'play'),
        spawned: !!bot.entity,
        health: bot.health ?? null,
        hunger: bot.food ?? null,
        position: pos,
      },
      pm2: !!process.env.PM2_HOME,
      uptime: Math.round(process.uptime()),
    });
  });

  addRoute('GET', '/api/plugins', (req, res) => {
    const names = new Set([...(config.plugins || []), ...scanPlugins()]);
    const plugins = Array.from(names).map(name => {
      const tile = webManager.tiles.get(name);
      // 端点信息：path 全路径，label 为磁贴按钮文字（未设置时前端显示「📡 调用接口」），
      // dropdown 为 {source, param} —— 前端先从 source 拉选项，选中值作为 ?param= 拼上。
      // 带 panel 的插件：面板就是控制界面，磁贴上不再把每个 API 端点渲染成「调用接口」按钮。
      const endpoints = tile && tile.panel ? [] : webManager._endpointsFor(name).map(ep => ({
        path: ep.path,
        label: ep.label,
        dropdown: ep.dropdown,
      }));
      const panel = tile && tile.panel;
      return {
        name,
        loaded: pluginLoaded(name),
        hasConfig: fs.existsSync(path.join(pluginsDir, name, 'config.json')),
        customTile: tile ? { title: tile.title, description: tile.description, panel, endpoints: endpoints.filter(ep => ep.path !== panel) } : null,
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
    sendJSON(res, 200, { plugins });
  });

  addRoute('GET', '/api/plugins/:name/config', (req, res, params) => {
    const { name } = params;
    const f = path.join(pluginsDir, name, 'config.json');
    if (!fs.existsSync(f)) return sendJSON(res, 404, { error: `插件 '${name}' 无配置文件` });
    try {
      sendJSON(res, 200, { name, hasConfig: true, config: JSON.parse(fs.readFileSync(f, 'utf8')) });
    } catch (err) {
      sendJSON(res, 500, { error: `解析配置失败: ${err.message}` });
    }
  });

  addRoute('PUT', '/api/plugins/:name/config', async (req, res, params, body) => {
    const { name } = params;
    const f = path.join(pluginsDir, name, 'config.json');
    if (!fs.existsSync(f)) return sendJSON(res, 404, { error: `插件 '${name}' 无配置文件` });

    let obj;
    try {
      obj = JSON.parse(body || 'null');
    } catch (err) {
      return sendJSON(res, 400, { error: `无效的 JSON: ${err.message}` });
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      return sendJSON(res, 400, { error: '配置必须是 JSON 对象' });
    }

    try {
      fs.writeFileSync(f, JSON.stringify(obj, null, 2));
      console.log(`[web-manager] 已保存插件 '${name}' 的配置（重载后生效）。`);
      sendJSON(res, 200, { ok: true, path: f });
    } catch (err) {
      sendJSON(res, 500, { error: `保存配置失败: ${err.message}` });
    }
  });

  addRoute('POST', '/api/plugins/:name/reload', (req, res, params) => {
    const { name } = params;
    try {
      reloadPlugin(name);
      console.log(`[web-manager] 插件 '${name}' 已重载。`);
      sendJSON(res, 200, { ok: true, message: `插件 '${name}' 已重载` });
    } catch (err) {
      console.error(`[web-manager] 重载插件 '${name}' 失败:`, err);
      sendJSON(res, 500, { ok: false, error: err.message });
    }
  });

  addRoute('POST', '/api/reload-all', (req, res) => {
    const results = {};
    for (const name of config.plugins || []) {
      try {
        reloadPlugin(name);
        results[name] = { ok: true };
      } catch (err) {
        console.error(`[web-manager] 重载插件 '${name}' 失败:`, err);
        results[name] = { ok: false, error: err.message };
      }
    }
    sendJSON(res, 200, { ok: true, results });
  });

  addRoute('GET', '/api/permissions', (req, res) => sendJSON(res, 200, permissions.permissions));

  addRoute('PUT', '/api/permissions', (req, res, params, body) => {
    let obj;
    try {
      obj = JSON.parse(body || 'null');
    } catch (err) {
      return sendJSON(res, 400, { error: `无效的 JSON: ${err.message}` });
    }
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.admins) || typeof obj.users !== 'object') {
      return sendJSON(res, 400, { error: '权限格式错误：需要 {"admins": string[], "users": {name: {level: number}}}' });
    }
    if (obj.admins.some(a => typeof a !== 'string')) return sendJSON(res, 400, { error: 'admins 必须是字符串数组' });
    for (const [name, v] of Object.entries(obj.users)) {
      if (!v || typeof v.level !== 'number') return sendJSON(res, 400, { error: `用户 '${name}' 的 level 必须是数字` });
    }

    permissions.permissions = obj;
    if (!permissions.save()) return sendJSON(res, 500, { error: '保存权限文件失败' });
    sendJSON(res, 200, { ok: true });
  });

  addRoute('GET', '/api/terminal/messages', (req, res) => {
    sendJSON(res, 200, { messages: wm.terminal.slice(-200) });
  });

  addRoute('POST', '/api/terminal/send', (req, res, params, body) => {
    let obj;
    try {
      obj = JSON.parse(body || 'null');
    } catch (err) {
      return sendJSON(res, 400, { error: `无效的 JSON: ${err.message}` });
    }
    const message = obj && typeof obj.message === 'string' ? obj.message.trim() : '';
    if (!message) return sendJSON(res, 400, { error: '消息不能为空' });
    if (message.length > 256) return sendJSON(res, 400, { error: '消息过长（最多 256 字符）' });
    bot.chat(message);
    sendJSON(res, 200, { ok: true });
  });

  addRoute('POST', '/api/terminal/clear', (req, res) => {
    wm.terminal.length = 0;
    sendJSON(res, 200, { ok: true });
  });

  // ---- 背包管理（网页 UI + 聊天指令）----
  // 玩家背包窗口槽位布局（与 mineflayer bot.inventory.slots 一致，QUICK_BAR_START=36）：
  // 0=合成输出, 1-4=合成网格, 5-8=盔甲(头胸腿脚), 9-35=主背包, 36-44=快捷栏, 45=副手
  // 重命名物品的自定义名:1.21 存于 custom_name 组件,旧版存 nbt display.Name,
  // 且 displayName 只是构造时的基础名,自定义名只能从 item.customName 读取。
  // 可能形态: JSON 文本组件字符串 / 已解析对象 / 纯字符串(旧版),统一转纯文本。
  const textComponentToText = (comp) => {
    if (typeof comp === 'string') return comp;
    if (Array.isArray(comp)) return comp.map(textComponentToText).join('');
    if (comp && typeof comp === 'object') {
      if (typeof comp.text === 'string') return comp.text;
      if (typeof comp.translate === 'string') return comp.translate;
      if (Array.isArray(comp.extra)) return comp.extra.map(textComponentToText).join('');
    }
    return '';
  };
  const customItemName = (item) => {
    try {
      const raw = item && item.customName;
      if (raw === null || raw === undefined || raw === '') return null;
      // prismarine-nbt 包装对象 { type:'string', value:'{"text":"..."}' }（1.21 anonymousNbt 解析结果）
      const src = (raw && typeof raw === 'object' && typeof raw.value === 'string') ? raw.value : raw;
      let text;
      if (typeof src === 'string') {
        const t = src.trim();
        text = (t.startsWith('{') || t.startsWith('[')) ? textComponentToText(JSON.parse(t)) : t;
      } else {
        text = textComponentToText(src);
      }
      return text.replace(/§./g, '') || null;
    } catch (err) { return null; }
  };
  const itemLabel = (item) => customItemName(item) || item.displayName || item.name;

  // 装备栏(槽 5-8:头/胸/腿/脚)原版规则:只接受对应部位的装备
  const armorSlotMatches = (item, to) => {
    if (to < 5 || to > 8) return true;
    if (!item) return true;
    const n = item.name || '';
    const head = n.endsWith('_helmet') ||
      ['carved_pumpkin', 'player_head', 'zombie_head', 'skeleton_skull', 'wither_skeleton_skull', 'creeper_head', 'dragon_head', 'piglin_head'].includes(n);
    const chest = n.endsWith('_chestplate') || n === 'elytra';
    const legs = n.endsWith('_leggings');
    const feet = n.endsWith('_boots');
    return [head, chest, legs, feet][to - 5] === true;
  };

  const itemInfo = (item) => item ? (() => {
    const isBlock = !!(bot.registry && bot.registry.blocksByName && bot.registry.blocksByName[item.name]);
    const tex = resolveTex(item.name);
    return {
      slot: item.slot,
      name: item.name,
      displayName: item.displayName,
      customName: customItemName(item),
      count: item.count,
      maxStackSize: item.stackSize,
      enchanted: !!(item.enchants && item.enchants.length),
      block: isBlock, // 方块纹理在 block/ 目录
      texDir: tex ? tex.dir : null,   // 纹理目录: block / item / entity/<子目录>(已验证存在)
      texName: tex ? tex.file : null, // 纹理文件名(不含 .png), null 时前端用 item.name
    };
  })() : null;

  const invAvailable = () => !!(bot.inventory && bot.inventory.slots);

  // 槽位编号按玩家窗口布局；若正打开着其他容器（如箱子），先关闭，否则点击会落到容器窗口的槽位上
  const ensurePlayerWindow = () => {
    if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
  };

  addRoute('GET', '/api/inventory', (req, res) => {
    if (!invAvailable()) return sendJSON(res, 200, { available: false });
    sendJSON(res, 200, {
      available: true,
      quickBarSlot: bot.quickBarSlot || 0,
      gameMode: bot.game && bot.game.gameMode,
      slots: Array.from({ length: 46 }, (_, i) => itemInfo(bot.inventory.slots[i])),
    });
  });

  addRoute('POST', '/api/inventory/drop', async (req, res, params, body) => {
    let obj;
    try { obj = JSON.parse(body || 'null'); } catch (err) { return sendJSON(res, 400, { error: '无效的 JSON' }); }
    const slot = obj && obj.slot;
    if (!Number.isInteger(slot) || slot < 5 || slot > 45) {
      return sendJSON(res, 400, { error: '无效的槽位（仅支持 5-45）' });
    }
    if (!invAvailable()) return sendJSON(res, 400, { error: '背包尚未同步（未登录？）' });
    if (bot.game && bot.game.gameMode === 'creative') return sendJSON(res, 400, { error: '创造模式无法丢出物品' });
    const item = bot.inventory.slots[slot];
    if (!item) return sendJSON(res, 400, { error: '该槽位为空' });
    const count = obj.count;
    const wantAll = count === 'all' || (typeof count === 'number' && count >= item.count);
    const n = Math.floor(Number(count));
    if (!wantAll && !(typeof count === 'number' && n >= 1)) {
      return sendJSON(res, 400, { error: 'count 必须是 1 或 "all"' });
    }
    try {
      ensurePlayerWindow();
      if (wantAll) {
        await bot.tossStack(item);
      } else {
        // 丢指定数量：transfer 支持任意槽位区间（5..46 覆盖盔甲/主背包/快捷栏/副手）
        await bot.transfer({
          window: bot.inventory,
          itemType: item.type,
          metadata: item.metadata,
          count: Math.min(n, item.count),
          sourceStart: 5,
          sourceEnd: 46,
          destStart: -999,
        });
      }
      sendJSON(res, 200, { ok: true, dropped: { name: itemLabel(item), count: wantAll ? item.count : Math.min(n, item.count) } });
    } catch (err) {
      sendJSON(res, 500, { error: `丢出失败: ${err.message}` });
    }
  });

  addRoute('POST', '/api/inventory/select', (req, res, params, body) => {
    let obj;
    try { obj = JSON.parse(body || 'null'); } catch (err) { return sendJSON(res, 400, { error: '无效的 JSON' }); }
    const slot = obj && obj.slot;
    if (!Number.isInteger(slot) || slot < 0 || slot > 8) return sendJSON(res, 400, { error: '快捷栏槽位必须是 0-8' });
    try {
      bot.setQuickBarSlot(slot);
      sendJSON(res, 200, { ok: true, quickBarSlot: slot });
    } catch (err) {
      sendJSON(res, 500, { error: `切换失败: ${err.message}` });
    }
  });

  addRoute('POST', '/api/inventory/move', async (req, res, params, body) => {
    let obj;
    try { obj = JSON.parse(body || 'null'); } catch (err) { return sendJSON(res, 400, { error: '无效的 JSON' }); }
    const from = obj && obj.from, to = obj && obj.to;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 5 || from > 45 || to < 5 || to > 45) {
      return sendJSON(res, 400, { error: '无效的槽位（仅支持 5-45）' });
    }
    if (from === to) return sendJSON(res, 400, { error: '不能移动到同一槽位' });
    if (!invAvailable()) return sendJSON(res, 400, { error: '背包尚未同步（未登录？）' });
    if (bot.game && bot.game.gameMode === 'creative') return sendJSON(res, 400, { error: '创造模式无法移动物品' });
    const src = bot.inventory.slots[from];
    if (!src) return sendJSON(res, 400, { error: '源槽位为空' });
    if (!armorSlotMatches(src, to)) return sendJSON(res, 400, { error: '装备栏只能放入对应部位的装备' });
    const dst = bot.inventory.slots[to];
    const sameStack = !!dst && dst.type === src.type && dst.metadata === src.metadata &&
      JSON.stringify(dst.nbt || null) === JSON.stringify(src.nbt || null) &&
      customItemName(dst) === customItemName(src);
    try {
      ensurePlayerWindow();
      if (!dst) {
        // 目标为空:整组移动
        await bot.transfer({
          window: bot.inventory, itemType: src.type, metadata: src.metadata,
          count: src.count, sourceStart: from, sourceEnd: from + 1, destStart: to, destEnd: to + 1,
        });
      } else if (sameStack && dst.count < dst.stackSize) {
        // 同类可叠:移入 min(数量, 空位),多余放回源槽
        await bot.transfer({
          window: bot.inventory, itemType: src.type, metadata: src.metadata,
          count: Math.min(src.count, dst.stackSize - dst.count),
          sourceStart: from, sourceEnd: from + 1, destStart: to, destEnd: to + 1,
        });
      } else if (sameStack) {
        return sendJSON(res, 400, { error: '目标槽位已满' });
      } else {
        // 不同类型:三连击互换(结束时光标为空)
        await bot.clickWindow(from, 0, 0);
        await bot.clickWindow(to, 0, 0);
        await bot.clickWindow(from, 0, 0);
      }
      sendJSON(res, 200, { ok: true });
    } catch (err) {
      sendJSON(res, 500, { error: `移动失败: ${err.message}` });
    }
  });

  // 聊天指令: !drop 丢出当前手持物品, !cginv <1-9> 切换快捷栏
  if (commands) {
    commands.register({
      name: 'drop',
      permissionLevel: 1,
      description: '丢出当前手持物品',
      execute: (username) => {
        if (!invAvailable()) return bot.whisper(username, '> 背包尚未同步（未登录？）');
        if (bot.game && bot.game.gameMode === 'creative') return bot.whisper(username, '> 创造模式无法丢出物品。');
        const item = bot.inventory.slots[36 + (bot.quickBarSlot || 0)];
        if (!item) return bot.whisper(username, '> 当前没有手持物品。');
        bot.tossStack(item)
          .then(() => bot.whisper(username, `> 已丢出 ${itemLabel(item)} × ${item.count}。`))
          .catch((err) => bot.whisper(username, `> 丢出失败: ${err.message}`));
      },
    });
    commands.register({
      name: 'cginv',
      permissionLevel: 1,
      description: '切换快捷栏: !cginv <1-9>（1-9 对应第 1-9 格,0 为第 1 格）',
      execute: (username, args) => {
        const n = parseInt(args[0], 10);
        if (isNaN(n) || n < 0 || n > 9) return bot.whisper(username, '> 用法: !cginv <1-9>');
        const slot = n === 0 ? 0 : n - 1;
        try {
          bot.setQuickBarSlot(slot);
        } catch (err) {
          return bot.whisper(username, `> 切换失败: ${err.message}`);
        }
        const item = bot.inventory && bot.inventory.slots[36 + slot];
        bot.whisper(username, `> 已切换到快捷栏第 ${slot + 1} 格${item ? `: ${itemLabel(item)} × ${item.count}` : '（空）'}`);
      },
    });
  }

  addRoute('POST', '/api/restart', (req, res) => {
    sendJSON(res, 200, { ok: true, message: '机器人正在重启...' });
    setTimeout(() => {
      console.log('[web-manager] 收到重启指令，进程即将退出（需进程管理器自动拉起）。');
      process.exit(0);
    }, 300);
  });

  // ---- 路由匹配（支持 :name 动态段）----
  const matchRoute = (method, pathname) => {
    for (const [key, { handler }] of wm.routes) {
      const [pMethod, pPath] = key.split(' ');
      if (pMethod !== method) continue;
      const pSegs = pPath.split('/').filter(Boolean);
      const uSegs = pathname.split('/').filter(Boolean);
      if (pSegs.length !== uSegs.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < pSegs.length; i++) {
        if (pSegs[i].startsWith(':')) params[pSegs[i].slice(1)] = decodeURIComponent(uSegs[i]);
        else if (pSegs[i] !== uSegs[i]) { ok = false; break; }
      }
      if (ok) return { handler, params };
    }
    return null;
  };

  // ---- 请求入口 ----
  const handleRequest = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    try {
      if (pathname.startsWith('/api/')) {
        // 所有 /api/* 均需认证（未配置 token 时放行）
        if (!authOk(req, url)) return sendJSON(res, 401, { error: '未授权：需要正确的 token' });

        // 解析请求体（PUT/POST）
        let body;
        if (req.method === 'PUT' || req.method === 'POST') {
          try {
            body = await readBody(req);
          } catch (err) {
            return sendJSON(res, 400, { error: err.message });
          }
        }

        // 内置路由（含动态段）
        const m = matchRoute(req.method, pathname);
        if (m) return await m.handler(req, res, m.params, body, url);

        // 插件注册的自定义端点（精确匹配）
        const ep = webManager.endpoints.get(`${req.method} ${pathname}`);
        if (ep) return await ep.handler(req, res, url, body);

        return sendJSON(res, 404, { error: '接口不存在' });
      }

      // 静态页面（GET /）
      const page = matchRoute('GET', pathname);
      if (page) return await page.handler(req, res, page.params, null, url);
      return sendJSON(res, 404, { error: 'Not Found' });
    } catch (err) {
      console.error('[web-manager] 请求处理错误:', err);
      sendJSON(res, 500, { error: err.message });
    }
  };

  // ---- HTTP 服务器（仅首次运行时创建，重载复用）----
  if (!wm.server) {
    wm.server = http.createServer(handleRequest);
    // 必须处理 error，否则端口被占用时进程直接崩溃
    wm.server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[web-manager] 端口 ${wm.auth.port} 已被占用，Web 管理界面不可用。请修改 config.json 后重启机器人。`);
      } else {
        console.error('[web-manager] HTTP 服务器错误:', err);
      }
    });
    wm.server.listen(cfg.port, cfg.host, () => {
      console.log(`[web-manager] 管理界面已启动: http://${cfg.host}:${cfg.port} (token: ${wm.auth.token ? '已设置' : '未设置'})`);
    });
  }

  // ---- 自注册磁贴 ----
  webManager.registerTile({
    name: 'web-manager',
    title: 'Web 管理器',
    description: 'HTTP 管理界面与插件接入接口',
  });

  console.log(`[web-manager] 插件已加载 (host=${cfg.host}, port=${cfg.port}, token: ${cfg.token ? '已设置' : '未设置'})`);
};
