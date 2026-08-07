// command-manager.js
// 集中式命令管理器：解析指令、权限检查、执行。
// 支持两种触发方式（由主 config.json 的 commandTrigger 控制）：
//   - 'whisper'（默认）：私信触发。玩家通过 /msg Bot !指令 私聊机器人触发。
//     ✋ 通过底层 message 事件按聊天类型识别（chat type key 自适应服务器 codec），
//     ✋ 并用旧版 whisper 模式事件兜底，两种路径以 WeakSet 去重。
//   - 'chat'：公屏触发。玩家在公屏发送 !指令 触发（旧版行为）。
const { createWhisperDetector } = require('./message-utils');

class CommandManager {
  constructor(bot, permissions, prefix = '!', trigger = 'whisper') {
    this.bot = bot;
    this.permissions = permissions; // 保存权限管理器实例
    this.prefix = prefix;
    this.commands = new Map();
    this.trigger = trigger;

    if (trigger === 'chat') {
      this.bot.on('chat', (username, message) => this.handleMessage(username, message));
    } else {
      // 私信触发：
      // 1) 主路径：底层 message 事件 + 聊天类型识别（key 自适应服务器 codec）
      // 2) 兜底：旧版字符串格式的 whisper 模式事件，WeakSet 去重防双触发
      const handled = new WeakSet();
      const detectWhisper = createWhisperDetector(bot);
      this.bot.on('message', (msg, position) => {
        if (position !== 'chat') return; // 只处理玩家聊天数据包
        const info = detectWhisper(msg);
        if (!info || info.sender === this.bot.username) return;
        handled.add(msg);
        this.handleMessage(info.sender, info.content);
      });
      this.bot.on('whisper', (username, message, translate, originalMsg) => {
        if (handled.has(originalMsg)) return; // 已被主路径处理
        this.handleMessage(username, message);
      });
    }
  }

  handleMessage(username, message) {
    if (this.bot.username === username || !message.startsWith(this.prefix)) return;

    const args = message.slice(this.prefix.length).trim().split(/ +/);
    const commandName = args.shift().toLowerCase();
    const command = this.commands.get(commandName);

    if (command) {
      // --- 权限检查 ---
      const userLevel = this.permissions.getLevel(username);
      if (userLevel < command.permissionLevel) {
        this.bot.whisper(username, `> 指令错误：权限不足。需要等级 ${command.permissionLevel}，你的等级为 ${userLevel}。`);
        return;
      }

      try {
        command.execute(username, args);
      } catch (err) {
        console.error(`执行命令 '${commandName}' 时出错:`, err);
        this.bot.whisper(username, '> 系统异常：指令执行失败。');
      }
    } else {
      this.bot.whisper(username, '> 指令错误：未知指令。');
    }
  }

  /**
   * 注册一个新命令
   * @param {object} options - 命令选项
   * @param {string} options.name - 命令名称
   * @param {number} [options.permissionLevel=0] - 所需最低权限等级
   * @param {string} [options.description=''] - 命令描述
   * @param {function(string, string[]): void} options.execute - 执行函数
   */
  register(options) {
    const { name, permissionLevel = 0, description = '', execute } = options;
    if (this.commands.has(name)) {
      console.warn(`[CommandManager] 警告: 命令 '${name}' 已被注册，将被覆盖。`);
    }
    this.commands.set(name, { name, permissionLevel, description, execute });
    console.log(`[CommandManager] 已注册命令: ${this.prefix}${name} (权限等级: ${permissionLevel})`);
  }
}

module.exports = { CommandManager };
