'use strict';

// =============================================================================
// Disc Jockey 插件 —— 移植自 Disc-Jockey 模组(semmiedev/Disc-Jockey, 26.2 fork)
// 用音符盒播放 .nbs 歌曲:选歌与配置在网页面板(web-manager)进行,游戏内 !dj 指令
// 与模组命令一一对应。约束:只映射 16 种经典 NBS 乐器,不使用 26.x 新乐器。
//
// 结构(与模组文件对应):
//   parseNbs      —— SongLoader + BinaryReader + Song 的移植
//   RateLimiter   —— 播放/调音数据包限速(防被服务器踢)
//   Tuner         —— 扫描周围音符盒、为歌曲音符分配方块、调音(右键递增音高)
//   SongPlayer    —— 异步播放线程:击打(block_dig start/abort)触发音符
//
// 重载安全:所有运行时状态都挂在 state.discJockey 上,首次加载创建一次;
// 重载插件只刷新 config.json 与歌曲列表,播放/调音不会被中断。
// =============================================================================

const fs = require('fs');
const path = require('path');
const Vec3 = require('vec3'); // mineflayer 依赖,prismarine-world 的 getBlock 需要 .floored()

// ---- 16 种经典乐器,NBS 乐器 ID 0-15(与模组 Note.INSTRUMENTS 顺序一致) ----
const INSTRUMENTS = [
  'harp', 'bass', 'basedrum', 'snare', 'hat', 'guitar', 'flute', 'bell',
  'chime', 'xylophone', 'iron_xylophone', 'cow_bell', 'didgeridoo', 'bit', 'banjo', 'pling',
];

// 每种乐器对应的音符盒下方方块(网页端"所需音符盒"展示用)
const INSTRUMENT_BLOCKS = {
  harp: 'air', basedrum: 'stone', snare: 'sand', hat: 'glass', bass: 'oak_planks',
  flute: 'clay', bell: 'gold_block', guitar: 'white_wool', chime: 'packed_ice',
  xylophone: 'bone_block', iron_xylophone: 'iron_block', cow_bell: 'soul_sand',
  didgeridoo: 'pumpkin', bit: 'emerald_block', banjo: 'hay_block', pling: 'glowstone',
};

// 放在音符盒【上方】生效的乐器(头颅类),对应 vanilla worksAboveNoteBlock
const WORKS_ABOVE = new Set(['zombie', 'skeleton', 'creeper', 'dragon', 'wither_skeleton', 'piglin', 'custom_head']);
// 头颅方块 → 其 worksAbove 乐器(模组变通路径用 defaultBlockState().instrument() 判断)
const SKULL_BLOCKS = {
  zombie_head: 'zombie', skeleton_skull: 'skeleton', creeper_head: 'creeper',
  dragon_head: 'dragon', wither_skeleton_skull: 'wither_skeleton', piglin_head: 'piglin', player_head: 'custom_head',
};

// 音符盒下方方块 → 乐器(经典 vanilla 映射,仅 instrumentDetectionWorkaround 变通用)
const BELOW_BLOCK_INSTRUMENT = { ...SKULL_BLOCKS };
for (const [inst, block] of Object.entries(INSTRUMENT_BLOCKS)) BELOW_BLOCK_INSTRUMENT[block] = inst;
Object.assign(BELOW_BLOCK_INSTRUMENT, {
  air: 'harp',
  // 木板 → bass
  spruce_planks: 'bass', birch_planks: 'bass', jungle_planks: 'bass', acacia_planks: 'bass',
  dark_oak_planks: 'bass', mangrove_planks: 'bass', cherry_planks: 'bass', bamboo_planks: 'bass',
  crimson_planks: 'bass', warped_planks: 'bass',
  // 石头类 → basedrum
  granite: 'basedrum', diorite: 'basedrum', andesite: 'basedrum', tuff: 'basedrum', deepslate: 'basedrum',
  cobblestone: 'basedrum', cobbled_deepslate: 'basedrum', blackstone: 'basedrum', polished_blackstone: 'basedrum',
  polished_deepslate: 'basedrum', stone_bricks: 'basedrum', mossy_stone_bricks: 'basedrum',
  cracked_stone_bricks: 'basedrum', chiseled_stone_bricks: 'basedrum', deepslate_bricks: 'basedrum',
  deepslate_tiles: 'basedrum', netherrack: 'basedrum', nether_bricks: 'basedrum', brick: 'basedrum',
  // 沙子类 → snare
  red_sand: 'snare', gravel: 'snare',
  // 玻璃类 → hat
  sea_lantern: 'hat', beacon: 'hat',
  // 黏土类 → flute
  terracotta: 'flute',
  // 南瓜 → didgeridoo
  carved_pumpkin: 'didgeridoo',
});

// Note 编码位移(与模组 Note.java 一致:tick | layer<<16 | instrument<<32 | note<<40)
const LAYER_SHIFT = 16;
const INSTRUMENT_SHIFT = 32;
const NOTE_SHIFT = 40;
const TWO_32 = 4294967296; // 2^32
const TWO_40 = 1099511627776; // 2^40

