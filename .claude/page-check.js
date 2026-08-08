// .claude/page-check.js
// 检查 web-manager 页面脚本:
//   1. 脚本语法(node --check)
//   2. 所有 getElementById('...') 引用的 id 必须真实存在于 HTML 中
//   3. 所有 querySelector('#...') 引用的 id 必须真实存在
// 运行: node .claude/page-check.js
'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

const file = 'plugins/web-manager/public/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('✗ 未找到 <script> 块'); process.exit(1); }
const script = m[1];
const tmp = '.claude/_page-check.js';

// 1. 语法检查
fs.writeFileSync(tmp, script);
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  console.log('✓ 页面脚本语法 OK');
} catch (err) {
  console.error('✗ 页面脚本语法错误:\n' + err.stderr.toString());
  process.exit(1);
}

// 2. 引用完整性: getElementById + querySelector('#...')
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(x => x[1]));
let bad = 0;
const check = (name, ref) => {
  if (!ids.has(ref)) { console.error(`✗ 引用了不存在的 id: ${name}('${ref}')`); bad++; }
};
for (const x of script.matchAll(/getElementById\('([^']+)'\)/g)) check('getElementById', x[1]);
for (const x of script.matchAll(/querySelector\('#([A-Za-z0-9_-]+)/g)) check('querySelector', x[1]);

if (bad) { console.error(`\n✗ ${bad} 个无效引用`); process.exit(1); }
console.log(`✓ 所有 getElementById/querySelector 引用(${[...script.matchAll(/getElementById\('([^']+)'\)/g)].length + [...script.matchAll(/querySelector\('#([A-Za-z0-9_-]+)/g)].length} 处)均存在对应 id`);
