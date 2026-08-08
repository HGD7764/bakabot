const fisherPlugin = require('../plugins/fisher/index.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeRod(durabilityUsed, maxDurability = 64) {
  return { name: 'fishing_rod', durabilityUsed, maxDurability };
}

// bot 模拟：fish() 可自动上钩(catchDelay)或挂起等取消；activateItem 取消进行中的 fish
function makeBot(rod, catchDelay = 100) {
  const calls = { fish: 0, activateItem: 0, equip: 0 };
  let fishReject = null, catchTimer = null;
  return {
    entity: { position: {} },
    heldItem: null,
    inventory: { items: () => (rod ? [rod] : []) },
    async equip(item) { calls.equip++; this.heldItem = item; },
    fish() {
      calls.fish++;
      return new Promise((resolve, reject) => {
        fishReject = reject;
        catchTimer = setTimeout(() => {
          catchTimer = null;
          if (rod) rod.durabilityUsed += 1; // 模拟服务器收竿后更新耐久
          resolve();
        }, catchDelay);
      });
    },
    activateItem() {
      calls.activateItem++;
      if (catchTimer) { clearTimeout(catchTimer); catchTimer = null; }
      if (fishReject) { fishReject(new Error('Fishing cancelled')); fishReject = null; }
    },
    whisper() {},
    _calls: calls,
  };
}

function load(cfg = {}) {
  const ctx = { bot: null, commands: [], tiles: [], state: {} };
  const registry = [];
  const webManager = { registerTile: (t) => ctx.tiles.push(t) };
  return {
    ctx,
    registry,
    load(bot) {
      ctx.bot = bot;
      fisherPlugin({ bot, commands: { register: (c) => registry.push(c) }, pluginConfig: cfg, pluginName: 'fisher', webManager, state: ctx.state });
    },
    cmd(name) { return registry.find((c) => c.name === name); },
  };
}

(async () => {
  // ---- 场景 A: 耐久 63/64,钓一条后耐久耗尽 → 自动停止 ----
  const A = load({ castTimeoutMs: 5000 });
  A.load(makeBot(makeRod(63, 64), 80));
  A.cmd('fish').execute('tester');
  console.log('--- A: 耐久 63/64 ---');
  console.log('start 后 running:', A.ctx.state.fisher.running, '(期望 true)');
  await sleep(250); // 第一竿上钩(耐久→64)
  console.log('第一竿后: catches =', A.ctx.state.fisher.stats.catches, '(期望 1)');
  await sleep(800); // 等循环内 600ms 后检查耐久的自动停止
  const sA = A.ctx.state.fisher;
  console.log('最终: running =', sA.running, '(期望 false) | 原因 =', sA.stats.stoppedReason, '(期望 鱼竿耐久耗尽) | casts =', sA.stats.casts, '(期望 1)');

  // ---- 场景 B: 背包无鱼竿 → 拒绝 ----
  const B = load();
  B.load(makeBot(null));
  B.cmd('fish').execute('tester');
  await sleep(150);
  console.log('--- B: 无鱼竿 ---');
  console.log('running =', B.ctx.state.fisher.running, '(期望 false) | fish 调用 =', B.ctx.bot._calls.fish, '(期望 0)');

  // ---- 场景 C: 抛竿挂起中 !stopfish → 收竿取消,循环退出 ----
  const C = load({ castTimeoutMs: 5000 });
  C.load(makeBot(makeRod(10, 64), 30000)); // 30s 不上钩,模拟挂起
  C.cmd('fish').execute('tester');
  await sleep(250); // 第一竿已抛出
  console.log('--- C: 挂起中停止 ---');
  console.log('抛竿中: inCast =', C.ctx.state.fisher.inCast, '(期望 true) | fish 调用 =', C.ctx.bot._calls.fish, '(期望 1)');
  C.cmd('stopfish').execute('tester');
  await sleep(250);
  const sC = C.ctx.state.fisher;
  console.log('停止后: running =', sC.running, '(期望 false) | activateItem(收竿) =', C.ctx.bot._calls.activateItem, '| loop =', sC.loop, '(期望 null)');

  // ---- 场景 F: 停止后再 !fish → 应开新循环继续钓（修复前 loop 残留导致不再钓）----
  const F = load({ castTimeoutMs: 5000 });
  F.load(makeBot(makeRod(10, 64), 30000)); // 挂起,便于停止
  F.cmd('fish').execute('tester');
  await sleep(250);
  F.cmd('stopfish').execute('tester');
  await sleep(300);
  console.log('--- F: 停止后重启 ---');
  console.log('停止后 loop =', F.ctx.state.fisher.loop, '(期望 null) | fish 调用 =', F.ctx.bot._calls.fish, '(期望 1)');
  F.cmd('fish').execute('tester'); // 重新开始
  await sleep(300);
  console.log('重启后: running =', F.ctx.state.fisher.running, '(期望 true) | loop =', F.ctx.state.fisher.loop ? '存在' : 'null', '(期望 存在) | fish 调用 =', F.ctx.bot._calls.fish, '(期望 2)');

  // ---- 场景 D: 正常连钓 2 条（单条循环 ≈ 150+80+600 ≈ 830ms）----
  const D = load({ castTimeoutMs: 5000 });
  D.load(makeBot(makeRod(10, 64), 80));
  D.cmd('fish').execute('tester');
  await sleep(1400);
  const sD = D.ctx.state.fisher;
  console.log('--- D: 连钓 ---');
  console.log('running =', sD.running, '(期望 true) | catches =', sD.stats.catches, '(期望 2) | casts =', sD.stats.casts, '(期望 2) | 鱼竿剩余 =', D.ctx.bot.heldItem.maxDurability - D.ctx.bot.heldItem.durabilityUsed);

  // ---- 场景 E: 网页磁贴/端点 ----
  const E = load();
  E.load(makeBot(makeRod(5, 64), 30000));
  E.cmd('fish').execute('tester');
  console.log('--- E: 网页端点 ---');
  console.log('磁贴:', E.ctx.tiles[0].title, '| 端点:', Object.keys(E.ctx.tiles[0].endpoints).join(', '));
  const res = { writeHead() {}, end(body) { console.log('/status 响应:', body); } };
  E.ctx.tiles[0].endpoints['/status'].handler({}, res, new URL('http://x/status'));
  E.ctx.tiles[0].endpoints['/stop'].handler({}, { writeHead() {}, end(body) { console.log('/stop 响应:', body); } }, new URL('http://x/stop'));
  await sleep(200);
  console.log('停止后 running =', E.ctx.state.fisher.running, '(期望 false)');

  process.exit(0);
})();
