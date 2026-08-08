
  const TOKEN_KEY = 'webManagerToken';
  let currentConfigName = null;

  // ---- 基础请求封装（401 时提示输入 token 并重试一次） ----
  async function api(path, opts = {}) {
    let token = localStorage.getItem(TOKEN_KEY);
    const headers = { ...(opts.headers || {}) };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    let resp = await fetch(path, { ...opts, headers });
    if (resp.status === 401) {
      token = prompt('需要管理 token:');
      if (token === null) throw new Error('未授权');
      localStorage.setItem(TOKEN_KEY, token);
      headers['Authorization'] = 'Bearer ' + token;
      resp = await fetch(path, { ...opts, headers });
    }
    return resp;
  }

  async function apiJSON(path, opts = {}) {
    const resp = await api(path, opts);
    let data = null;
    try { data = await resp.json(); } catch (e) {}
    if (!resp.ok) throw new Error((data && data.error) || ('HTTP ' + resp.status));
    return data;
  }

  // ---- 提示 ----
  function toast(msg, type = 'ok') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'show ' + type;
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.className = ''; }, 3500);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---- 状态栏 ----
  async function refreshStatus() {
    try {
      const s = await apiJSON('/api/status');
      const b = s.bot;
      const pos = b.position ? ` · 位置 (${b.position.x}, ${b.position.y}, ${b.position.z})` : '';
      document.getElementById('statusLine').textContent =
        `${b.username || '未连接'} · ${b.spawned ? '在线' : '离线'} · 生命 ${b.health ?? '-'} · 饥饿 ${b.hunger ?? '-'} · 运行 ${s.uptime}s${pos}`;
      document.getElementById('pm2Badge').style.display = s.pm2 ? '' : 'none';
      document.getElementById('noSupervisorBadge').style.display = s.pm2 ? 'none' : '';
    } catch (err) {
      document.getElementById('statusLine').textContent = '状态获取失败: ' + err.message;
    }
  }

  // ---- 磁贴 + 权限编辑区 ----
  async function refreshPlugins() {
    const grid = document.getElementById('grid');
    try {
      const data = await apiJSON('/api/plugins');
      grid.innerHTML = '';
      if (!data.plugins.length) { grid.innerHTML = '<p class="status">无插件</p>'; }
      for (const p of data.plugins) {
        const tile = document.createElement('div');
        tile.className = 'tile';
        const title = p.customTile ? p.customTile.title : p.name;
        const desc = p.customTile ? p.customTile.description : '';
        const badges = (p.hasConfig ? '<span class="badge ok">有配置</span>' : '<span class="badge muted">无配置</span>') +
                       (p.loaded ? '' : '<span class="badge warn">未加载</span>');
        const eps = (p.customTile && p.customTile.endpoints || []);
        const btns = [
          (p.customTile && p.customTile.panel) ? `<button onclick="openPanel('${esc(p.customTile.panel)}')">🔍 打开面板</button>` : '',
          `<button onclick="reloadPlugin('${esc(p.name)}')" ${p.loaded ? '' : 'disabled'}>🔄 重载</button>`,
          p.hasConfig ? `<button class="secondary" onclick="editConfig('${esc(p.name)}')">⚙️ 编辑配置</button>` : '',
          ...eps.map((ep, i) => {
            if (typeof ep === 'string') { // 旧格式兼容：只有路径
              return `<button class="secondary" onclick="callEndpoint('${esc(ep)}')">📡 调用接口</button>`;
            }
            const label = ep.label || '📡 调用接口';
            const path = esc(ep.path);
            if (ep.dropdown) {
              const ddId = `dd-${esc(p.name)}-${i}`;
              const param = esc(ep.dropdown.param || 'v');
              return `<select id="${ddId}" class="ep-select"><option>加载中...</option></select>` +
                     `<button class="secondary" onclick="callEndpointDropdown('${path}', '${ddId}', '${param}')">${esc(label)}</button>`;
            }
            return `<button class="secondary" onclick="callEndpoint('${path}')">${esc(label)}</button>`;
          }),
        ].join('');
        tile.innerHTML =
          `<div class="tile-head"><span class="tile-title">${esc(title)}</span></div>` +
          `<div class="tile-name">${esc(p.name)} ${badges}</div>` +
          (desc ? `<div class="tile-desc">${esc(desc)}</div>` : '') +
          `<div class="tile-btns">${btns}</div>` +
          `<div class="ep-result" id="ep-${esc(p.name)}" style="display:none"></div>`;
        grid.appendChild(tile);
        // 填充下拉框选项：调用该端点的 dropdown.source（相对同插件前缀）拉取列表
        eps.forEach((ep, i) => {
          if (ep && typeof ep !== 'string' && ep.dropdown) {
            const base = ep.path.split('/').slice(0, 4).join('/'); // /api/plugins/<name>
            fillDropdown(`dd-${esc(p.name)}-${i}`, base + ep.dropdown.source);
          }
        });
      }
    } catch (err) {
      grid.innerHTML = `<p class="status">加载失败: ${esc(err.message)}</p>`;
    }
    // 权限编辑区
    try {
      const perm = await apiJSON('/api/permissions');
      document.getElementById('permEditor').value = JSON.stringify(perm, null, 2);
    } catch (err) {
      toast('权限加载失败: ' + err.message, 'err');
    }
  }

  function refreshAll() {
    refreshStatus();
    refreshPlugins();
    refreshTerminal();
    refreshInventory();
  }

  // ---- 终端 ----
  const MAX_TERMINAL_LINES = 200;

  async function refreshTerminal() {
    try {
      const data = await apiJSON('/api/terminal/messages');
      const box = document.getElementById('terminal');
      const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
      const msgs = data.messages.slice(-MAX_TERMINAL_LINES);
      if (!msgs.length) {
        box.innerHTML = '<p class="status">暂无消息</p>';
        return;
      }
      box.innerHTML = msgs.map(m => {
        const time = new Date(m.t).toLocaleTimeString('zh-CN', { hour12: false });
        const cls = (m.type === 'system' || m.dir === 'system' ? 'system' : (m.dir === 'out' ? 'out' : 'in')) +
                    (m.type === 'whisper' ? ' whisper' : '');
        const who = (m.type === 'system' || m.dir === 'system') ? '' : (m.user ? (m.dir === 'out' ? '→ ' + esc(m.user) + ': ' : esc(m.user) + ': ') : '');
        return `<div class="line ${cls}"><span class="time">${time}</span>${who}${esc(m.msg)}</div>`;
      }).join('');
      if (nearBottom) box.scrollTop = box.scrollHeight;
    } catch (err) {
      // 静默失败，等待下次轮询
    }
  }

  async function terminalSend() {
    const input = document.getElementById('terminalInput');
    const message = input.value.trim();
    if (!message) return;
    input.value = '';
    try {
      await apiJSON('/api/terminal/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
    } catch (err) {
      toast('发送失败: ' + err.message, 'err');
    }
    refreshTerminal();
  }

  async function terminalClear() {
    try {
      await apiJSON('/api/terminal/clear', { method: 'POST' });
    } catch (err) {
      toast('清空失败: ' + err.message, 'err');
    }
    refreshTerminal();
  }

  // ---- 背包（仿原版界面）----
  const ICON_VERSIONS = ['1.21.11', '1.21.5', '1.20.4'];
  const ICON_BASE = 'https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/';
  const HOTBAR_START = 36;
  let invJson = '';
  let lastInvData = null;
  let hoveredSlot = null;  // 鼠标悬停的槽位(供 Q 键丢出)
  let dragFrom = null;     // 左键拖动源槽位
  let dragGhost = null;    // 拖动时跟随鼠标的图标
  let dragMoved = false;   // 本次按下是否真的拖动过(用于区分点击)

  // 方块物品(石头/圆石/泥土...)的纹理在 block/ 目录,真物品(工具/食物...)在 item/ 目录
  function iconUrl(name, version, dir) {
    return ICON_BASE + version + '/assets/minecraft/textures/' + dir + '/' + String(name).replace(/^minecraft:/, '') + '.png';
  }

  // 主背包 9-35(3行×9)、快捷栏 36-44 的槽位骨架（盔甲/副手已在 HTML 中）
  function buildInvSlots() {
    const main = document.getElementById('invMain');
    const hotbar = document.getElementById('invHotbar');
    main.innerHTML = '';
    hotbar.innerHTML = '';
    for (let i = 9; i <= 35; i++) {
      const s = document.createElement('div');
      s.className = 'inv-slot';
      s.dataset.slot = i;
      main.appendChild(s);
    }
    for (let i = 36; i <= 44; i++) {
      const s = document.createElement('div');
      s.className = 'inv-slot';
      s.dataset.slot = i;
      hotbar.appendChild(s);
    }
  }

  // 图标: 依次尝试 [首选目录(服务端映射 texDir 或按方块/物品推断), 另一目录] × 各版本,
  // 全部失败则显示占位符(物品名前两字符)
  function makeItemImg(name, isBlock, texDir, texName) {
    const img = document.createElement('img');
    const primary = texDir || (isBlock ? 'block' : 'item');
    const fallback = isBlock ? ['block', 'item'] : ['item', 'block'];
    const dirs = [primary, ...fallback.filter(d => d !== primary)];
    const fname = texName || name;
    let tryIdx = 0;
    const candidates = [];
    for (const v of ICON_VERSIONS) for (const d of dirs) candidates.push([v, d]);
    img.onerror = () => {
      tryIdx++;
      if (tryIdx < candidates.length) {
        img.src = iconUrl(fname, candidates[tryIdx][0], candidates[tryIdx][1]);
      } else if (img._slotEl) {
        const n = String(name).replace(/^minecraft:/, '');
        img._slotEl.classList.add('noicon');
        img._slotEl.dataset.label = n.slice(0, 2).toUpperCase();
        img.remove();
      }
    };
    img.src = iconUrl(fname, candidates[0][0], candidates[0][1]);
    return img;
  }

  function setItemIcon(slotEl, item) {
    const img = makeItemImg(item.name, item.block, item.texDir, item.texName);
    img._slotEl = slotEl;
    slotEl.appendChild(img);
    return img;
  }

  function renderInventory(data) {
    const key = JSON.stringify(data);
    if (key === invJson) return; // 数据没变就不重建，避免右键菜单/悬停被打断
    invJson = key;
    const slots = document.querySelectorAll('.inv-slot');
    for (const el of slots) {
      const idx = parseInt(el.dataset.slot, 10);
      const item = data.slots[idx];
      el.className = 'inv-slot';
      el.innerHTML = '';
      delete el.dataset.label;
      if (!item) continue;
      setItemIcon(el, item);
      if (item.enchanted) el.classList.add('ench');
      if (item.count > 1) {
        const c = document.createElement('span');
        c.className = 'inv-count';
        c.textContent = item.count;
        el.appendChild(c);
      }
    }
    // 当前手持格高亮
    for (let i = 0; i < 9; i++) {
      const el = document.querySelector('#invHotbar .inv-slot[data-slot="' + (HOTBAR_START + i) + '"]');
      if (el) el.classList.toggle('selected', i === data.quickBarSlot);
    }
  }

  async function refreshInventory() {
    try {
      const data = await apiJSON('/api/inventory');
      lastInvData = data;
      const st = document.getElementById('invStatus');
      st.style.display = data.available ? 'none' : '';
      st.textContent = data.available ? '' : '背包尚未同步（等待登录...）';
      document.getElementById('invPanel').style.display = data.available ? '' : 'none';
      if (data.available) renderInventory(data);
    } catch (err) {
      // 静默失败，等待下次轮询
    }
  }

  // ---- 背包交互：Q 键丢出 / 左键拖动移动 / 悬停提示 ----
  const tooltip = document.createElement('div');
  tooltip.className = 'inv-tooltip';
  document.body.appendChild(tooltip);
  const invBox = document.getElementById('inventory');

  function showTooltip(x, y, text) {
    tooltip.textContent = text;
    tooltip.classList.add('show');
    tooltip.style.left = (x + 12) + 'px';
    tooltip.style.top = (y + 16) + 'px';
  }
  function hideTooltip() { tooltip.classList.remove('show'); }

  // 悬停:记录当前槽位 + 显示物品名
  invBox.addEventListener('mouseover', (e) => {
    const el = e.target.closest('.inv-slot');
    if (!el) { hoveredSlot = null; return hideTooltip(); }
    hoveredSlot = parseInt(el.dataset.slot, 10);
    const item = lastInvData && lastInvData.slots[hoveredSlot];
    if (!item) return hideTooltip();
    showTooltip(e.clientX, e.clientY, (item.customName || item.displayName) + (item.count > 1 ? ' × ' + item.count : ''));
  });
  invBox.addEventListener('mousemove', (e) => {
    if (tooltip.classList.contains('show')) {
      tooltip.style.left = (e.clientX + 12) + 'px';
      tooltip.style.top = (e.clientY + 16) + 'px';
    }
    if (dragGhost) {
      dragGhost.style.left = (e.clientX - 20) + 'px';
      dragGhost.style.top = (e.clientY - 20) + 'px';
    }
  });
  invBox.addEventListener('mouseout', (e) => {
    if (!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest('.inv-slot')) {
      hoveredSlot = null;
      hideTooltip();
    }
  });

  // 左键:按下记录拖动源,松开落到其他槽位则移动;同槽位松开算点击(快捷栏切换)
  invBox.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const el = e.target.closest('.inv-slot');
    if (!el) return;
    const item = lastInvData && lastInvData.slots[parseInt(el.dataset.slot, 10)];
    if (!item) return;
    dragFrom = parseInt(el.dataset.slot, 10);
    dragMoved = false;
    dragGhost = document.createElement('div');
    dragGhost.className = 'inv-ghost';
    dragGhost.appendChild(makeItemImg(item.name, item.block, item.texDir, item.texName));
    document.body.appendChild(dragGhost);
  });

  invBox.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return;
    const el = e.target.closest('.inv-slot');
    const target = el ? parseInt(el.dataset.slot, 10) : null;
    if (dragFrom !== null && target !== null && target !== dragFrom) {
      dragMoved = true;
      moveItem(dragFrom, target);
    }
    dragFrom = null;
    if (dragGhost) { dragGhost.remove(); dragGhost = null; }
  });

  invBox.addEventListener('click', (e) => {
    if (dragMoved) return; // 刚拖动过,不是点击
    const el = e.target.closest('.inv-slot');
    if (!el) return;
    const idx = parseInt(el.dataset.slot, 10);
    if (idx >= HOTBAR_START && idx <= HOTBAR_START + 8) {
      // 左键快捷栏 → 切换手持格
      apiJSON('/api/inventory/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slot: idx - HOTBAR_START }),
      }).then(() => refreshInventory()).catch(err => toast('切换失败: ' + err.message, 'err'));
    }
  });

  // Q 键丢出鼠标所指物品(Q=1 个, Shift+Q=整组);输入框聚焦或拖拽中忽略
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'q' && e.key !== 'Q') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (hoveredSlot === null || dragFrom !== null) return;
    if (!lastInvData || !lastInvData.slots[hoveredSlot]) return;
    e.preventDefault();
    dropSlot(hoveredSlot, e.shiftKey ? 'all' : 1);
  });

  async function dropSlot(slot, count) {
    try {
      const r = await apiJSON('/api/inventory/drop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slot, count }),
      });
      toast('已丢出 ' + r.dropped.name + (r.dropped.count > 1 ? ' × ' + r.dropped.count : ''));
    } catch (err) {
      toast('丢出失败: ' + err.message, 'err');
    }
    refreshInventory();
  }

  async function moveItem(from, to) {
    try {
      await apiJSON('/api/inventory/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to }),
      });
    } catch (err) {
      toast('移动失败: ' + err.message, 'err');
    }
    refreshInventory();
  }

  // ---- 插件操作 ----
  async function reloadPlugin(name) {
    try {
      const r = await apiJSON('/api/plugins/' + encodeURIComponent(name) + '/reload', { method: 'POST' });
      toast(r.message || '已重载');
    } catch (err) {
      toast('重载失败: ' + err.message, 'err');
    }
    refreshPlugins();
  }

  async function reloadAll() {
    try {
      const r = await apiJSON('/api/reload-all', { method: 'POST' });
      const failed = Object.entries(r.results).filter(([n, v]) => !v.ok);
      if (failed.length) toast('部分插件重载失败: ' + failed.map(([n]) => n).join(', '), 'err');
      else toast('全部插件已重载');
    } catch (err) {
      toast('重载失败: ' + err.message, 'err');
    }
    refreshPlugins();
  }

  function restartBot() {
    if (!confirm('确定重启机器人吗？进程退出后需要进程管理器（如 pm2）自动拉起。')) return;
    apiJSON('/api/restart', { method: 'POST' })
      .then(r => toast(r.message))
      .catch(err => toast('重启失败: ' + err.message, 'err'));
  }

  // ---- 配置编辑 ----
  async function editConfig(name) {
    currentConfigName = name;
    document.getElementById('configModalTitle').textContent = '编辑配置: ' + name;
    document.getElementById('configEditor').value = '加载中...';
    document.getElementById('configModal').classList.add('open');
    try {
      const r = await apiJSON('/api/plugins/' + encodeURIComponent(name) + '/config');
      document.getElementById('configEditor').value = JSON.stringify(r.config, null, 2);
    } catch (err) {
      document.getElementById('configEditor').value = '';
      toast('配置加载失败: ' + err.message, 'err');
    }
  }

  function closeConfigModal() {
    document.getElementById('configModal').classList.remove('open');
    currentConfigName = null;
  }

  // ---- 插件面板 ----
  function openPanel(panelPath) {
    const token = localStorage.getItem(TOKEN_KEY) || '';
    document.getElementById('panelFrame').src = panelPath + (token ? '?token=' + encodeURIComponent(token) : '');
    document.getElementById('panelModal').classList.add('open');
  }

  function closePanelModal() {
    document.getElementById('panelModal').classList.remove('open');
    document.getElementById('panelFrame').src = 'about:blank';
  }

  async function saveConfig() {
    if (!currentConfigName) return;
    const text = document.getElementById('configEditor').value;
    try {
      const resp = await api('/api/plugins/' + encodeURIComponent(currentConfigName) + '/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: text,
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) throw new Error((data && data.error) || ('HTTP ' + resp.status));
      toast('配置已保存，请点击该插件的「重载」使其生效');
      closeConfigModal();
    } catch (err) {
      toast('保存失败: ' + err.message, 'err');
    }
  }

  // ---- 权限保存 ----
  async function savePermissions() {
    const text = document.getElementById('permEditor').value;
    try {
      const resp = await api('/api/permissions', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: text,
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) throw new Error((data && data.error) || ('HTTP ' + resp.status));
      toast('权限已保存');
    } catch (err) {
      toast('保存失败: ' + err.message, 'err');
    }
  }

  // ---- 自定义端点调用 ----
  async function callEndpoint(ep, query = '') {
    const name = ep.split('/')[3]; // /api/plugins/<name>/<rel>
    const box = document.getElementById('ep-' + name);
    if (!box) return;
    try {
      box.style.display = '';
      box.textContent = '调用中...';
      const resp = await api(ep + query);
      const text = await resp.text();
      box.textContent = resp.ok ? text : ('HTTP ' + resp.status + ': ' + text);
    } catch (err) {
      box.textContent = '调用失败: ' + err.message;
    }
  }

  // 带下拉框的端点：把选中的值作为 ?<param>=<value> 拼到请求上再调用
  function callEndpointDropdown(ep, ddId, param) {
    const sel = document.getElementById(ddId);
    const value = sel && sel.value ? sel.value : '';
    callEndpoint(ep, '?' + encodeURIComponent(param) + '=' + encodeURIComponent(value));
  }

  // 拉取下拉框选项：source 返回 {songs: [...]}（元素为字符串或 {name}）或直接数组
  async function fillDropdown(ddId, sourcePath) {
    const sel = document.getElementById(ddId);
    if (!sel) return;
    try {
      const data = await apiJSON(sourcePath);
      const arr = Array.isArray(data) ? data : (data && data.songs);
      const items = (arr || []).map(x => (typeof x === 'string' ? x : (x && (x.name || x.title)))).filter(Boolean);
      sel.innerHTML = items.length
        ? items.map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join('')
        : '<option value="">（无选项）</option>';
    } catch (err) {
      sel.innerHTML = '<option value="">（加载失败）</option>';
    }
  }

  // ---- 初始化 ----
  buildInvSlots();
  refreshAll();
  setInterval(refreshStatus, 30000);
  setInterval(refreshTerminal, 2000);
  setInterval(refreshInventory, 2000);
