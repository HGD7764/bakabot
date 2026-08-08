// logger.js
// 全局日志模块：完完整整记录所有日志。
//  - 拦截 console.log/info/warn/error/debug/trace，任何插件/框架的输出都会落盘
//  - 结构化记录 bot 生命周期、消息收发（公屏/私信/系统）、指令执行、崩溃信息
//  - 按天轮转写入 logs/bakabot-YYYY-MM-DD.log，UTF-8 带时间戳
//  - 可选的包级调试日志（config.logging.packets = true）
//
// 用法（main.js 顶部，任何 console 输出之前）：
//   const logger = require('./logger');
//   logger.init(config.logging || {});
//   ...
//   logger.installBotHooks(bot);   // 记录所有消息收发
'use strict';

const fs = require('fs');
const path = require('path');
const util = require('util');

const LEVEL = { DEBUG: 'DEBUG', INFO: 'INFO', WARN: 'WARN', ERROR: 'ERROR' };

class Logger {
  constructor() {
    this.config = { dir: 'logs', packets: false };
    this._stream = null;   // 当前日志文件写入流
    this._day = null;      // 当前文件对应的日期
    this._orig = {};       // 被替换前的原始 console 方法
    this._hooks = null;    // installBotHooks 的清理函数
  }

  // ---- 初始化：必须在任何 console 输出之前调用 ----
  init(options = {}) {
    this.config = { dir: 'logs', packets: false, ...options };
    try {
      fs.mkdirSync(this.config.dir, { recursive: true });
    } catch (err) {
      console.error('[Logger] 无法创建日志目录:', err);
    }
    this._installConsole();
    this._installProcessHooks();
    this.info('logger', `日志模块已初始化，输出目录: ${path.resolve(this.config.dir)}`);
    return this;
  }

  // ---- 文件管理：按天轮转 ----
  _ensureStream() {
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    if (this._day === day && this._stream) return this._stream;
    if (this._stream) {
      try { this._stream.end(); } catch (err) { /* 忽略关闭错误 */ }
    }
    const file = path.join(this.config.dir, `bakabot-${day}.log`);
    this._stream = fs.createWriteStream(file, { flags: 'a', encoding: 'utf8' });
    this._day = day;
    this._stream.on('error', (err) => {
      // 写入流出错时降级到 stderr，避免日志模块本身把进程搞挂
      try { this._orig.error && this._orig.error.call(console, '[Logger] 日志文件写入失败:', err); } catch (e) { /* ignore */ }
    });
    return this._stream;
  }

  _ts() {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  }

  // 单行写入：统一 squash 换行，保证一行一条日志
  // args 可能传数组（...args 收集）或单个字符串，统一处理避免被展开成单字符
  _write(level, tag, args) {
    let text = util.format(...(Array.isArray(args) ? args : [args]));
    if (text.includes('\n')) text = text.replace(/\r?\n/g, ' ⏎ ');
    let line = `[${this._ts()}] [${level}] [${tag}] ${text}\n`;
    try {
      this._ensureStream().write(line);
    } catch (err) {
      try { this._orig.error && this._orig.error.call(console, '[Logger] 写入失败:', err); } catch (e) { /* ignore */ }
    }
  }

  // ---- 拦截 console：任何 console.xxx 输出都记录 ----
  _installConsole() {
    if (this._installed) return;
    this._installed = true;
    const self = this;
    const map = {
      log: 'INFO', info: 'INFO', warn: 'WARN', error: 'ERROR',
      debug: 'DEBUG', trace: 'DEBUG',
    };
    for (const [name, level] of Object.entries(map)) {
      if (typeof console[name] !== 'function') continue;
      this._orig[name] = console[name].bind(console);
      console[name] = (...args) => {
        // Error 对象带堆栈落盘，方便排查
        const formatted = args.map(a => (a instanceof Error ? (a.stack || String(a)) : a));
        self._write(level, 'console', formatted);
        self._orig[name](...args); // 终端照常显示
      };
    }
  }

  // ---- 进程级错误：崩溃也留痕 ----
  _installProcessHooks() {
    process.on('uncaughtException', (err) => {
      this.error('process', `未捕获异常: ${err && err.stack ? err.stack : err}`);
      // 记录完再退出，避免静默死亡
      process.exit(1);
    });
    process.on('unhandledRejection', (reason) => {
      this.error('process', `未处理的 Promise 拒绝: ${reason && reason.stack ? reason.stack : reason}`);
    });
  }

  // ---- 结构化记录 ----
  debug(tag, ...args) { this._write(LEVEL.DEBUG, tag, args); }
  info(tag, ...args) { this._write(LEVEL.INFO, tag, args); }
  warn(tag, ...args) { this._write(LEVEL.WARN, tag, args); }
  error(tag, ...args) { this._write(LEVEL.ERROR, tag, args); }

  // 消息收发：dir = in|out, type = chat|whisper|system
  message(dir, type, sender, content, extra = '') {
    this._write(LEVEL.INFO, 'msg', [`${dir} ${type} <${sender}> ${content}`, extra].filter(Boolean).join(' '));
  }

  // 指令执行：result = ok|denied|unknown|error
  command(username, cmdline, result, detail = '') {
    this._write(LEVEL.INFO, 'cmd', [`${username} "${cmdline}" -> ${result}`, detail].filter(Boolean).join(' | '));
  }

