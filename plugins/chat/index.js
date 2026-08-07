// plugins/chat/index.js
// 聊天插件：让机器人公屏说话（!chat）或私聊玩家（!w）
module.exports = (context) => {
  const { bot, commands } = context;

  commands.register({
    name: 'chat',
    permissionLevel: 1,
    description: '指令：让机器人在公屏说话。用法: !chat <内容>',
    execute: (username, args) => {
      const content = args.join(' ').trim();
      if (!content) {
        bot.whisper(username, '> 参数错误：需要说话内容。用法: !chat <内容>');
        return;
      }
      bot.chat(content);
    },
  });

  commands.register({
    name: 'w',
    permissionLevel: 1,
    description: '指令：让机器人私聊指定玩家。用法: !w <玩家名> <内容>',
    execute: (username, args) => {
      const target = args.shift();
      const content = args.join(' ').trim();
      if (!target || !content) {
        bot.whisper(username, '> 参数错误：用法: !w <玩家名> <内容>');
        return;
      }
      if (!bot.players[target]) {
        bot.whisper(username, `> 目标错误：玩家 '${target}' 不在线。`);
        return;
      }
      bot.whisper(target, content);
    },
  });
};