// ---- NBS 文件解析(SongLoader.java 移植) ----
// NBS 二进制格式:小端序;旧格式直接是 length,新格式 length=0 后跟 formatVersion 等
function parseNbs(fileName, buf) {
  let off = 0;
  const u16 = () => { const v = buf.readUInt16LE(off); off += 2; return v; };
  const i16 = () => { const v = buf.readInt16LE(off); off += 2; return v; };
  const i32 = () => { const v = buf.readInt32LE(off); off += 4; return v; };
  const i8 = () => { const v = buf.readInt8(off); off += 1; return v; };
  const str = () => { const len = i32(); const v = buf.toString('utf8', off, off + len); off += len; return v; };
  const clean = (s) => String(s).replace(/[\n\r]/g, '');

  const song = {};
  song.fileName = clean(fileName);
  song.length = u16();
  const newFormat = song.length === 0;
  if (newFormat) {
    song.formatVersion = i8();
    song.vanillaInstrumentCount = i8();
    song.length = u16();
  }
  song.height = i16();
  song.name = clean(str());
  song.author = clean(str());
  song.originalAuthor = clean(str());
  song.description = clean(str());
  song.tempo = i16();
  song.autoSaving = i8();
  song.autoSavingDuration = i8();
  song.timeSignature = i8();
  song.minutesSpent = i32();
  song.leftClicks = i32();
  song.rightClicks = i32();
  song.blocksAdded = i32();
  song.blocksRemoved = i32();
  song.importFileName = clean(str());
  if (newFormat) {
    song.loop = i8();
    song.maxLoopCount = i8();
    song.loopStartTick = i16();
  }
  song.displayName = song.name.replace(/\s/g, '') === '' ? song.fileName : `${song.name} (${song.fileName})`;
  song.searchableFileName = song.fileName.toLowerCase().replace(/\s/g, '');
  song.searchableName = song.name.toLowerCase().replace(/\s/g, '');

  // 音符:跳变编码,直到 0 结束
  const uniqueNotes = []; // 'instrument,note' 字符串,模拟 Java 的 equals
  const notes = [];
  let tick = -1;
  let jumps;
  while ((jumps = i16()) !== 0) {
    tick += jumps;
    let layer = -1;
    while ((jumps = i16()) !== 0) {
      layer += jumps;
      const instrumentId = i8();
      let noteId = i8() - 33;
      if (newFormat) { i8(); i8(); i16(); } // velocity / panning / pitch(仅指令用,不需要)
      if (noteId < 0) noteId = 0;
      else if (noteId > 24) noteId = 24;
      const key = `${instrumentId},${noteId}`;
      if (!uniqueNotes.includes(key)) uniqueNotes.push(key);
      // 2^48 < 2^53,float64 可精确表示;layer<<16 用乘法避免 32 位符号问题
      notes.push(tick + layer * 65536 + instrumentId * TWO_32 + noteId * TWO_40);
    }
  }
  song.uniqueNotes = uniqueNotes;
  song.notes = notes;
  return song;
}

// 歌曲时间换算(Song.java 移植)
function millisecondsToTicks(song, ms) {
  const songSpeed = (song.tempo / 100) / 20; // tempo 为 tick/s × 100;20 tick/s 为 1 倍速
  if (songSpeed <= 0) return 0;
  return ms * (1 / 50) * songSpeed;
}
function ticksToMilliseconds(song, ticks) {
  const songSpeed = (song.tempo / 100) / 20;
  if (songSpeed <= 0) return 0;
  return ticks / (1 / 50) / songSpeed;
}
function songLengthSeconds(song) {
  const ms = ticksToMilliseconds(song, song.length);
  return Math.max(0, ms) / 1000;
}

// ---- 速率限制器(RateLimiter.java 移植) ----
// 每 100ms 估算数据包数,超过阈值暂停发送,防止被服务器踢
const RATE_LIMITS = {
  Limit100: { reduce: 3, max: 7 },
  Limit200: { reduce: 13, max: 15 },
  Limit300: { reduce: 20, max: 25 },
  Limit500: { reduce: 30, max: 45 },
  NoLimit: { reduce: Infinity, max: Infinity },
};

function createRateLimiter(getCfg) {
  const rl = {
    spanAt: -1, spanPackets: 0,
    reduceUntil: -1, stopUntil: -1,
    lastLookAt: -1, lastSwingAt: -1,
    reset() { rl.spanAt = -1; rl.spanPackets = 0; rl.reduceUntil = -1; rl.stopUntil = -1; rl.lastLookAt = -1; rl.lastSwingAt = -1; },
  };
  const limits = () => RATE_LIMITS[getCfg().playbackPacketRatelimit] || RATE_LIMITS.Limit500;

  rl.tick = () => {
    const now = Date.now();
    if (rl.spanAt !== -1 && now - rl.spanAt >= 100) { rl.spanPackets = 0; rl.spanAt = now; }
    else if (rl.spanAt === -1) { rl.spanAt = now; rl.spanPackets = 0; }
  };
  rl.onPacketSent = () => { rl.spanPackets++; rl.checkLimits(); };
  rl.onLookSent = () => { rl.lastLookAt = Date.now(); rl.onPacketSent(); };
  rl.onSwingSent = () => { rl.lastSwingAt = Date.now(); rl.onPacketSent(); };
  rl.checkLimits = () => {
    const l = limits();
    const now = Date.now();
    if (rl.spanPackets >= l.reduce) rl.reduceUntil = Math.max(rl.reduceUntil, now + 500);
    if (rl.spanPackets >= l.max) {
      rl.stopUntil = Math.max(rl.stopUntil, now + 250);
      rl.reduceUntil = Math.max(rl.reduceUntil, now + 10000);
    }
  };
  rl.canSendCosmetic = () => rl.spanPackets < limits().reduce && (rl.reduceUntil === -1 || rl.reduceUntil < Date.now());
  rl.canSendAny = () => rl.spanPackets < limits().max && (rl.stopUntil === -1 || rl.stopUntil < Date.now());
  rl.canSendLook = () => (rl.lastLookAt === -1 || Date.now() - rl.lastLookAt >= 50) && rl.canSendCosmetic();
  rl.canSendSwing = () => (rl.lastSwingAt === -1 || Date.now() - rl.lastSwingAt >= 50) && rl.canSendCosmetic();
  return rl;
}

