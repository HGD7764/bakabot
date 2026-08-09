// main.js (新版本)

const mineflayer = require('mineflayer');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { CommandManager } = require('./command-manager');
const { reasonToText } = require('./message-utils');
const logger = require('./logger');

class PermissionManager {
  constructor(filePath) {
    this.filePath = filePath;
    this.permissions = { admins: [], users: {} };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, 'utf8');
        this.permissions = JSON.parse(data);
        console.log('[PermissionManager] 权限文件已加载。');
      } else {
        console.warn('[PermissionManager] 警告: permissions.json 未找到，将使用默认空配置。');
        // 可选：在此处创建默认文件
        // fs.writeFileSync(this.filePath, JSON.stringify(this.permissions, null, 2));
      }
    } catch (err) {
      console.error('[PermissionManager] 加载权限文件时出错:', err);
    }
  }

  /**
   * 获取玩家的权限等级
   * @param {string} username - 玩家名
   * @returns {number} 权限等级 (0: Guest, 1: User, 99: Admin)
   */
  getLevel(username) {
    if (this.permissions.admins.includes(username)) {
      return 99; // Admin level
    }
    if (this.permissions.users[username]) {
      return this.permissions.users[username].level || 1; // User level
    }
    return 0; // Guest level
  }

  /**
   * 将当前权限保存到文件（供网页管理端调用）
   * @returns {boolean} 是否保存成功
   */
  save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.permissions, null, 2));
      console.log('[PermissionManager] 权限文件已保存。');
      return true;
    } catch (err) {
      console.error('[PermissionManager] 保存权限文件时出错:', err);
      return false;
    }
  }
}

// --- 1. 加载配置 ---
const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));

// --- 1.5 初始化日志模块（拦截全部 console 输出 + 记录 bot 事件/消息/指令） ---
logger.init(config.logging || {});

// --- 2. 创建共享上下文 (Context) ---
const context = {
  bot: null,
  config: config,
  eventBus: new EventEmitter(),
  state: {},
  commands: null, // 将在这里挂载命令管理器
};
context.permissions = new PermissionManager(path.join(__dirname, 'permissions.json'));

const configPath = path.join(__dirname, 'config.json');
let bot = null;
const botLifecycle = {
  loading: false,
  pendingReconnect: null,
  manualDisconnect: false,
  currentBot: null,
};

// --- 新增: 预创建 Web 管理注册表 ---
// 在插件加载前创建，保证任何插件（无论加载顺序）都能通过 context.webManager
// 注册自己的磁贴和自定义 API 端点；web-manager 插件启动后统一挂载。
context.webManager = {
  tiles: new Map(),       // name -> {name, title, description, endpoints}
  endpoints: new Map(),   // 'METHOD /path' -> {method, path, handler, pluginName}

  registerTile({ name, title = name, description = '', panel = null, endpoints = {} }) {
    if (typeof name !== 'string' || !name) throw new Error('registerTile: name 必须是非空字符串');
    if (typeof endpoints !== 'object' || endpoints === null) throw new Error('registerTile: endpoints 必须是对象');
    // 立即挂载磁贴端点：GET /api/plugins/<name>/<rel>，与加载顺序无关。
    // 端点值支持两种写法：直接给 handler 函数，或 { handler, label, dropdown } 对象
    // （label = 磁贴上按钮的显示文字；dropdown = 调用前先选一个值的下拉框，网页端
    //   自动从 dropdown.source 拉取选项，选中的值作为 ?<param>=<value> 拼到请求上）。
    for (const [rel, spec] of Object.entries(endpoints)) {
      const full = `/api/plugins/${name}${rel.startsWith('/') ? rel : '/' + rel}`;
      const handler = typeof spec === 'function' ? spec : (spec && spec.handler);
      if (typeof handler !== 'function') throw new Error(`registerTile: 端点 '${rel}' 必须是函数或 { handler, label, dropdown } 对象`);
      this.registerEndpoint('GET', full, handler, name, {
        label: (typeof spec === 'object' && spec && spec.label) || null,
        dropdown: (typeof spec === 'object' && spec && spec.dropdown) || null,
      });
    }
    if (panel !== null && (typeof panel !== 'string' || !panel.startsWith('/api/'))) {
      throw new Error('registerTile: panel 必须以 /api/ 开头的绝对路径');
    }
    this.tiles.set(name, { name, title, description, panel });
  },

  registerEndpoint(method, path, handler, pluginName = '', meta = {}) {
    method = String(method).toUpperCase();
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) throw new Error(`registerEndpoint: 不支持的方法 ${method}`);
    if (typeof path !== 'string' || !path.startsWith('/api/')) throw new Error('registerEndpoint: path 必须以 /api/ 开头');
    if (typeof handler !== 'function') throw new Error('registerEndpoint: handler 必须是函数');
    this.endpoints.set(`${method} ${path}`, { method, path, handler, pluginName, label: meta.label || null, dropdown: meta.dropdown || null });
  },

  // 内部使用：重载插件前清理该插件的旧磁贴与端点
  _clearForPlugin(pluginName) {
    for (const [key, ep] of this.endpoints) {
      if (ep.pluginName === pluginName) this.endpoints.delete(key);
    }
    this.tiles.delete(pluginName);
  },

  // 内部使用：返回某插件注册的端点列表
  _endpointsFor(pluginName) {
    return Array.from(this.endpoints.values()).filter(ep => ep.pluginName === pluginName);
  },
};