  // 数据包级调试（仅 config.logging.packets = true 时输出）
  packet(dir, name) {
    if (!this.config.packets) return;
    this._write(LEVEL.DEBUG, 'pkt', `${dir} ${name}`);
  }

  // ---- 挂接 bot：记录所有消息收发 + 可选的包级日志 ----
  // 需在 createBot 之后调用；重复调用是安全的（内部去重）。
  installBotHooks(bot) {
    if (!bot || this._hooks) return;
    const self = this;
    const { createChatResolver, createWhisperDetector, nbtComponentToText, parseSystemWhisper } = require('./message-utils');
    const resolver = createChatResolver(bot);
    const hasPacketPath = !!(bot._client && resolver && resolver.packet);

    // 发出的消息：包装 bot.chat / bot.whisper（用标记避免重复包装）
    const wrapOut = (fn, type, targetArg) => {
      const wrapped = function (...args) {
        const target = targetArg ? args[0] : (bot.username || 'Bot');
        const content = targetArg ? args[1] : args[0];
        self.message('out', type, target, content);
        return fn.apply(this, args);
      };
      wrapped.__bakabotLogged = true;
      return wrapped;
    };
    if (typeof bot.chat === 'function' && !bot.chat.__bakabotLogged) bot.chat = wrapOut(bot.chat.bind(bot), 'chat', false);
    if (typeof bot.whisper === 'function' && !bot.whisper.__bakabotLogged) bot.whisper = wrapOut(bot.whisper.bind(bot), 'whisper', true);
    // 注入完成前包装过的函数在注入后会被 mineflayer 覆盖，登录后再补一次
    bot.once('inject_allowed', () => {
      if (typeof bot.chat === 'function' && !bot.chat.__bakabotLogged) bot.chat = wrapOut(bot.chat.bind(bot), 'chat', false);
      if (typeof bot.whisper === 'function' && !bot.whisper.__bakabotLogged) bot.whisper = wrapOut(bot.whisper.bind(bot), 'whisper', true);
    });

    if (hasPacketPath) {
      // 收到的消息：playerChat 重发事件（发送者/类型/内容齐全，插件改不了协议字段）
      bot._client.on('playerChat', (data) => {
        const info = resolver.packet(data);
        if (!info) {
          // 解析失败：dump 原始数据（BigInt 可序列化），定位类型/发送者哪一步丢失
          try {
            self.warn('msg', 'playerChat 解析失败，原始数据:',
              JSON.stringify(data, (k, v) => typeof v === 'bigint' ? v.toString() : v));
          } catch (err) {
            self.warn('msg', 'playerChat 解析失败（数据不可序列化）:', String(data));
          }
          return;
        }
        self.message('in', info.type, info.sender, info.content);
      });
      // 系统消息（服务器系统消息 / 公告）；部分服务端把私信也走这条通道
      bot._client.on('systemChat', (data) => {
        if (data.isActionBar === true || data.positionId === 2) return; // 动作栏，跳过
        const raw = data.formattedMessage != null ? data.formattedMessage : data.content;
        // 完整记录原始数据（DEBUG 级，仅落盘）：排查私信正文丢失/形状变化
        try { self.debug('sysraw', JSON.stringify(raw)); }
        catch (err) { try { self.debug('sysraw', String(raw)); } catch (e) { /* ignore */ } }
        let text = nbtComponentToText(raw);
        if (!text) {
          // 兜底：字符串直接用，对象尝试 JSON（避免 [object Object]）
          try { text = typeof raw === 'string' ? raw : JSON.stringify(raw); }
          catch (err) { text = String(raw || ''); }
        }
        // 私信渲染成 '[发送者 -> 我] 内容' → 归类为私信
        const w = parseSystemWhisper(text);
        if (w) {
          if (!w.content) self.warn('msg', `私信内容为空！<${w.sender}> 原始数据见上一行 [sysraw]`);
          self.message('in', 'whisper', w.sender, w.content);
        } else {
          self.message('in', 'system', 'server', text);
        }
      });
    } else {
      // 兜底（无 player_chat 环境）：旧版事件
      const detectWhisper = createWhisperDetector(bot);
      const handled = new WeakSet();
      bot.on('message', (msg, position) => {
        if (position === 'game_info') return;
        const info = detectWhisper(msg);
        if (info) {
          handled.add(msg);
          self.message('in', 'whisper', info.sender, info.content);
          return;
        }
        self.message('in', 'chat', (msg.with && msg.with[0] ? String(msg.with[0]) : '?'), msg ? msg.toString() : String(msg));
      });
      bot.on('whisper', (username, message, translate, originalMsg) => {
        if (handled.has(originalMsg)) return;
        self.message('in', 'whisper', username, message);
      });
    }

    // 包级调试日志（可选项）：入站走 packet 事件，出站包装 write（本版本无 send 事件）
    if (this.config.packets && bot._client) {
      bot._client.on('packet', (data, meta) => self.packet('in', meta.name));
      if (typeof bot._client.write === 'function' && !bot._client.write.__bakabotPacketLogged) {
        const origWrite = bot._client.write.bind(bot._client);
        const loggedWrite = (name, params) => {
          self.packet('out', name);
          return origWrite(name, params);
        };
        loggedWrite.__bakabotPacketLogged = true;
        bot._client.write = loggedWrite;
      }
    }

    this._hooks = () => { /* 预留清理钩子 */ };
  }
}

module.exports = new Logger();
