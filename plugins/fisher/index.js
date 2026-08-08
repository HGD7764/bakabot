// plugins/fisher/index.js
// 自动钓鱼插件：
//   - 自动抛竿（bot.fish）→ 等鱼上钩（粒子判定，mineflayer fishing 插件自动收竿）→ 循环
//   - 单次抛竿超时（castTimeoutMs）自动收竿重抛，防止服务器不发粒子时无限挂起
//   - 鱼竿耐久耗尽自动停止（durabilityUsed >= maxDurability，或鱼竿消失/不在手上）
//   - 控制：网页磁贴（全部端点 GET）+ 游戏内 !fish / !stopfish 指令
//   - 重载安全：运行状态放 context.state.fisher，网页重载插件不打断钓鱼循环
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = (context) => {
  const { bot, commands, pluginConfig, pluginName, webManager } = context;

  const cfg = {
    castTimeoutMs: 120000, // 单次抛竿最长等待，超时收竿重抛
    ...(pluginConfig || {}),
  };

  // ---- 共享状态（跨重载存活）----
  const fisher = context.state.fisher || (context.state.fisher = {
    running: false,   // 是否在自动钓鱼
    inCast: false,    // 当前是否有鱼线在水里（停止时需收竿）
    loop: null,       // 钓鱼循环 promise（避免重载后重复启动）
    stats: { casts: 0, catches: 0, timeouts: 0, stoppedReason: null },
  });

  const log = (msg) => console.log(`[fisher] ${msg}`);

  // 背包里的鱼竿
  const inventoryRod = () => bot.inventory.items().find((i) => i.name === 'fishing_rod');
  // 鱼竿是否已耗尽耐久（读不到耐久数据时不拦截）
  const isBroken = (item) => {
    if (!item || item.name !== 'fishing_rod') return true;
    const { durabilityUsed, maxDurability } = item;
    if (durabilityUsed == null || maxDurability == null) return false;
    return durabilityUsed >= maxDurability;
  };

  const statusInfo = () => {
    const held = bot.heldItem;
    return {
      running: fisher.running,
      rod: held && held.name === 'fishing_rod'
        ? {
            remaining: held.maxDurability != null && held.durabilityUsed != null
              ? Math.max(0, held.maxDurability - held.durabilityUsed)
              : null,
            maxDurability: held.maxDurability ?? null,
          }
        : null,
      stats: fisher.stats,
    };
  };

  // 停止：running 置 false；若鱼线在水里，主动收竿（鱼漂实体销毁 → fish() 立即结束）
  const stop = (reason = null) => {
    if (!fisher.running && !reason) return;
    fisher.running = false;
    if (reason) {
      fisher.stats.stoppedReason = reason;
      log(`自动停止: ${reason}`);
    } else {
      log('已停止。');
    }
    if (fisher.inCast) {
      try { bot.activateItem(); } catch (err) { /* 未进游戏时忽略 */ }
    }
  };

  // 单次抛竿：等待上钩或超时。带兜底 catch，防止被放弃的 fish() promise 产生 unhandled rejection。
  const castOnce = () => new Promise((resolve) => {
    let timer = null;
    const done = (result) => {
      if (timer) { clearTimeout(timer); timer = null; }
      resolve(result);
    };
    bot.fish().then(() => done('catch')).catch(() => done('cancelled'));
    timer = setTimeout(() => {
      fisher.stats.timeouts++;
      log(`${cfg.castTimeoutMs / 1000} 秒未上钩，收竿重抛`);
      try { bot.activateItem(); } catch (err) {}
      done('timeout');
    }, cfg.castTimeoutMs);
  });

  // 钓鱼主循环：抛竿 → 上钩/超时 → 检查耐久 → 重抛。
  // 结束时无条件清空 fisher.loop（start() 只在 loop 为空时才创建新循环，
  // 因此任意时刻最多一个循环在跑；循环退出后清空，停止后再 !fish 才能开新循环）
  const castLoop = async () => {
    while (fisher.running) {
      // 鱼竿检查：没有鱼竿 / 耐久耗尽 → 自动停止
      const rod = inventoryRod();
      if (!rod) { stop('背包里没有鱼竿'); break; }
      if (isBroken(rod)) { stop('鱼竿耐久耗尽，自动停止'); break; }

      try {
        await bot.equip(rod, 'hand');
      } catch (err) {
        log(`装备鱼竿失败: ${(err && err.message) || err}`);
        stop('装备鱼竿失败');
        break;
      }
      await sleep(150); // 等装备生效
      if (!fisher.running) break;

      fisher.stats.casts++;
      fisher.inCast = true;
      const result = await castOnce();
      fisher.inCast = false;
      if (!fisher.running) break;

      if (result === 'catch') {
        fisher.stats.catches++;
        log(`钓到一条（累计 ${fisher.stats.catches} 条，鱼竿剩余 ${rodRemaining()}）`);
        await sleep(600); // 等服务器把物品/耐久数据推过来
        if (isBroken(bot.heldItem)) { stop('鱼竿耐久耗尽，自动停止'); break; }
      }
      // 'timeout' / 'cancelled' → 继续循环重抛（手动停止时上面已退出）
    }
    fisher.loop = null;
  };

  const rodRemaining = () => {
    const held = bot.heldItem;
    if (!held || held.maxDurability == null || held.durabilityUsed == null) return '?';
    return Math.max(0, held.maxDurability - held.durabilityUsed);
  };

  const start = (source) => {
    if (fisher.running) return { ok: false, error: '已经在钓鱼中' };
    if (!bot.entity) return { ok: false, error: '机器人尚未进入世界' };
    const rod = inventoryRod();
    if (!rod) return { ok: false, error: '背包里没有鱼竿' };
    if (isBroken(rod)) return { ok: false, error: '当前鱼竿耐久已耗尽，请换一根' };
    fisher.running = true;
    fisher.stats.stoppedReason = null;
    if (!fisher.loop) fisher.loop = castLoop();
    log(`开始自动钓鱼（由 ${source} 发起）`);
    return { ok: true };
  };

  // ---- 指令 ----
  const reply = (username, msg) => bot.whisper(username, `> ${msg}`);

  commands.register({
    name: 'fish',
    permissionLevel: 1,
    description: '开始自动钓鱼（!stopfish 停止，鱼竿耐久耗尽自动停止）',
    execute: (username) => {
      const r = start(`!fish (${username})`);
      reply(username, r.ok ? '开始自动钓鱼（鱼竿耐久耗尽自动停止）。' : r.error);
    },
  });

  commands.register({
    name: 'stopfish',
    permissionLevel: 1,
    description: '停止自动钓鱼',
    execute: (username) => {
      if (!fisher.running) return reply(username, '当前没有在钓鱼。');
      stop();
      reply(username, '已停止钓鱼。');
    },
  });

  // ---- 网页磁贴（全部端点 GET，网页按钮只发 GET 请求）----
  const p = (fn) => (req, res, url) => {
    try {
      const result = fn(url);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
  };

  webManager.registerTile({
    name: pluginName,
    title: '自动钓鱼',
    description: '自动抛竿钓鱼，鱼竿耐久耗尽自动停止，网页/指令控制',
    endpoints: {
      '/status': { handler: p(() => statusInfo()), label: '📋 状态' },
      '/start': { handler: p(() => start('网页')), label: '▶ 开始' },
      '/stop': { handler: p(() => { stop(); return { ok: true, running: fisher.running }; }), label: '⏹ 停止' },
    },
  });

  log(`插件已加载（抛竿超时 ${cfg.castTimeoutMs}ms）`);
};
