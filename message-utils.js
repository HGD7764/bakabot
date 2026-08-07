// message-utils.js
// 聊天消息解析工具：私信识别。
// 私信的 chat type（默认 commands.message.display.incoming）由服务器登录包里的
// codec 定义，不同版本/服务端可能改名，因此连接后（inject_allowed）按名字
// 自动查找对应 formatString；找不到时回退到默认 key。
module.exports = {
  createWhisperDetector(bot) {
    let key = 'commands.message.display.incoming';
    bot.once('inject_allowed', () => {
      const byName = (bot.registry && bot.registry.chatFormattingByName) || {};
      const found = Object.values(byName).find(v => v && /incoming/i.test(v.name || ''));
      if (found && found.formatString) key = found.formatString;
      console.log(`[MessageUtils] 私信 chat type key: ${key}`);
    });
    // 返回 { sender, content }；不是私信返回 null
    return (msg) => {
      if (!msg || msg.translate !== key) return null;
      const withs = msg.with || [];
      const sender = withs[0] ? withs[0].toString() : null;
      if (!sender) return null;
      const content = withs[1] ? withs[1].toString() : msg.toString();
      return { sender, content };
    };
  },
};
