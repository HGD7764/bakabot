// message-utils.js
// 聊天消息解析工具：玩家聊天识别（公屏/私信）与发送者/内容提取。
//
// ⚠️ 背景：服务器聊天格式插件（如 "名字[emoji] >> 消息"）会改写 chat type 的
// translation_key 与 networkName 显示组件，导致 mineflayer 组装的 msg.translate
// 不再是标准 key（commands.message.display.incoming）、msg.with 里也拿不到干净
// 的发送者名字 —— 依赖 translate 的旧解析在插件服务器上会失效。
// 因此主路径改为解析 minecraft-protocol 重发的 'playerChat' 事件（与 mineflayer
// 同源，字段经协议层归一，跨版本稳定）：
//   - sender（发送者 UUID，协议字段，插件改不了）
//   - type（chatType 编号，查登录时注入的 registry.chatFormattingById 得类型名；
//          解析层已把包内 varint 归一为注册表原始 id，直接命中）
//   - plainMessage（明文内容） / unsignedContent（未签名修改后的内容，JSON 组件）
//   - senderName / targetName（发送者/目标显示组件，JSON 字符串，仅作回退）
// 同时兼容直接订阅原始 'player_chat' 数据包的字段形状（senderUuid / networkName /
// networkTargetName / unsignedChatContent）。
// 旧接口 createWhisperDetector 保留，用于无 player_chat 环境（如 mock 测试）兜底。
'use strict';

// anonymousNbt / 文本组件 / JSON 字符串 → 纯文本。兼容 {type:'string',value:'{json}'} NBT 包装、
// 嵌套字段为 NBT tag 的复合组件（如 {text:{type:'string',value:'hi'}}）、
// 已解析 JSON 对象、JSON 字符串（'{"text":...}' / '"Steve"'）、纯字符串（统一去 § 颜色码）。
function nbtComponentToText(comp) {
  // 解一层 prismarine-nbt tag 包装（string/compound/list 都适用：取 .value）
  if (comp && typeof comp === 'object' && typeof comp.type === 'string' && 'value' in comp) {
    return nbtComponentToText(comp.value);
  }
  const raw = comp;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t.startsWith('{') || t.startsWith('[') || t.startsWith('"')) {
      try {
        return nbtComponentToText(JSON.parse(t));
      } catch (err) { return raw.replace(/§./g, ''); }
    } else {
      return raw.replace(/§./g, '');
    }
  }
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.map(nbtComponentToText).join('');
  if (raw && typeof raw === 'object') {
    // text + extra 拼接（如 {text:'a', extra:[b,c]} → 'abc'）；字段本身可能是嵌套
    // NBT tag（如 {text:{type:'string',value:'hi'}}），递归展开
    const parts = [];
    const text = nbtComponentToText(raw.text);
    if (text) parts.push(text);
    // 插件序列化怪癖：text 键名丢失变成 {"" : "内容"}（如私信正文 {"":"!ping"}），
    // text 为空时把空键的值当正文补上
    if (!text && raw[''] != null) {
      const ek = nbtComponentToText(raw['']);
      if (ek) parts.push(ek);
    }
    // translate 组件（踢出原因等系统消息常见）：渲染 key + 参数
    const translate = nbtComponentToText(raw.translate);
    if (translate) {
      // with 可能是 NBT list tag（{type:'list', value:[...]}），先解包再判断
      const withTag = raw.with;
      const withList = withTag && typeof withTag === 'object' && 'value' in withTag
        ? withTag.value
        : withTag;
      const params = Array.isArray(withList)
        ? withList.map(nbtComponentToText).filter(Boolean)
        : [];
      parts.push(params.length ? `${translate}: ${params.join(' ')}` : translate);
    }
    if (Array.isArray(raw.extra)) {
      for (const e of raw.extra) {
        const s = nbtComponentToText(e);
        if (s) parts.push(s);
      }
    }
    return parts.join('');
  }
  return '';
}

// 任意 reason 对象 → 可读文本（踢出/断线原因）。
// mineflayer 的 kicked reason 是原始 NBT 聊天组件（{text:...} / {translate,with:...}），
// 模板字符串直接插值会得到 '[object Object]'，必须走组件提取。
function reasonToText(reason) {
  if (reason == null) return String(reason);
  const t = nbtComponentToText(reason);
  if (t) return t;
  if (typeof reason === 'object') {
    try {
      const s = String(reason);
      if (s && s !== '[object Object]') return s;
      return JSON.stringify(reason);
    } catch (err) { /* 落回 String */ }
  }
  return String(reason);
}

