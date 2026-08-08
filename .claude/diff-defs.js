// 对比上游 26.1 与 fork 26.2 的所有包字段定义(双向)
const fs = require('fs');
const up = JSON.parse(fs.readFileSync('.claude/up-26.1-protocol.json', 'utf8'));
const fork = JSON.parse(fs.readFileSync('.claude/gh-26.2-protocol.json', 'utf8'));

for (const dir of ['toClient', 'toServer']) {
  const upTypes = up.play[dir].types;
  const forkTypes = fork.play[dir].types;
  const names = new Set([...Object.keys(upTypes), ...Object.keys(forkTypes)].filter(n => n.startsWith('packet_')));
  const diffs = [];
  for (const n of names) {
    const a = JSON.stringify(upTypes[n]);
    const b = JSON.stringify(forkTypes[n]);
    if (a === undefined || b === undefined) { diffs.push(n + ': 只存在于一方 (' + (a ? '26.1' : '26.2') + ')'); continue; }
    if (a !== b) diffs.push(n + ':\n   26.1: ' + a.slice(0, 200) + '\n   26.2: ' + b.slice(0, 200));
  }
  console.log('=== ' + dir + ' 定义差异 ' + diffs.length + ' 个 ===');
  diffs.forEach(d => console.log(d));
}
