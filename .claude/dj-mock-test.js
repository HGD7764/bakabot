// =============================================================================
// disc-jockey 插件 Mock 测试:不需要真实服务器。
//  - 构造新旧两种格式的 .nbs 文件 → 验证解析
//  - 伪造 bot 世界(3 个 harp 音符盒)+ 可控时钟 → 验证 选歌→调音→播放 的
//    look / block_dig / swing / block_place 数据包序列
// 运行: node .claude/dj-mock-test.js
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

const SONGS_DIR = path.join(__dirname, '..', 'plugins', 'disc-jockey', 'songs');
fs.mkdirSync(SONGS_DIR, { recursive: true });

// ---------- 可控时钟 ----------
const clock = { t: 0 };
Date.now = () => clock.t;
// 用 hrtime 走真实时间轴(Windows 上 setInterval 精度只有 ~15.6ms,不能直接当毫秒钟)
const clockBase = process.hrtime.bigint();
const clockTimer = setInterval(() => { clock.t = Number(process.hrtime.bigint() - clockBase) / 1e6; }, 1);

// ---------- NBS 写入器(小端,与模组 SongLoader 相同的读取顺序) ----------
function intStr(s) { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(4); l.writeInt32LE(b.length, 0); return Buffer.concat([l, b]); }
function u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; }
function i16(v) { const b = Buffer.alloc(2); b.writeInt16LE(v); return b; }
function i8(v) { return Buffer.from([v & 0xFF]); }
function i32(v) { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; }

// notes: [{tick, layer, instrument, key}] (key = 文件里的 key,即音高+33)
function writeNbs(fileName, { newFormat, length, height = 1, name, tempo, notes }) {
  const hdr = [];
  if (newFormat) {
    hdr.push(u16(0), i8(5), i8(16), u16(length));
  } else {
    hdr.push(u16(length));
  }
  hdr.push(
    i16(height), intStr(name), intStr('author'), intStr(''), intStr(''),
    i16(tempo), i8(0), i8(0), i8(4),
    i32(0), i32(0), i32(0), i32(0), i32(0), intStr('')
  );
  if (newFormat) hdr.push(i8(0), i8(0), i16(0));

  const noteBuf = [];
  let prevTick = -1;
  for (const grp of notes) { // grp = {tick, layers:[{layer, instrument, key}]}
    noteBuf.push(i16(grp.tick - prevTick));
    prevTick = grp.tick;
    let prevLayer = -1;
    for (const n of grp.layers) {
      noteBuf.push(i16(n.layer - prevLayer));
      prevLayer = n.layer;
      noteBuf.push(i8(n.instrument), i8(n.key));
      if (newFormat) noteBuf.push(i8(100), i8(100), i16(0)); // velocity / panning / pitch
    }
    noteBuf.push(i16(0)); // 结束该 tick
  }
  noteBuf.push(i16(0)); // 结束所有 notes

  // 真实文件会附带 layer 信息(解析器读到 tick jump 0 即停,不影响)
  const layerInfo = [];
  for (let l = 0; l < height; l++) layerInfo.push(intStr('Layer ' + (l + 1)), i8(100), i8(100));

  const buf = Buffer.concat([...hdr, ...noteBuf, ...layerInfo, i8(0)]);
  fs.writeFileSync(path.join(SONGS_DIR, fileName), buf);
  return buf;
}

// ---------- 测试歌曲 ----------
// 新格式: 3 个 harp 音符, tick 0/8/16, 音高 0/12/24
writeNbs('test.nbs', {
  newFormat: true, length: 32, name: 'Test Song', tempo: 30000,
  notes: [
    { tick: 0, layers: [{ layer: 0, instrument: 0, key: 33 + 0 }] },
    { tick: 8, layers: [{ layer: 0, instrument: 0, key: 33 + 12 }] },
    { tick: 16, layers: [{ layer: 0, instrument: 0, key: 33 + 24 }] },
  ],
});
// 旧格式: 1 个音符(无 velocity/panning/pitch)
writeNbs('test-old.nbs', {
  newFormat: false, length: 16, name: 'Old Song', tempo: 1000,
  notes: [{ tick: 0, layers: [{ layer: 0, instrument: 2, key: 33 + 5 }] }],
});
// 需要 bass 音符盒的歌曲(用于缺失测试)
writeNbs('test-bass.nbs', {
  newFormat: true, length: 16, name: 'Bass Song', tempo: 1000,
  notes: [{ tick: 0, layers: [{ layer: 0, instrument: 1, key: 33 + 5 }] }],
});