// 私信通道二：部分服务端（Paper 等关闭聊天签名时）/ 聊天格式插件会把私信渲染成
// '[发送者 -> 我] 内容' 以 system_chat 数据包发送 —— 这种私信在 playerChat 事件里
// 根本不存在，只能从渲染文本反解。返回 { sender, content }；非私信形状返回 null。
function parseSystemWhisper(text) {
  if (typeof text !== 'string') return null;
  const m = /^\[([^\]\r\n]+?)\s*(?:->|→|»)\s*[^\]\r\n]+\]\s*([\s\S]*)$/.exec(text.trim());
  if (!m) return null;
  const sender = m[1].replace(/§./g, '').trim();
  if (!sender) return null;
  const content = m[2].replace(/§./g, '');
  return { sender, content };
}

module.exports = {
  nbtComponentToText,
  reasonToText,
  parseSystemWhisper,

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

  // ---- 新接口：解析玩家聊天（主路径）----
  // 用法: const resolver = createChatResolver(bot); resolver.packet(data)
  // data 为 minecraft-protocol 重发的 'playerChat' 事件数据（mineflayer 同源），
  // 字段形状：{ plainMessage, unsignedContent, type:{chatType}, sender(uuid),
  //            senderName, targetName, verified }；
  // 也兼容直接订阅原始 'player_chat' 数据包的形状（senderUuid / unsignedChatContent /
  // networkName / networkTargetName）。
  // 返回 { type: 'chat'|'whisper'|'system', sender, content, uuid }；无法识别返回 null。
  // 依赖：bot.registry.chatFormattingById（登录后由服务器 codec 注入，键为原始 chatType id，
  //       minecraft-protocol 解析时已把包内 varint 归一为 id，直接命中）、
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
          if (!data) return null;

          // ---- 1) 聊天类型：私信/公屏/系统 ----
          // type 为 ChatTypesHolder 解析结果：{ chatType: id }（已知注册表项）
          // 或 { data: {...} }（包内联定义，极罕见）；旧协议可能是裸数字。
          const holder = data.type;
          let typeId = 0;
          if (holder && typeof holder === 'object') {
            if (holder.chatType != null) typeId = holder.chatType;
          } else if (typeof holder === 'number') {
            typeId = holder;
          }
          const name = resolver.typeName(typeId);
          let type = null;
          if (name === 'minecraft:chat' || name === 'minecraft:emote_command' ||
              name === 'minecraft:team_msg_command_incoming' || name === 'minecraft:team_msg_command_outgoing') {
            type = 'chat';
          } else if (name === 'minecraft:msg_command_incoming') {
            type = 'whisper';
          } else if (name === 'minecraft:say_command' || name === 'minecraft:system') {
            type = 'system';
          }
          // 兜底：私信包必有目标组件（playerChat 重发=targetName，原始包=networkTargetName），
          // chatType 缺失/插件自定义类型时按此判断
          if (!type && (data.targetName != null || data.networkTargetName != null)) type = 'whisper';
          // player_chat 一定是玩家消息：注册表查不到时按公屏处理而不是丢弃
          if (!type) type = 'chat';

          // ---- 2) 发送者：UUID → 真实用户名（最可靠），回退显示组件 ----
          const uuid = data.senderUuid || data.sender || null;
          let sender = uuid && bot.uuidToUsername && bot.uuidToUsername[uuid];
          if (!sender) {
            // playerChat 重发=senderName（JSON 字符串），原始包=networkName（nbt 组件）
            const comp = data.senderName != null ? data.senderName : data.networkName;
            const nn = nbtComponentToText(comp).trim();
            if (nn) sender = nn;
          }
          if (!sender) return null;

          // ---- 3) 内容：unsignedContent（未签名修改后的文本）优先，回退明文 ----
          const ucc = data.unsignedContent != null ? data.unsignedContent : data.unsignedChatContent;
          let content = '';
          if (ucc != null) content = nbtComponentToText(ucc);
          if (!content) content = (data.plainMessage || '').trim();
          // 旧协议没有 plainMessage，退回签名内容组件
          if (!content && data.signedChatContent != null) content = nbtComponentToText(data.signedChatContent);
          return { type, sender, content: String(content).replace(/§./g, ''), uuid };
        } catch (err) {
          return null;
        }
      },
    };
    bot._chatResolver = resolver;
    return resolver;
  },
};