const pluginsDir = path.join(__dirname, 'plugins');

const clearPluginCache = (pluginName) => {
  const dirPrefix = path.resolve(pluginsDir, pluginName) + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(dirPrefix)) delete require.cache[key];
  }
};

const loadPlugin = (currentBot, pluginName) => {
  const pluginDir = path.join(pluginsDir, pluginName);
  const pluginIndexFile = path.join(pluginDir, 'index.js');
  const pluginConfigFile = path.join(pluginDir, 'config.json');

  if (!fs.existsSync(pluginIndexFile)) {
    logger.error('plugin', `找不到插件目录或 index.js: ${pluginName}`);
    console.error(`[PluginLoader] 错误: 找不到插件目录或 index.js: ${pluginName}`);
    return;
  }

  try {
    let pluginConfig = {};
    if (fs.existsSync(pluginConfigFile)) {
      try {
        pluginConfig = JSON.parse(fs.readFileSync(pluginConfigFile, 'utf8'));
        console.log(`[PluginLoader] 已为插件 '${pluginName}' 加载配置文件。`);
      } catch (configErr) {
        logger.error('plugin', `解析插件 '${pluginName}' 的 config.json 时出错: ${configErr.stack || configErr}`);
        console.error(`[PluginLoader] 解析插件 '${pluginName}' 的 config.json 时出错:`, configErr);
      }
    }

    clearPluginCache(pluginName);
    delete require.cache[require.resolve(pluginIndexFile)];

    const pluginContext = {
      ...context,
      bot: currentBot,
      pluginConfig,
      pluginName,
    };

    const plugin = require(pluginIndexFile);
    if (typeof plugin === 'function') {
      plugin(pluginContext);
      logger.info('plugin', `已成功加载插件: ${pluginName}`);
      console.log(`[PluginLoader] 已成功加载插件: ${pluginName}`);
    } else {
      logger.warn('plugin', `插件 '${pluginName}' 未导出函数，已跳过。`);
      console.warn(`[PluginLoader] 警告: 插件 '${pluginName}' 未导出函数，已跳过。`);
    }
  } catch (err) {
    logger.error('plugin', `加载插件 ${pluginName} 时发生错误: ${err.stack || err}`);
    console.error(`[PluginLoader] 加载插件 ${pluginName} 时发生错误:`, err);
  }
};

const loadPluginsForBot = (currentBot) => {
  console.log('正在加载插件...');
  if (config.plugins && Array.isArray(config.plugins)) {
    config.plugins.forEach((pluginName) => loadPlugin(currentBot, pluginName));
  } else {
    console.log('[PluginLoader] 配置文件中没有找到插件列表，不加载任何插件。');
  }
  console.log('所有插件加载完毕。');
};