// ---- 主模块 ----
module.exports = (context) => {
  const { bot, config, state, commands, webManager, pluginName } = context;

  // ========== 共享状态(重载安全:只在首次加载创建) ==========
  const songsDir = path.join(__dirname, 'songs');
  const cfgFile = path.join(__dirname, 'config.json');
  const DEFAULTS = {
    expectedServerVersion: 'All',
    tuningSpeed: 'Spigot',
    playbackPacketRatelimit: 'Limit500',
    delayPlaybackStartBySecs: 0,
    instrumentDetectionWorkaround: true,
    hideWarning: false,
    favorites: [],
  };
  const ENUMS = {
    expectedServerVersion: ['All', 'v1_20_4_Or_Earlier', 'v1_20_5_Or_Later'],
    tuningSpeed: ['Snail', 'Safe', 'Spigot', 'Flash'],
    playbackPacketRatelimit: ['Limit100', 'Limit200', 'Limit300', 'Limit500', 'NoLimit'],
  };

  const st = state.discJockey || (state.discJockey = {});
  st.cfg = loadCfg();
  st.songs = loadSongs();
  cleanupFavorites();

  function loadCfg() {
    let disk = {};
    try { disk = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (e) { /* 首次运行无配置文件 */ }
    return { ...DEFAULTS, ...disk };
  }
  function saveCfg() {
    try { fs.writeFileSync(cfgFile, JSON.stringify(st.cfg, null, 2)); return true; } catch (e) { return false; }
  }
  function loadSongs() {
    const list = [];
    if (!fs.existsSync(songsDir)) { try { fs.mkdirSync(songsDir, { recursive: true }); } catch (e) {} }
    try {
      for (const f of fs.readdirSync(songsDir)) {
        if (!f.toLowerCase().endsWith('.nbs')) continue;
        try { list.push(parseNbs(f, fs.readFileSync(path.join(songsDir, f)))); }
        catch (err) { console.error(`[disc-jockey] 无法解析歌曲 ${f}:`, err.message); }
      }
    } catch (err) { console.error('[disc-jockey] 读取歌曲目录失败:', err.message); }
    list.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return list;
  }
  function cleanupFavorites() {
    const stale = st.cfg.favorites.filter(f => !st.songs.some(s => s.fileName === f));
    if (stale.length) {
      st.cfg.favorites = st.cfg.favorites.filter(f => !stale.includes(f));
      saveCfg();
    }
  }

  // ========== 工具 ==========
  const reply = (username, msg) => bot.whisper(username, `> ${msg}`);
  const fmtTime = (sec) => {
    if (sec < 0) return '-' + fmtTime(-sec);
    const s = Math.floor(sec % 60), m = Math.floor(sec / 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };
  const posKey = (p) => `${p.x},${p.y},${p.z}`;
  const wrapDegrees = (v) => ((v % 360) + 360 + 180) % 360 - 180;
  const noteTick = (n) => ((n & 0xFFFF) << 16) >> 16; // (short)note:低 16 位符号扩展
  const noteInstrumentId = (n) => Math.floor(n / TWO_32) & 0xFF;
  const noteNoteId = (n) => Math.floor(n / TWO_40) & 0xFF;

  // 眼睛位置(脚底 + 1.62)
  const eyePos = () => bot.entity ? { x: bot.entity.position.x, y: bot.entity.position.y + 1.62, z: bot.entity.position.z } : null;

  // 与方块交互距离检查(Util.canInteractWith 移植;1.21.11 方块交互距离 4.5)
  const canInteractWith = (pos) => {
    const eye = eyePos();
    if (!eye) return false;
    const centerDist2 = (eye.x - pos.x - 0.5) ** 2 + (eye.y - pos.y - 0.5) ** 2 + (eye.z - pos.z - 0.5) ** 2;
    // AABB 距离:点到方块立方体最近距离
    const dx = Math.max(pos.x - eye.x, 0, eye.x - (pos.x + 1));
    const dy = Math.max(pos.y - eye.y, 0, eye.y - (pos.y + 1));
    const dz = Math.max(pos.z - eye.z, 0, eye.z - (pos.z + 1));
    const aabbDist2 = dx * dx + dy * dy + dz * dz;
    const range = 4.5 + 1.0;
    switch (st.cfg.expectedServerVersion) {
      case 'v1_20_4_Or_Earlier': return centerDist2 <= 36;
      case 'v1_20_5_Or_Later': return aabbDist2 < range * range;
      default: return centerDist2 <= 36 && aabbDist2 < range * range;
    }
  };

  const blockAt = (x, y, z) => bot.blockAt(new Vec3(x, y, z)); // 必须传 Vec3,否则 world.getBlock 的 pos.floored() 崩溃
  const safeProps = (block) => {
    try {
      const p = block.getProperties();
      return p && p.instrument !== undefined ? p : null;
    } catch (e) { return null; }
  };
  // 下方方块名称 → 乐器(变通用)
  const instrumentOfBlock = (name) => {
    if (name.endsWith('_planks') || name === 'planks') return 'bass';
    if (name.endsWith('_wool') || name === 'wool') return 'guitar';
    if (name.endsWith('_stained_glass') || name.endsWith('_glass_pane')) return 'hat';
    if (name.endsWith('_concrete_powder')) return 'snare';
    if (name.endsWith('_terracotta')) return 'flute';
    return BELOW_BLOCK_INSTRUMENT[name] || 'harp';
  };

  // 音符盒乐器检测(Tuner.getInstrument 移植)
  const getInstrument = (x, y, z) => {
    const block = blockAt(x, y, z);
    if (!block || block.name !== 'note_block') return null;
    let inst = null;
    const p = safeProps(block);
    if (p) inst = String(p.instrument);
    if (!inst) return null;
    if (!st.cfg.instrumentDetectionWorkaround) {
      // 原版路径:乐器来自下方(头颅类来自上方);上方有方块遮挡则不可演奏
      if (!WORKS_ABOVE.has(inst)) {
        const above = blockAt(x, y + 1, z);
        if (above && above.name !== 'air') return null;
      }
      return inst;
    }
    // 变通路径:先看上方方块默认乐器(头颅类),再看下方方块
    const above = blockAt(x, y + 1, z);
    if (above && above.name !== 'air' && WORKS_ABOVE.has(instrumentOfBlock(above.name))) {
      return instrumentOfBlock(above.name);
    }
    const below = blockAt(x, y - 1, z);
    const bi = below ? instrumentOfBlock(below.name) : 'harp';
    if (WORKS_ABOVE.has(bi)) return 'harp';
    if (above && above.name !== 'air') return null; // 上方被堵住,不可演奏
    return bi;
  };

  // 音符盒当前音高(0-24);方块被换掉返回 null
  const currentNoteOf = (x, y, z) => {
    const block = blockAt(x, y, z);
    if (!block || block.name !== 'note_block') return null;
    const p = safeProps(block);
    return p ? parseInt(p.note, 10) : null;
  };

  // 手持可放置方块时,切到空手(否则右键调音会放置方块!)
  const ensureEmptyHand = () => {
    try {
      const held = bot.heldItem;
      if (!held || held.blockId == null) return; // 空手/非方块物品
      if (!bot.inventory || !Array.isArray(bot.inventory.slots)) return;
      const empty = bot.inventory.slots.slice(0, 9).findIndex(s => s === null);
      if (empty !== -1) bot.setQuickBarSlot(empty);
    } catch (e) { /* 忽略:装备失败不阻断播放 */ }
  };

  // ========== 调音器(Tuner.java 移植) ==========
  const tuner = st.tuner || (st.tuner = {
    noteBlocks: null,      // Map<instrument, Map<note, {x,y,z}>>
    missing: null,         // Map<blockName, count>
    tunedAfter: -1,
    predictions: new Map(),// posKey -> { note, expiry }
    lastInteractAt: -1,
    availableInteracts: 8,
    initialUntuned: -1,
    selectedSong: null,
    instrumentMap: new Map(), // 运行时乐器映射(orig -> mapped|null),不持久化
  });

  tuner.isTuned = () => !!tuner.selectedSong && tuner.tunedAfter !== -1 && tuner.tunedAfter <= Date.now();
  tuner.isSongSelected = () => !!(tuner.noteBlocks && tuner.missing && tuner.selectedSong);
  tuner.reset = () => { tuner.selectedSong = null; tuner.noteBlocks = null; tuner.missing = null; tuner.resetTuned(); };
  tuner.resetTuned = () => {
    tuner.noteBlocks = null;
    tuner.predictions.clear();
    tuner.tunedAfter = -1;
    tuner.initialUntuned = -1;
    tuner.availableInteracts = 0;
  };
  tuner.cleanup = () => {
    const now = Date.now();
    for (const [k, v] of tuner.predictions) if (v.expiry < now) tuner.predictions.delete(k);
  };

  // 选择歌曲:扫描周围音符盒,为每个所需音符挑选调音步数最少的方块(Tuner.selectSong 移植)
  tuner.selectSong = (song) => {
    tuner.reset();
    const eye = eyePos();
    if (!eye || !song || !bot.entity) return false;

    // 可交互距离内的偏移(0..maxOffset 正负),单次扫描按乐器分组(等价于模组 16×扫描)
    const maxOffset = Math.min(7, Math.ceil(4.5 + 1.0 + 1.0));
    const perInstrument = new Map(INSTRUMENTS.map(i => [i, []]));
    const offsets = [];
    for (let o = 0; o <= maxOffset; o++) { offsets.push(o); if (o !== 0) offsets.push(-o); }
    for (const y of offsets) {
      for (const x of offsets) {
        for (const z of offsets) {
          const bx = Math.floor(eye.x + x), by = Math.floor(eye.y + y), bz = Math.floor(eye.z + z);
          if (!canInteractWith({ x: bx, y: by, z: bz })) continue;
          const inst = getInstrument(bx, by, bz);
          if (inst && perInstrument.has(inst)) perInstrument.get(inst).push({ x: bx, y: by, z: bz });
        }
      }
    }

    // 乐器重映射(remapInstruments)
    if (tuner.instrumentMap.size) {
      for (const [orig, mapped] of tuner.instrumentMap) {
        if (mapped === null) perInstrument.set(orig, null); // 映射为 nothing
        else if (perInstrument.has(mapped)) perInstrument.set(orig, perInstrument.get(mapped));
      }
    }

    tuner.noteBlocks = new Map();
    const captured = [];
    for (const key of song.uniqueNotes) {
      const [idStr, noteStr] = key.split(',');
      const inst = INSTRUMENTS[Math.min(parseInt(idStr, 10), 15)]; // 经典乐器名(NBS 仅用 0-15)
      const wanted = parseInt(noteStr, 10);
      const available = perInstrument.get(inst);
      if (available === null) { // 该乐器被映射为 nothing,假装捕获但忽略
        captured.push(key);
        if (!tuner.noteBlocks.has(inst)) tuner.noteBlocks.set(inst, new Map());
        tuner.noteBlocks.get(inst).set(wanted, null);
        continue;
      }
      if (!available || available.length === 0) continue; // 缺该乐器方块
      let best = null, bestSteps = Infinity;
      for (const pos of available) {
        const current = currentNoteOf(pos.x, pos.y, pos.z);
        if (current === null) continue; // 方块已变化,跳过
        const steps = wanted >= current ? wanted - current : (25 - current) + wanted;
        if (steps < bestSteps) { best = pos; bestSteps = steps; }
      }
      if (best) {
        captured.push(key);
        available.splice(available.indexOf(best), 1); // 每个方块只分配一次
        if (!tuner.noteBlocks.has(inst)) tuner.noteBlocks.set(inst, new Map());
        tuner.noteBlocks.get(inst).set(wanted, best);
      }
    }

    // 缺失列表:blockName -> count
    tuner.missing = new Map();
    for (const key of song.uniqueNotes) {
      if (captured.includes(key)) continue;
      const [idStr] = key.split(',');
      const inst = INSTRUMENTS[Math.min(parseInt(idStr, 10), 15)];
      const mapped = tuner.instrumentMap.has(inst) ? tuner.instrumentMap.get(inst) : inst;
      if (mapped === null) continue; // 映射为 nothing 不报缺
      const blockName = INSTRUMENT_BLOCKS[mapped] || 'air';
      tuner.missing.set(blockName, (tuner.missing.get(blockName) || 0) + 1);
    }

    if (tuner.missing.size === 0) { tuner.selectedSong = song; return true; }
    return false;
  };

  // 调音循环:右键点击未调好的音符盒,每次点击音高 +1(循环 24→0)(Tuner.tickTuning 移植)
  tuner.tickTuning = () => {
    const now = Date.now();
    if (tuner.tunedAfter !== -1) return null; // 已完成调音
    if (!bot.entity) return 'NotIngame';
    if (!tuner.isSongSelected()) return 'NoSongSelected';
    let ping = Math.round(bot.latency || 0);
    if (ping <= 0) ping = 150;

    // 可用交互次数按调音速度恢复
    switch (st.cfg.tuningSpeed) {
      case 'Snail': tuner.availableInteracts = Math.min(1, tuner.availableInteracts + 0.5); break;
      case 'Safe': tuner.availableInteracts = 1; break;
      case 'Flash': tuner.availableInteracts = Infinity; break;
      default: { // Spigot:每 310ms 最多 9 次
        if (tuner.lastInteractAt === -1) tuner.availableInteracts = 9;
        else {
          tuner.availableInteracts += (now - tuner.lastInteractAt) / (310 / 9);
          tuner.availableInteracts = Math.max(0, Math.min(9, tuner.availableInteracts));
        }
      }
    }
    if (tuner.lastInteractAt === -1) tuner.lastInteractAt = now;

    let fullyTuned = 0, existingCount = 0;
    const untuned = new Map(); // posKey -> 当前音高
    for (const key of tuner.selectedSong.uniqueNotes) {
      const [idStr, noteStr] = key.split(',');
      const inst = INSTRUMENTS[Math.min(parseInt(idStr, 10), 15)];
      const wanted = parseInt(noteStr, 10);
      const blocks = tuner.noteBlocks.get(inst);
      if (!blocks) continue;
      const pos = blocks.get(wanted);
      if (!pos) continue;
      existingCount++;
      const current = currentNoteOf(pos.x, pos.y, pos.z);
      if (current === null) { tuner.noteBlocks = null; return null; } // 方块被换掉,重新选择
      const assumed = tuner.predictions.has(posKey(pos)) ? tuner.predictions.get(posKey(pos)).note : current;
      if (assumed === wanted && current === wanted) fullyTuned++;
      if (assumed !== wanted) {
        if (!canInteractWith(pos)) return 'MovedTooFarAway';
        untuned.set(posKey(pos), current);
      }
    }

    if (tuner.initialUntuned === -1 || tuner.initialUntuned < untuned.size) tuner.initialUntuned = untuned.size;
    if (untuned.size === 0 && fullyTuned === existingCount) {
      // 等一个往返延迟 + 100ms,确认服务器没有拒绝点击,再算调音完成
      if (tuner.lastInteractAt === -1 || now - tuner.lastInteractAt >= ping * 2 + 100) {
        tuner.tunedAfter = now + Math.max(0, st.cfg.delayPlaybackStartBySecs) * 1000;
        tuner.initialUntuned = -1;
      }
    }

    // 点击调音:优先点当前音高较高的方块(能更快升到目标音高)
    let lastTunedNote = -Infinity;
    let swung = false;
    while (tuner.availableInteracts >= 1 && untuned.size > 0) {
      let pickedKey = null, searches = 0;
      while (!pickedKey) {
        searches++;
        for (const [k, n] of untuned) if (n > lastTunedNote) { pickedKey = k; break; }
        if (!pickedKey) for (const [k, n] of untuned) if (n >= lastTunedNote) { pickedKey = k; break; }
        if (!pickedKey) lastTunedNote = -Infinity;
        if (!pickedKey && searches > 1) { pickedKey = untuned.keys().next().value; break; }
      }
      if (!pickedKey) return 'Unexpected';
      lastTunedNote = untuned.get(pickedKey);
      untuned.delete(pickedKey);
      const [px, py, pz] = pickedKey.split(',').map(Number);
      const assumed = tuner.predictions.has(pickedKey) ? tuner.predictions.get(pickedKey).note : (currentNoteOf(px, py, pz) ?? 0);
      tuner.predictions.set(pickedKey, { note: (assumed + 1) % 25, expiry: now + ping * 2 + 100 });
      // 右键音符盒(use_item_on):服务器收到后音高 +1
      bot._client.write('block_place', {
        hand: 0,
        location: { x: px, y: py, z: pz },
        direction: 1,
        cursorX: 0.5, cursorY: 0.5, cursorZ: 0.5,
        insideBlock: false,
        worldBorderHit: false,
        sequence: 0,
      });
      tuner.lastInteractAt = now;
      tuner.availableInteracts -= 1;
      swung = true;
    }
    if (swung) { try { bot.swingArm(); } catch (e) { /* 忽略 */ } } // swingArm 是同步函数,无返回值
    return null;
  };

  // ========== 播放器(SongPlayer.java 移植) ==========
  const rateLimiter = st.rateLimiter || (st.rateLimiter = createRateLimiter(() => st.cfg));
  const player = st.player || (st.player = {
    running: false, song: null, index: 0, tick: 0,
    lastPlaybackTickAt: -1, speed: 1,
    didSongReachEnd: false, loopSong: false,
    timer: null, warned: false, lastError: null,
  });

  player.start = (song) => {
    if (!st.cfg.hideWarning && !player.warned) {
      console.log('[disc-jockey] 警告:此模组可能被服务器误判为作弊,请先联系服务器管理员!(配置中可关闭此警告)');
      player.warned = true;
      return;
    }
    if (player.running) player.stop();
    player.tick = 0;
    player.index = 0;
    player.song = song;
    player.lastError = null;
    ensureEmptyHand(); // 手持方块会因右键放置而破坏音符盒
    if (!player.timer) player.timer = setInterval(() => tickPlayback(), 5); // 播放线程,常驻
    player.running = true;
    rateLimiter.reset();
    player.didSongReachEnd = false;
  };
  player.stop = () => {
    player.running = false;
    player.index = 0;
    player.tick = 0;
    rateLimiter.reset();
    tuner.reset();
    player.didSongReachEnd = false;
  };

  // 播放主循环(5ms):到期的音符 → 转身 + 击打(start_destroy + abort_destroy) + 挥手
  function tickPlayback() {
    if (!player.running) { player.lastPlaybackTickAt = -1; rateLimiter.reset(); return; }
    const previous = player.lastPlaybackTickAt;
    player.lastPlaybackTickAt = Date.now();
    rateLimiter.tick();
    tuner.cleanup();
    if (!tuner.isTuned()) return;

    while (player.running) {
      // 生存模式要求:creative 下击打会瞬间拆掉音符盒
      const gm = bot.game && bot.game.gameMode;
      if (!gm || gm !== 'survival') {
        player.lastError = `不能在 ${gm || 'unknown'} 模式下播放`;
        console.log(`[disc-jockey] ${player.lastError},已停止`);
        player.stop();
        return;
      }
      const note = player.song.notes[player.index];
      if (noteTick(note) > Math.round(player.tick)) break; // 还没到该音符

      const inst = INSTRUMENTS[Math.min(noteInstrumentId(note), 15)]; // 超界乐器按 pling 处理(模组会崩溃,这里不崩)
      const blocks = tuner.noteBlocks.get(inst);
      const pos = blocks ? blocks.get(noteNoteId(note)) : null;
      if (!pos) { player.index++; continue; } // 乐器映射为 nothing → 跳过

      if (!canInteractWith(pos)) {
        player.lastError = '您走得太远了';
        console.log(`[disc-jockey] ${player.lastError},已停止`);
        player.stop();
        return;
      }
      const eye = eyePos();
      if (!eye) { player.stop(); return; }
      // 朝向方块中心(模组 Vec3.upFromBottomCenterOf + atan2)
      const unitX = pos.x + 0.5 - eye.x, unitY = pos.y + 0.5 - eye.y, unitZ = pos.z + 0.5 - eye.z;
      const len = Math.sqrt(unitX * unitX + unitY * unitY + unitZ * unitZ) || 1;
      const yaw = wrapDegrees(Math.atan2(unitZ / len, unitX / len) * 57.2957763671875 - 90);
      const pitch = wrapDegrees(-(Math.atan2(unitY / len, Math.sqrt((unitX / len) ** 2 + (unitZ / len) ** 2)) * 57.2957763671875));

      if (rateLimiter.canSendLook()) {
        bot._client.write('look', {
          yaw, pitch,
          flags: { onGround: !!(bot.entity && bot.entity.onGround), hasHorizontalCollision: false },
        });
        rateLimiter.onLookSent();
      }
      if (rateLimiter.canSendAny()) {
        // 击打开始:触发音符盒发声;随后立刻取消挖掘,方块不会真的被挖掉
        bot._client.write('block_dig', { status: 0, location: pos, face: 1, sequence: 0 });
        rateLimiter.onPacketSent();
      }
      if (rateLimiter.canSendCosmetic()) {
        bot._client.write('block_dig', { status: 1, location: pos, face: 1, sequence: 0 });
        rateLimiter.onPacketSent();
      }
      if (rateLimiter.canSendSwing()) {
        try { bot.swingArm(); } catch (e) { /* 忽略 */ }
        rateLimiter.onSwingSent();
      }

      player.index++;
      if (player.index >= player.song.notes.length) {
        player.stop();
        player.didSongReachEnd = true;
        if (player.loopSong && tuner.selectSong(player.song)) player.start(player.song); // 循环:重新扫描并调音后继续
        break;
      }
    }

    if (player.running) { // 可能已被 stop(防止结束后仍有微小偏移)
      const elapsed = previous !== -1 && player.lastPlaybackTickAt !== -1 ? player.lastPlaybackTickAt - previous : 16;
      player.tick += millisecondsToTicks(player.song, elapsed) * player.speed;
    }
  }

  player.setSongElapsedSeconds = (seconds) => {
    if (!player.song) return;
    player.tick = millisecondsToTicks(player.song, Math.floor(seconds) * 1000); // 与模组 (long)seconds*1000 一致
    player.index = 0;
    for (let i = 0; i < player.song.notes.length; i++) {
      if (noteTick(player.song.notes[i]) >= Math.round(player.tick)) { player.index = i; break; }
    }
  };
  player.getSongElapsedSeconds = () => (player.song ? ticksToMilliseconds(player.song, player.tick) / 1000 : 0);
  player.getState = () => {
    if (!player.running) return player.didSongReachEnd ? 'finished' : (player.getSongElapsedSeconds() === 0 ? 'stopped' : 'paused');
    return tuner.isTuned() ? 'playing' : 'tuning';
  };

  // 找歌曲:先精确匹配 displayName,再匹配 fileName(网页/指令都可用)
  function findSong(name) {
    const q = String(name).trim();
    return st.songs.find(s => s.displayName === q) || st.songs.find(s => s.fileName === q) || null;
  }

  // ========== 游戏内指令(!dj,与模组 /discjockey 命令对应) ==========
  const djCmd = (username, args) => {
    const sub = (args[0] || '').toLowerCase();
    switch (sub) {
      case '': {
        reply(username, 'Disc Jockey: !dj play <歌曲> / random / stop / speed <x> / info / loop [yes|no] / reload / remapInstruments;选歌与配置请在网页面板进行');
        break;
      }
      case 'play': {
        const name = args.slice(1).join(' ');
        if (!name) return reply(username, '用法: !dj play <歌曲名>');
        const song = findSong(name);
        if (!song) return reply(username, `歌曲 '${name}' 不存在`);
        const r = tryStart(song);
        return reply(username, r.ok ? `开始播放 '${song.displayName}'` : r.error);
      }
      case 'random': {
        if (!st.songs.length) return reply(username, '没有歌曲');
        const song = st.songs[Math.floor(Math.random() * st.songs.length)];
        const r = tryStart(song);
        return reply(username, r.ok ? `开始播放 '${song.displayName}'` : r.error);
      }
      case 'stop': {
        if (!player.running) return reply(username, '没有播放任何歌曲');
        reply(username, `已停止播放 '${player.song.displayName}'`);
        return player.stop();
      }
      case 'speed': {
        const v = parseFloat(args[1]);
        if (isNaN(v) || v < 0.0001 || v > 15) return reply(username, '速度必须在 0.0001 ~ 15 之间');
        player.speed = v;
        return reply(username, `播放速度已更改为 ${v}`);
      }
      case 'info': {
        if (!player.running) return reply(username, `没有歌曲正在播放 (速度：${player.speed})`);
        if (!tuner.isTuned()) return reply(username, `正在调音：(速度：${player.speed})`);
        if (!player.didSongReachEnd) {
          return reply(username, `正在播放：[${fmtTime(player.getSongElapsedSeconds())}/${fmtTime(songLengthSeconds(player.song))}] ${player.song.displayName} (速度：${player.speed})`);
        }
        return reply(username, `已完成：${player.song.displayName} (速度：${player.speed})`);
      }
      case 'loop': {
        if (args[1] === undefined) return reply(username, `循环播放歌曲：${player.loopSong ? 'yes' : 'no'}`);
        if (args[1].toLowerCase() === 'yes') { player.loopSong = true; return reply(username, '已启用当前歌曲的循环播放。'); }
        if (args[1].toLowerCase() === 'no') { player.loopSong = false; return reply(username, '已禁用当前歌曲的循环播放。'); }
        return reply(username, '用法: !dj loop yes|no');
      }
      case 'reload': {
        st.songs = loadSongs();
        cleanupFavorites();
        return reply(username, `正在重新加载所有歌曲…(共 ${st.songs.length} 首)`);
      }
      case 'remapinstruments': return remapCmd(username, args.slice(1));
      default: return reply(username, `未知子命令 '${sub}' (!dj 查看用法)`);
    }
  };

  function remapCmd(username, args) {
    const sub = (args[0] || '').toLowerCase();
    const isInst = (s) => INSTRUMENTS.includes(s);
    switch (sub) {
      case '': return reply(username, '这会将乐器映射到由音符盒播放以替代不同的乐器。(map <原乐器|all> <新乐器|nothing> / unmap <乐器> / show / clear)');
      case 'map': {
        const orig = (args[1] || '').toLowerCase(), mapped = (args[2] || '').toLowerCase();
        if (orig !== 'all' && !isInst(orig)) return reply(username, `无效的乐器：${orig}`);
        if (mapped !== 'nothing' && !isInst(mapped)) return reply(username, `无效的乐器：${mapped}`);
        const newVal = mapped === 'nothing' ? null : mapped;
        if (orig === 'all') {
          for (const i of INSTRUMENTS) tuner.instrumentMap.set(i, newVal);
          return reply(username, `已将所有乐器映射到 ${mapped}`);
        }
        tuner.instrumentMap.set(orig, newVal);
        return reply(username, `已将 ${orig} 映射到 ${mapped}`);
      }
      case 'unmap': {
        const inst = (args[1] || '').toLowerCase();
        if (!isInst(inst)) return reply(username, `无效的乐器：${inst}`);
        tuner.instrumentMap.delete(inst);
        return reply(username, `已解除 ${inst} 的映射`);
      }
      case 'show': {
        if (!tuner.instrumentMap.size) return reply(username, '尚未映射任何乐器。');
        const list = [...tuner.instrumentMap].map(([k, v]) => `${k}->${v === null ? 'nothing' : v}`).join(', ');
        return reply(username, `已映射的乐器：${list}`);
      }
      case 'clear': {
        tuner.instrumentMap.clear();
        return reply(username, '乐器映射已清除。');
      }
      default: return reply(username, `未知子命令 '${sub}'`);
    }
  }

  // 开始播放:调音失败(缺方块)给出缺失列表
  function tryStart(song) {
    if (!bot.entity) return { ok: false, error: '机器人尚未进入世界' };
    player.stop(); // 先停旧播放(含清空旧调音),避免 selectSong 的调音被随后覆盖
    if (!tuner.selectSong(song)) {
      const miss = [...tuner.missing.entries()].map(([b, c]) => `${b} × ${c}`).join(', ');
      player.lastError = `您附近的音符盒配置不正确。缺少:${miss}`;
      return { ok: false, error: player.lastError };
    }
    player.start(song);
    return { ok: true };
  }

  commands.register({
    name: 'dj',
    permissionLevel: 1,
    description: 'Disc Jockey 音乐播放: !dj play <歌曲> / random / stop / speed / info / loop / reload / remapInstruments',
    execute: djCmd,
  });
  commands.register({
    name: 'discjockey',
    permissionLevel: 1,
    description: 'Disc Jockey 别名(同 !dj)',
    execute: djCmd,
  });

  // ========== 网页接口 ==========
  const sendJSON = (res, status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  const ok = (res, obj) => sendJSON(res, 200, { ok: true, ...obj });
  const fail = (res, status, msg) => sendJSON(res, status, { ok: false, error: msg });
  const wrap = (fn) => (req, res, url, body) => {
    try { return fn(req, res, url, body); } catch (err) {
      console.error('[disc-jockey] 接口错误:', err);
      return fail(res, 500, err.message);
    }
  };
  // web-manager 传的是 URL 对象(new URL(req.url, ...)),兼容字符串
  const getQuery = (url) => {
    const q = {};
    if (url instanceof URL) { url.searchParams.forEach((v, k) => { q[k] = v; }); return q; }
    const i = String(url).indexOf('?');
    if (i !== -1) new URLSearchParams(String(url).slice(i + 1)).forEach((v, k) => { q[k] = v; });
    return q;
  };

  const songSummary = (s) => ({
    fileName: s.fileName,
    displayName: s.displayName,
    name: s.name, author: s.author, originalAuthor: s.originalAuthor, description: s.description,
    tempo: s.tempo,
    lengthTicks: s.length,
    seconds: Math.round(songLengthSeconds(s) * 10) / 10,
    noteCount: s.notes.length,
    uniqueNotes: s.uniqueNotes.map(k => { const [i, n] = k.split(','); return { instrument: INSTRUMENTS[Math.min(parseInt(i, 10), 15)] || i, note: parseInt(n, 10) }; }),
    needsBlocks: (() => {
      const m = new Map();
      for (const [i, n] of s.uniqueNotes.map(k => k.split(','))) {
        const inst = INSTRUMENTS[Math.min(parseInt(i, 10), 15)] || i;
        const b = INSTRUMENT_BLOCKS[inst] || 'air';
        m.set(b, (m.get(b) || 0) + 1);
      }
      return [...m.entries()].map(([block, count]) => ({ block, count }));
    })(),
    favorite: st.cfg.favorites.includes(s.fileName),
  });

  const statusPayload = () => ({
    running: player.running,
    state: player.getState(),
    song: player.song ? player.song.displayName : null,
    elapsed: Math.round(player.getSongElapsedSeconds() * 10) / 10,
    length: player.song ? Math.round(songLengthSeconds(player.song) * 10) / 10 : 0,
    speed: player.speed,
    loop: player.loopSong,
    tuned: tuner.isTuned(),
    missing: tuner.missing ? [...tuner.missing.entries()].map(([b, c]) => ({ block: b, count: c })) : [],
    lastError: player.lastError,
    songCount: st.songs.length,
    gameMode: bot.game ? bot.game.gameMode : null,
  });

  const ep = (method, rel, fn) => webManager.registerEndpoint(method, `/api/plugins/${pluginName}/${rel}`, wrap(fn), pluginName);

  ep('GET', 'songs', (req, res, url) => {
    const q = getQuery(url);
    const qs = (q.q || '').toLowerCase().replace(/\s/g, '');
    let list = st.songs;
    if (qs) list = list.filter(s => !qs || s.searchableFileName.includes(qs) || s.searchableName.includes(qs));
    const favFirst = list.slice().sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || a.displayName.localeCompare(b.displayName));
    ok(res, { songs: favFirst.map(songSummary) });
  });

  ep('GET', 'status', (req, res) => ok(res, statusPayload()));

  ep('GET', 'play', (req, res, url) => {
    const song = findSong(getQuery(url).name || '');
    if (!song) return fail(res, 404, '歌曲不存在');
    const r = tryStart(song);
    if (!r.ok) return fail(res, 400, r.error);
    ok(res, { displayName: song.displayName });
  });

  ep('GET', 'stop', (req, res) => { player.stop(); ok(res); });
  ep('GET', 'random', (req, res) => {
    if (!st.songs.length) return fail(res, 400, '没有歌曲');
    const r = tryStart(st.songs[Math.floor(Math.random() * st.songs.length)]);
    if (!r.ok) return fail(res, 400, r.error);
    ok(res);
  });
  ep('GET', 'reload', (req, res) => {
    st.songs = loadSongs();
    cleanupFavorites();
    ok(res, { songCount: st.songs.length });
  });

  ep('POST', 'pause', (req, res, url, body) => {
    let run = false;
    try { run = !!(body && (JSON.parse(body).running)); } catch (e) { /* 忽略 */ }
    player.running = run;
    ok(res, { running: player.running });
  });
  ep('POST', 'seek', (req, res, url, body) => {
    let seconds = 0;
    try { seconds = Number(JSON.parse(body).seconds); } catch (e) { /* 忽略 */ }
    if (isNaN(seconds)) return fail(res, 400, 'seconds 必须为数字');
    player.setSongElapsedSeconds(Math.max(0, seconds));
    ok(res, { elapsed: player.getSongElapsedSeconds() });
  });
  ep('POST', 'speed', (req, res, url, body) => {
    let v = 1;
    try { v = Number(JSON.parse(body).speed); } catch (e) { /* 忽略 */ }
    if (isNaN(v) || v < 0.0001 || v > 15) return fail(res, 400, '速度必须在 0.0001 ~ 15 之间');
    player.speed = v;
    ok(res, { speed: player.speed });
  });
  ep('POST', 'loop', (req, res, url, body) => {
    let l = false;
    try { l = !!JSON.parse(body).loop; } catch (e) { /* 忽略 */ }
    player.loopSong = l;
    ok(res, { loop: player.loopSong });
  });
  ep('POST', 'favorite', (req, res, url, body) => {
    let fileName = '', fav = false;
    try { const b = JSON.parse(body); fileName = b.fileName; fav = !!b.favorite; } catch (e) { /* 忽略 */ }
    const song = st.songs.find(s => s.fileName === fileName);
    if (!song) return fail(res, 404, '歌曲不存在');
    const i = st.cfg.favorites.indexOf(fileName);
    if (fav && i === -1) st.cfg.favorites.push(fileName);
    if (!fav && i !== -1) st.cfg.favorites.splice(i, 1);
    saveCfg();
    ok(res, { favorite: fav });
  });

  // 配置读写(网页保存后立即生效,无需重载插件)
  ep('GET', 'config', (req, res) => ok(res, { config: st.cfg }));
  ep('PUT', 'config', (req, res, url, body) => {
    let patch = {};
    try { patch = JSON.parse(body); } catch (e) { return fail(res, 400, '无效 JSON'); }
    if (patch.expectedServerVersion && !ENUMS.expectedServerVersion.includes(patch.expectedServerVersion)) return fail(res, 400, `expectedServerVersion 必须是 ${ENUMS.expectedServerVersion.join('/')}`);
    if (patch.tuningSpeed && !ENUMS.tuningSpeed.includes(patch.tuningSpeed)) return fail(res, 400, `tuningSpeed 必须是 ${ENUMS.tuningSpeed.join('/')}`);
    if (patch.playbackPacketRatelimit && !ENUMS.playbackPacketRatelimit.includes(patch.playbackPacketRatelimit)) return fail(res, 400, `playbackPacketRatelimit 必须是 ${ENUMS.playbackPacketRatelimit.join('/')}`);
    st.cfg = { ...st.cfg, ...patch };
    saveCfg();
    ok(res, { config: st.cfg });
  });

  // 乐器映射(运行时,不持久化,与模组一致)
  ep('GET', 'instruments', (req, res) => ok(res, { map: Object.fromEntries([...tuner.instrumentMap].map(([k, v]) => [k, v === null ? 'nothing' : v])) }));
  ep('PUT', 'instruments', (req, res, url, body) => {
    let map = {};
    try { map = JSON.parse(body).map || {}; } catch (e) { return fail(res, 400, '无效 JSON'); }
    tuner.instrumentMap.clear();
    for (const [k, v] of Object.entries(map)) {
      if (!INSTRUMENTS.includes(k)) return fail(res, 400, `无效的乐器:${k}`);
      if (v === 'nothing' || v === null) tuner.instrumentMap.set(k, null);
      else if (INSTRUMENTS.includes(v)) tuner.instrumentMap.set(k, v);
      else return fail(res, 400, `无效的乐器:${v}`);
    }
    ok(res, { map: Object.fromEntries([...tuner.instrumentMap].map(([k, v]) => [k, v === null ? 'nothing' : v])) });
  });

  // 上传 .nbs(原始字节 body,文件名在 ?name=)
  ep('POST', 'upload', (req, res, url, body) => {
    const name = (getQuery(url).name || '').replace(/[\\/]/g, '').trim();
    if (!name || !name.toLowerCase().endsWith('.nbs')) return fail(res, 400, '需要 ?name=xxx.nbs');
    if (st.songs.some(s => s.fileName.toLowerCase() === name.toLowerCase())) return fail(res, 400, `歌曲 '${name}' 已存在`);
    if (!body || !body.length) return fail(res, 400, 'body 为空');
    fs.writeFileSync(path.join(songsDir, name), Buffer.from(body, 'utf8'));
    st.songs = loadSongs();
    cleanupFavorites();
    ok(res, { fileName: name, songCount: st.songs.length });
  });

  // 删除歌曲
  ep('POST', 'delete', (req, res, url, body) => {
    let fileName = '';
    try { fileName = JSON.parse(body).fileName; } catch (e) { /* 忽略 */ }
    const song = st.songs.find(s => s.fileName === fileName);
    if (!song) return fail(res, 404, '歌曲不存在');
    const target = path.join(songsDir, song.fileName);
    if (!target.startsWith(songsDir + path.sep)) return fail(res, 400, '非法路径');
    fs.unlinkSync(target);
    st.songs = loadSongs();
    cleanupFavorites();
    ok(res, { fileName: song.fileName });
  });

  // 网页面板(HTML,iframe 内嵌)
  ep('GET', 'panel', (req, res) => {
    const htmlFile = path.join(__dirname, 'panel.html');
    if (!fs.existsSync(htmlFile)) return fail(res, 404, '面板文件不存在');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(htmlFile, 'utf8'));
  });

  webManager.registerTile({
    name: pluginName,
    title: 'Disc Jockey',
    description: 'NBS 音乐播放(音符盒):选歌、播放控制、配置均在面板中',
    panel: `/api/plugins/${pluginName}/panel`,
    endpoints: {},
  });

  // 播放循环每 5ms 由 state 中的 timer 驱动;调音在 bot tick 上驱动
  if (!bot._discJockeyTick) {
    bot._discJockeyTick = true;
    const tickTimer = setInterval(() => {
      if (tuner.isSongSelected() && !tuner.isTuned() && player.running) tuner.tickTuning();
    }, 50);
    // 定时器不阻止进程退出,也不需要清理(生命周期与进程一致)
    if (tickTimer.unref) tickTimer.unref();
  }

  console.log(`[disc-jockey] 已加载 ${st.songs.length} 首歌曲;网页面板: http://127.0.0.1:${(config && config.webManager && config.webManager.port) || 8123}/ (Disc Jockey 磁贴 -> 打开面板)`);
};
