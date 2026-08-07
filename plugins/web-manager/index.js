// plugins/web-manager/index.js
// Web 管理插件：零依赖 HTTP 服务 + 插件磁贴/重载/配置/权限管理 + 插件接入接口
const http = require('http');
const fs = require('fs');
const path = require('path');

module.exports = (context) => {
  const { bot, config, state, permissions, pluginConfig, webManager } = context;

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
    hooked: false, // bot.chat/bot.whisper 包装与事件监听只挂载一次
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

  // 只在首次运行时挂载：包装 bot.chat/bot.whisper 记录发出的消息，
  // 监听 chat/whisper 事件记录收到的消息（机器人自己的消息走钩子，跳过回声）
  if (!wm.hooked) {
    wm.hooked = true;

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

    // 接收消息：统一走底层 message 事件（公屏/私信/服务器系统消息全覆盖）。
    // 按 chat type 分类，不依赖翻译字符串格式；旧版监听 'chat'/'whisper' 模式事件
    // 会漏掉 systemChat 数据包（服务器系统消息），导致终端看不到服务器发来的消息。
    const detectWhisper = require('../../message-utils').createWhisperDetector(bot);
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

    bot.on('login', () => logTerminal('system', 'system', '', `机器人 ${bot.username} 已登录。`));
    bot.on('spawn', () => logTerminal('system', 'system', '', '已进入世界。'));
    bot.on('kicked', (reason) => logTerminal('system', 'system', '', `被踢出服务器: ${reason}`));
    bot.on('end', (reason) => logTerminal('system', 'system', '', `连接已断开: ${reason}`));
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
      const endpoints = webManager._endpointsFor(name).map(ep => ({
        path: ep.path,
        label: ep.label,
        dropdown: ep.dropdown,
      }));
      return {
        name,
        loaded: pluginLoaded(name),
        hasConfig: fs.existsSync(path.join(pluginsDir, name, 'config.json')),
        customTile: tile ? { title: tile.title, description: tile.description, endpoints } : null,
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
