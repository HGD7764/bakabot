// plugins/auto-reconnect/index.js
// 自动重连插件：bot 掉线（'end' 事件）后延迟指定秒数，调用 main.js 暴露的
// context.restartBot() 全量重建（createBot → 补丁 → 日志钩子 → 命令管理器 →
// 插件重新加载 → 核心事件），期间 web-manager 的 HTTP 服务不受影响。
//
// 配置（plugins/auto-reconnect/config.json）：
//   { "enabled": true, "delay": 3000, "maxRetries": -1 }
//   - enabled:    是否启用
//   - delay:      掉线后等待毫秒数（默认 3000 = 3 秒）
//   - maxRetries: 最大连续重连次数，-1 表示无限重连（默认）；到达上限后停止
module.exports = (context) => {
  const { bot, config, pluginConfig } = context;
  const cfg = { enabled: true, delay: 3000, maxRetries: -1, ...(pluginConfig || {}) };
  if (!cfg.enabled) return;

  const logger = require('../../logger');

  let retries = 0;  // 连续掉线次数（成功进入世界后清零）
  let timer = null; // 等待重连的定时器（防重复调度）

  const onEnd = (reason) => {
    if (timer) return; // 已在等待重连中
    if (cfg.maxRetries >= 0 && retries >= cfg.maxRetries) {
      logger.warn('reconnect', `已达最大重连次数 (${cfg.maxRetries})，停止自动重连。`);
      console.log(`[auto-reconnect] 已达最大重连次数 (${cfg.maxRetries})，停止自动重连。`);
      return;
    }
    retries++;
    logger.info('reconnect', `检测到掉线，${cfg.delay}ms 后自动重连 (第 ${retries} 次)...`);
    console.log(`[auto-reconnect] ${cfg.delay / 1000} 秒后自动重连 (第 ${retries} 次)...`);
    timer = setTimeout(() => {
      timer = null;
      context.restartBot(reason);
    }, cfg.delay);
  };

  // 成功进入世界后重置连续掉线计数（每次重建后插件重新执行，自动给新 bot 挂上）
  bot.once('spawn', () => {
    retries = 0;
  });

  bot.on('end', onEnd);
};
