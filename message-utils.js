// message-utils.js
// 聊天消息解析工具：玩家聊天识别（公屏/私信）与发送者/内容提取。
//
// ⚠️ 背景：服务器聊天格式插件（如 "名字[emoji] >> 消息"）会改写 chat type 的
// translation_key 与 networkName 显示组件，导致 mineflayer 组装的 msg.translate
// 不再是标准 key（commands.message.display.incoming）、msg.with 里也拿不到干净
// 的发送者名字 —— 依赖 translate 的旧解析在插件服务器上会失效。
// 因此主路径改为直接解析 player_chat 数据包原始字段：
//   - senderUuid（UUID，协议字段，插件改不了）
//   - type（chatType 编号，查登录时注入的 registry.chatFormattingById 得类型名）
//   - plainMessage / unsignedChatContent（明文内容，不带格式）
//   - networkName（发送者显示组件，含前缀/emoji，仅作回退）
// 旧接口 createWhisperDetector 保留，用于无 player_chat 环境（如 mock 测试）兜底。
'use strict';

// anonymousNbt / 文本组件 → 纯文本。兼容 {type:'string',value:'{json}'} NBT 包装、
// 已解析 JSON 对象、纯字符串（统一去 § 颜色码）。
function nbtComponentToText(comp) {
  let raw = comp;
  if (raw && typeof raw === 'object' && typeof raw.value !== 'undefined' && typeof raw.type === 'string') {
    raw = raw.value; // 解 prismarine-nbt 包装
  }
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try { raw = JSON.parse(t); } catch (err) { return raw.replace(/§./g, ''); }
    } else {
      return raw.replace(/§./g, '');
    }
  }
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.map(nbtComponentToText).join('');
  if (raw && typeof raw === 'object') {
    if (typeof raw.text === 'string') return raw.text;
    if (typeof raw.translate === 'string') return raw.translate;
    if (Array.isArray(raw.extra)) return raw.extra.map(nbtComponentToText).join('');
  }
  return '';
}

module.exports = {
  nbtComponentToText,

  // ---- 旧接口：按 chat type 翻译 key 识别私信（无 playerChat 环境兜底用）----
  // 私信的 chat type（默认 commands.message.display.incoming）由服务器登录包里的
  // codec 定义，不同版本/服务端可能改名，因此连接后（inject_allowed）按名字
  // 自动查找对应 formatString；找不到时回退到默认 key。
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

  // ---- 新接口：解析 player_chat 数据包（主路径）----
  // 用法: const resolver = createChatResolver(bot); resolver.packet(data)
  // data 为 minecraft-protocol 解析后的 player_chat 包对象。
  // 返回 { type: 'chat'|'whisper'|'system', sender, content, uuid }；无法识别返回 null。
  // 依赖：bot.registry.chatFormattingById（登录后由服务器 codec 注入）、
  //       bot.uuidToUsername（玩家列表，uuid → 真实用户名）。
  createChatResolver(bot) {
    if (bot._chatResolver) return bot._chatResolver;
    const resolver = {
      // chatType 编号 → 类型名（minecraft:chat / minecraft:msg_command_incoming / ...）
      typeName(typeId) {
        const byId = bot.registry && bot.registry.chatFormattingById;
        return (byId && byId[typeId] && byId[typeId].name) || '';
      },
      packet(data) {
        try {
          // 1) 聊天类型：私信/公屏/系统（按 chatType 编号判定，不依赖翻译 key）
          const typeId = data && data.type && data.type.chatType != null ? data.type.chatType : (data && data.type || 0);
          const name = resolver.typeName(typeId);
          let type = null;
          if (name === 'minecraft:chat' || name === 'minecraft:emote_command' ||
              name === 'minecraft:team_msg_command_incoming' || name === 'minecraft:team_msg_command_outgoing') {
            type = 'chat';
          } else if (name === 'minecraft:msg_command_incoming') {
            type = 'whisper';
          } else if (name === 'minecraft:say_command') {
            type = 'system';
          }
          // 兜底：私信包必有目标（networkTargetName），chatType 缺失/插件自定义时按此判断
          if (!type && data && data.networkTargetName) type = 'whisper';
          if (!type) return null;

          // 2) 发送者：UUID → 真实用户名（最可靠），回退 networkName 显示组件
          const uuid = data && (data.senderUuid || data.sender);
          let sender = uuid && bot.uuidToUsername && bot.uuidToUsername[uuid];
          if (!sender && data && data.networkName) {
            const nn = nbtComponentToText(data.networkName).trim();
            if (nn) sender = nn;
          }
          if (!sender) return null;

          // 3) 内容：unsignedChatContent（未签名修改后的文本）优先，回退明文
          let content = data && data.unsignedChatContent ? nbtComponentToText(data.unsignedChatContent) : '';
          if (!content) content = (data && data.plainMessage) || '';
          return { type, sender, content: String(content).replace(/§./g, ''), uuid: uuid || null };
        } catch (err) {
          return null;
        }
      },
    };
    bot._chatResolver = resolver;
    return resolver;
  },
};
