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

// --- 3. 创建 Mineflayer Bot 实例（支持自动重连重建） ---
const pluginsDir = path.join(__dirname, 'plugins');

// 清空全部插件的 require 缓存：自动重连重建时让插件以新 bot 重新执行；
// 首次加载时缓存为空，无副作用。
function clearPluginCache() {
  if (!Array.isArray(config.plugins)) return;
  for (const name of config.plugins) {
    const prefix = path.resolve(path.join(pluginsDir, name)) + path.sep;
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(prefix)) delete require.cache[key];
    }
    try { delete require.cache[require.resolve(path.join(pluginsDir, name, 'index.js'))]; } catch (err) { /* 插件目录可能不存在 */ }
  }
}

// 创建 bot 并挂接框架各部件（补丁 → 日志钩子 → 命令管理器 → 插件 → 核心事件）。
// 自动重连时重复调用：旧 bot 已 'end'，新 bot 重新走完整流程。
function startBot() {
console.log('正在连接到服务器...');
try {
  context.bot = mineflayer.createBot(config.bot);
} catch (err) {
  logger.error('boot', `创建机器人时出错: ${err.stack || err}`);
  console.error('创建机器人时出错:', err);
  process.exit(1);
}
const bot = context.bot;

// 修复 1.21.11 协议 bug：minecraft-data 把 chat_command_signed 的 checksum 标成 i8
// （-128..127），但 minecraft-protocol 计算的校验值是 0-255（如 136），写包抛
// RangeError → 连接损坏 → 服务器以 "An internal error occurred" 踢出（/tpa 等指令
// 必触发）。真实线上字段就是一个字节，转成有符号字节后线上字节完全不变。
{
  const origWrite = bot._client.write.bind(bot._client);
  bot._client.write = (name, params) => {
    if (name === 'chat_command_signed' && params && typeof params.checksum === 'number' && params.checksum > 127) {
      params.checksum -= 256; // 0x88(136) 与 0x88(-120) 在线上是同一个字节
    }
    return origWrite(name, params);
  };
}

// 挂接日志钩子：记录所有消息收发（公屏/私信/系统）与可选的包级调试日志
logger.installBotHooks(bot);

// --- 新增: 实例化并挂载命令管理器 ---
// 在 bot 实例化后，插件加载前，创建 CommandManager
// 触发方式由 config.commandTrigger 控制: 'whisper'（私信，默认）/ 'chat'（公屏）
const commandTrigger = config.commandTrigger === 'chat' ? 'chat' : 'whisper';
context.commands = new CommandManager(bot, context.permissions, config.commandPrefix || '!', commandTrigger);

// --- 4. 插件加载器 (新版本) ---
// 自动重连重建时先清缓存，确保插件以新 bot 重新执行
clearPluginCache();
console.log('正在加载插件...');
if (config.plugins && Array.isArray(config.plugins)) {
  config.plugins.forEach(pluginName => {
    const pluginDir = path.join(pluginsDir, pluginName);
    const pluginIndexFile = path.join(pluginDir, 'index.js');
    const pluginConfigFile = path.join(pluginDir, 'config.json');

    if (fs.existsSync(pluginIndexFile)) {
      try {
        // --- 新增：加载插件的独立配置 ---
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

        // 将插件配置添加到传递给插件的上下文中
        const pluginContext = {
          ...context, // 继承主上下文
          pluginConfig: pluginConfig, // 添加插件自己的配置
          pluginName: pluginName // 方便插件知道自己的名字
        };

        const plugin = require(pluginIndexFile);
        if (typeof plugin === 'function') {
          plugin(pluginContext); // 将包含独立配置的上下文注入插件
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
    } else {
      logger.error('plugin', `找不到插件目录或 index.js: ${pluginName}`);
      console.error(`[PluginLoader] 错误: 找不到插件目录或 index.js: ${pluginName}`);
    }
  });
} else {
  console.log('[PluginLoader] 配置文件中没有找到插件列表，不加载任何插件。');
}
console.log('所有插件加载完毕。');


// --- 5. 核心事件监听 ---
bot.on('login', () => {
  logger.info('bot', `机器人 ${bot.username} 已成功登录`);
  console.log(`机器人 ${bot.username} 已成功登录！`);
});

bot.once('spawn', () => {
  logger.info('bot', `机器人已进入世界，框架启动完成`);
  console.log('机器人已进入世界，框架启动完成！');
  context.eventBus.emit('framework:ready');
});

bot.on('kicked', (reason, loggedIn) => {
  const text = reasonToText(reason);
  logger.error('bot', `被踢出服务器: ${text} (已登录: ${loggedIn})`);
  console.error('机器人被踢出服务器:', text);
});
bot.on('error', (err) => {
  logger.error('bot', `连接错误: ${err.stack || err}`);
  console.error('机器人发生错误:', err);
});
bot.on('end', (reason) => {
  const text = reasonToText(reason);
  logger.info('bot', `连接已断开，原因: ${text}`);
  console.log(`机器人连接已断开，原因: ${text}`);
});
} // end startBot()

// 供 auto-reconnect 插件调用的全量重建入口（插件在 bot 'end' 后延迟触发）
context.restartBot = (reason) => {
  logger.info('bot', `自动重连中,原因: ${reasonToText(reason) || '未知'}`);
  console.log('自动重连中...');
  startBot();
};

// 启动框架
startBot();