const wireBot = (currentBot) => {
  // 修复 1.21.11 协议 bug：minecraft-data 把 chat_command_signed 的 checksum 标成 i8
  // （-128..127），但 minecraft-protocol 计算的校验值是 0-255（如 136），写包抛
  // RangeError → 连接损坏 → 服务器以 "An internal error occurred" 踢出（/tpa 等指令
  // 必触发）。真实线上字段就是一个字节，转成有符号字节后线上字节完全不变。
  {
    const origWrite = currentBot._client.write.bind(currentBot._client);
    currentBot._client.write = (name, params) => {
      if (name === 'chat_command_signed' && params && typeof params.checksum === 'number' && params.checksum > 127) {
        params.checksum -= 256;
      }
      return origWrite(name, params);
    };
  }

  logger.installBotHooks(currentBot);

  const commandTrigger = config.commandTrigger === 'chat' ? 'chat' : 'whisper';
  context.commands = new CommandManager(currentBot, context.permissions, config.commandPrefix || '!', commandTrigger);

  currentBot.on('login', () => {
    if (bot !== currentBot) return;
    logger.info('bot', `机器人 ${currentBot.username} 已成功登录`);
    console.log(`机器人 ${currentBot.username} 已成功登录！`);
  });

  currentBot.once('spawn', () => {
    if (bot !== currentBot) return;
    logger.info('bot', `机器人已进入世界，框架启动完成`);
    console.log('机器人已进入世界，框架启动完成！');
    context.eventBus.emit('framework:ready');
  });

  currentBot.on('kicked', (reason, loggedIn) => {
    if (bot !== currentBot) return;
    const text = reasonToText(reason);
    logger.error('bot', `被踢出服务器: ${text} (已登录: ${loggedIn})`);
    console.error('机器人被踢出服务器:', text);
  });
  currentBot.on('error', (err) => {
    if (bot !== currentBot) return;
    logger.error('bot', `连接错误: ${err.stack || err}`);
    console.error('机器人发生错误:', err);
  });
  currentBot.on('end', (reason) => {
    if (bot !== currentBot) return;
    const text = reasonToText(reason);
    logger.info('bot', `连接已断开，原因: ${text}`);
    console.log(`机器人连接已断开，原因: ${text}`);
    if (botLifecycle.pendingReconnect) {
      const nextConfig = botLifecycle.pendingReconnect;
      botLifecycle.pendingReconnect = null;
      setTimeout(() => startBotSession(nextConfig), 1000);
    }
  });
};

const startBotSession = (botConfig = config.bot) => {
  if (botLifecycle.loading) return bot;
  botLifecycle.loading = true;
  console.log('正在连接到服务器...');
  try {
    bot = mineflayer.createBot(botConfig);
    botLifecycle.currentBot = bot;
    context.bot = bot;
  } catch (err) {
    botLifecycle.loading = false;
    logger.error('boot', `创建机器人时出错: ${err.stack || err}`);
    console.error('创建机器人时出错:', err);
    process.exit(1);
  }

  wireBot(bot);
  loadPluginsForBot(bot);
  botLifecycle.loading = false;
  return bot;
};

context.botManager = {
  getStatus() {
    const current = botLifecycle.currentBot;
    return {
      loading: botLifecycle.loading,
      connected: !!(current && current._client && !current._client.destroyed && current._client.state === 'play'),
      spawned: !!(current && current.entity),
      username: current ? (current.username || null) : null,
      host: config.bot && config.bot.host ? config.bot.host : null,
      port: config.bot && config.bot.port ? config.bot.port : null,
      pendingReconnect: !!botLifecycle.pendingReconnect,
    };
  },
  disconnect(reason = '手动离线') {
    if (!bot) return { ok: false, error: '机器人未连接' };
    botLifecycle.pendingReconnect = null;
    try {
      if (typeof bot.quit === 'function') bot.quit(reason);
      else if (bot._client && typeof bot._client.end === 'function') bot._client.end(reason);
      else return { ok: false, error: '当前机器人不支持离线' };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },
  connect(newConfig = null) {
    if (bot && !bot._client?.destroyed) return { ok: false, error: '机器人已在线' };
    if (newConfig && typeof newConfig === 'object') {
      config.bot = { ...config.bot, ...newConfig };
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    }
    startBotSession(config.bot);
    return { ok: true };
  },
  reconnect(newConfig = null) {
    if (newConfig && typeof newConfig === 'object') {
      config.bot = { ...config.bot, ...newConfig };
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    }
    botLifecycle.pendingReconnect = { ...config.bot };
    if (!bot) {
      startBotSession(config.bot);
      botLifecycle.pendingReconnect = null;
      return { ok: true };
    }
    this.disconnect('重新连接');
    return { ok: true };
  },
  updateConfig(patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: '配置必须是对象' };
    config.bot = { ...config.bot, ...patch };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    return { ok: true, bot: config.bot };
  },
  getConfig() {
    return config.bot;
  },
};

startBotSession(config.bot);