// ---------- 伪造世界 ----------
const world = new Map(); // key `${x},${y},${z}` -> {name, props}
function setBlock(x, y, z, name, props) { world.set(`${x},${y},${z}`, { name, getProperties: () => props }); }
// 3 个 harp 音符盒(互不遮挡): 音高 0 / 12 / 24
const BLOCKS = [[2, 1, 0, 0], [2, 1, 2, 12], [2, 1, -2, 24]];
for (const [x, y, z, note] of BLOCKS) setBlock(x, y, z, 'note_block', { instrument: 'harp', note: String(note) });

// ---------- 伪造 bot ----------
const sent = []; // 记录所有 _client.write
const bot = {
  entity: { position: { x: 0, y: 0, z: 0 }, onGround: true },
  game: { gameMode: 'survival' },
  latency: 150,
  heldItem: null,
  inventory: { slots: new Array(36).fill(null) },
  swingArm: () => { sent.push({ name: 'swing' }); }, // 与 mineflayer 4.37 一致:同步函数,返回 undefined
  setQuickBarSlot: () => {},
  whisper: () => {},
  blockAt: (pos) => {
    // 模拟 prismarine-world 的契约: getBlock 要求 Vec3(带 .floored())
    if (typeof pos.floored !== 'function') throw new TypeError('pos.floored is not a function');
    return world.get(`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`)
      || { name: 'air', getProperties: () => null };
  },
  _client: { write: (name, data) => sent.push({ name, data }) },
};

// ---------- 伪造 context ----------
const commands = [];
const endpoints = new Map();
const tiles = [];
const context = {
  bot,
  config: {},
  state: {},
  commands: { register: (d) => commands.push(d) },
  webManager: {
    registerEndpoint: (method, p, handler) => endpoints.set(`${method} ${p}`, handler),
    registerTile: (d) => tiles.push(d),
  },
  pluginName: 'disc-jockey',
};

require('../plugins/disc-jockey/index.js')(context);

const st = context.state.discJockey;
const p = st.player;
const tuner = st.tuner;

const res = (status, body) => { res.status = status; res.body = body; return res; };
let mockRes = { writeHead: (s, h) => { mockRes.status = s; }, end: (b) => { mockRes.body = b; } };
const call = (method, rel, url, body) => {
  mockRes = { writeHead: (s, h) => { mockRes.status = s; }, end: (b) => { mockRes.body = b; } };
  const h = endpoints.get(`${method} /api/plugins/disc-jockey/${rel}`);
  // 与 web-manager 一致:传 URL 对象而非字符串
  h(null, mockRes, new URL(`/api/plugins/disc-jockey/${rel}${url ? '?' + url : ''}`, 'http://localhost'), body || null);
  return JSON.parse(mockRes.body || '{}');
};

let failed = 0;
const assert = (cond, msg) => {
  if (cond) { console.log('  ✓ ' + msg); }
  else { console.log('  ✗ FAIL: ' + msg); failed++; }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  // ---------- 1. 解析:新格式 ----------
  console.log('\n[1] NBS 解析(新格式)');
  let r = call('GET', 'songs', '');
  const songs = r.songs;
  const t = songs.find(s => s.fileName === 'test.nbs');
  assert(!!t, 'test.nbs 被加载');
  assert(t.displayName === 'Test Song (test.nbs)', 'displayName 拼接正确: ' + t.displayName);
  assert(t.tempo === 30000, 'tempo=30000');
  assert(t.lengthTicks === 32, 'length=32 ticks');
  assert(t.noteCount === 3, '3 个音符');
  assert(t.uniqueNotes.length === 3, '3 个 uniqueNotes');
  assert(t.uniqueNotes[1].instrument === 'harp' && t.uniqueNotes[1].note === 12, 'uniqueNotes[1] = harp/12');
  assert(t.needsBlocks.length === 1 && t.needsBlocks[0].block === 'air' && t.needsBlocks[0].count === 3, '需要 3×air(air=harp)');

  // ---------- 2. 解析:旧格式 ----------
  console.log('\n[2] NBS 解析(旧格式)');
  const o = songs.find(s => s.fileName === 'test-old.nbs');
  assert(!!o, 'test-old.nbs 被加载');
  assert(o.tempo === 1000 && o.lengthTicks === 16 && o.noteCount === 1, '旧格式字段正确');
  assert(o.uniqueNotes[0].instrument === 'basedrum' && o.uniqueNotes[0].note === 5, '旧格式乐器/音高正确(instrument 2 → basedrum, key 38-33=5)');

  // ---------- 3. 选歌 + 调音 + 播放 ----------
  console.log('\n[3] 播放 test.nbs(选歌→调音→击打)');
  // 第一次播放被警告拦截(与模组一致:显示警告,不播放)
  r = call('GET', 'play', 'name=test.nbs');
  assert(r.ok === true && p.running === false, '首次播放被警告拦截(与模组一致)');
  // 第二次正常开始
  sent.length = 0;
  r = call('GET', 'play', 'name=test.nbs');
  assert(r.ok === true, 'play 返回 ok');
  assert(p.running === true, 'player.running');
  assert(tuner.isSongSelected(), '歌曲已选中');
  assert(tuner.missing.size === 0, '无缺失方块');
  assert(tuner.noteBlocks.get('harp').size === 3, '3 个 harp 方块已分配');
  assert(sent.every(s => s.name !== 'block_dig'), '调音完成前没有击打数据包');

  // 等调音完成(ping*2+100=400ms)+ 播放 3 个音符
  await sleep(900);
  const digs = sent.filter(s => s.name === 'block_dig');
  const starts = digs.filter(d => d.data.status === 0);
  const aborts = digs.filter(d => d.data.status === 1);
  assert(starts.length >= 3, `3 次 START_DESTROY_BLOCK,实际 ${starts.length}`);
  assert(aborts.length >= 3, `3 次 ABORT_DESTROY_BLOCK,实际 ${aborts.length}`);
  const dugPos = new Set(starts.map(d => `${d.data.location.x},${d.data.location.y},${d.data.location.z}`));
  for (const [x, y, z] of [[2,1,0],[2,1,2],[2,1,-2]]) {
    assert(dugPos.has(`${x},${y},${z}`), `击打过 (${x},${y},${z})`);
  }
  const looks = sent.filter(s => s.name === 'look');
  // 3 个音符在 ~60ms 内连发,look/swing 受模组限速(50ms 间隔),能发几个看调度
  assert(looks.length >= 1, `≥1 次 look,实际 ${looks.length}`);
  assert(looks.every(l => typeof l.data.yaw === 'number' && typeof l.data.pitch === 'number'), 'look 带 yaw/pitch');
  assert(looks.every(l => l.data.flags && l.data.flags.onGround === true && l.data.flags.hasHorizontalCollision === false), 'look 带 MovementFlags bitfield');
  assert(digs.every(d => d.data.face === 1 && d.data.sequence === 0), 'block_dig face=UP(1) sequence=0');
  assert(sent.filter(s => s.name === 'swing').length >= 1, '有挥手包');
  assert(p.getState() === 'finished', '播放完毕状态');
  assert(sent.every(s => s.name !== 'block_place'), '播放时无 block_place(调音才用)');

  // ---------- 4. 缺失方块 ----------
  console.log('\n[4] 缺方块 → 播放失败');
  r = call('GET', 'play', 'name=test-bass.nbs');
  assert(r.ok === false, 'play 返回失败');
  assert(/缺少/.test(r.error), '错误含缺少列表: ' + r.error);
  assert(p.running === false, '未开始播放');

  // ---------- 5. 调音数据包(block_place) ----------
  console.log('\n[5] 调音(把 12 号的音符盒当作音高 0 的来调)');
  // 世界里的 (2,1,2) 是 12,手动改成 0 模拟需要调音
  setBlock(2, 1, 2, 'note_block', { instrument: 'harp', note: '0' });
  sent.length = 0;
  r = call('GET', 'play', 'name=test.nbs');
  assert(r.ok === true, 'play 返回 ok');
  await sleep(200); // Flash 调音 + 预测
  // 调音速度 Spigot:9 次/310ms;这次只有 1 个需要调(0→12)
  const places = sent.filter(s => s.name === 'block_place');
  assert(places.length >= 1, `发出 ≥1 次调音点击,实际 ${places.length}`);
  if (places.length) {
    assert(places[0].data.hand === 0, 'block_place hand=main');
    assert(places[0].data.direction === 1, 'block_place direction=UP');
    assert(places[0].data.cursorX === 0.5 && places[0].data.cursorY === 0.5 && places[0].data.cursorZ === 0.5, 'block_place 瞄准方块中心');
    assert(places[0].data.location.x === 2 && places[0].data.location.y === 1 && places[0].data.location.z === 2, '调音目标 (2,1,2)');
    assert(places[0].data.insideBlock === false && places[0].data.worldBorderHit === false, 'block_place insideBlock/worldBorderHit=false');
    assert(places[0].data.sequence === 0, 'block_place sequence=0');
  }
  assert(tuner.predictions.size >= 1, '有音高预测');
  p.stop();

  // ---------- 6. 指令 ----------
  console.log('\n[6] 指令注册与执行');
  assert(commands.some(c => c.name === 'dj'), '注册了 !dj');
  assert(commands.some(c => c.name === 'discjockey'), '注册了 !discjockey');
  const dj = commands.find(c => c.name === 'dj');
  const replies = [];
  bot.whisper = (u, m) => replies.push(m);
  r = call('GET', 'play', 'name=test.nbs'); // 重新开始
  await sleep(100);
  dj.execute('tester', ['info']);
  assert(replies.some(m => /正在播放|调音/.test(m)), 'info 返回播放信息: ' + JSON.stringify(replies[replies.length - 1]));
  dj.execute('tester', ['speed', '2']);
  assert(p.speed === 2, 'speed=2');
  dj.execute('tester', ['loop', 'yes']);
  assert(p.loopSong === true, 'loop=yes');
  dj.execute('tester', ['stop']);
  assert(p.running === false, 'stop 停止');
  assert(replies.some(m => /已停止/.test(m)), 'stop 回复');
  dj.execute('tester', ['play', '不存在的歌']);
  assert(replies.some(m => /不存在/.test(m)), '不存在歌曲提示');
  dj.execute('tester', ['random']);
  assert(replies.some(m => /开始播放|配置不正确/.test(m)), 'random 有回复(成功或缺方块都算): ' + replies[replies.length - 1]);
  dj.execute('tester', ['reload']);
  assert(replies.some(m => /重新加载/.test(m)), 'reload 回复');
  dj.execute('tester', []);
  assert(replies.some(m => /remapInstruments|Disc Jockey/.test(m)), '帮助信息: ' + replies[replies.length - 1]);

  // ---------- 7. 网页配置 ----------
  console.log('\n[7] 配置接口');
  r = call('GET', 'config', '');
  assert(r.config.tuningSpeed === 'Spigot', '默认 tuningSpeed=Spigot');
  r = call('PUT', 'config', '', JSON.stringify({ tuningSpeed: 'Flash', delayPlaybackStartBySecs: 1 }));
  assert(r.ok && r.config.tuningSpeed === 'Flash', 'PUT 配置生效');
  assert(st.cfg.tuningSpeed === 'Flash', '运行时配置同步');
  assert(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugins', 'disc-jockey', 'config.json'), 'utf8')).tuningSpeed === 'Flash', '写入磁盘');
  r = call('PUT', 'config', '', JSON.stringify({ tuningSpeed: 'Bad' }));
  assert(r.ok === false, '非法枚举被拒绝');
  r = call('PUT', 'config', '', JSON.stringify({ tuningSpeed: 'Spigot', delayPlaybackStartBySecs: 0 }));
  assert(r.ok, '恢复配置');

  // ---------- 8. 乐器映射 ----------
  console.log('\n[8] 乐器映射');
  r = call('PUT', 'instruments', '', JSON.stringify({ map: { harp: 'bass', pling: 'nothing' } }));
  assert(r.ok && r.map.harp === 'bass' && r.map.pling === 'nothing', '映射 harp→bass, pling→nothing');
  r = call('GET', 'instruments', '');
  assert(r.map.pling === 'nothing', 'GET 映射');
  r = call('PUT', 'instruments', '', JSON.stringify({ map: { harp: 'notaninst' } }));
  assert(r.ok === false, '非法乐器被拒绝');

  // ---------- 9. seek / pause ----------
  console.log('\n[9] seek / pause');
  r = call('POST', 'pause', '', JSON.stringify({ running: false }));
  assert(r.running === false && p.running === false, 'pause');
  r = call('POST', 'seek', '', JSON.stringify({ seconds: 8 }));
  assert(r.ok && Math.abs(r.elapsed - 8) < 0.6, 'seek 到 8s,实际 ' + r.elapsed);
  assert(p.getState() === 'paused', '状态 paused');
  r = call('POST', 'pause', '', JSON.stringify({ running: true }));
  assert(p.running === true, 'resume');

  // ---------- 10. 面板 ----------
  console.log('\n[10] 面板');
  mockRes = { writeHead: (s) => { mockRes.status = s; }, end: (b) => { mockRes.body = b; } };
  endpoints.get('GET /api/plugins/disc-jockey/panel')(null, mockRes, '/api/plugins/disc-jockey/panel', null);
  assert(mockRes.status === 200 && String(mockRes.body).includes('Disc Jockey'), 'panel.html 可访问');
  const tile = tiles.find(t => t.name === 'disc-jockey');
  assert(tile && tile.panel === '/api/plugins/disc-jockey/panel', 'registerTile 带 panel 路径');

  // ---------- 收尾 ----------
  p.stop();
  clearInterval(clockTimer);
  clearInterval(p.timer);
  fs.rmSync(path.join(SONGS_DIR, 'test.nbs'), { force: true });
  fs.rmSync(path.join(SONGS_DIR, 'test-old.nbs'), { force: true });
  fs.rmSync(path.join(SONGS_DIR, 'test-bass.nbs'), { force: true });

  console.log('\n========================================');
  console.log(failed === 0 ? '全部通过 ✓' : `${failed} 项失败 ✗`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => {
  console.error('测试崩溃:', err);
  clearInterval(clockTimer);
  process.exit(1);
});
