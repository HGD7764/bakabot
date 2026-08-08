// 对比上游 26.1 与 fork 26.2 的 serverbound 包映射
const fs = require('fs');
const up = JSON.parse(fs.readFileSync('.claude/up-26.1-protocol.json', 'utf8'));
const fork = JSON.parse(fs.readFileSync('.claude/gh-26.2-protocol.json', 'utf8'));

const upMap = up.play.toServer.types.packet[1][0].type[1].mappings;
const forkMap = fork.play.toServer.types.packet[1][0].type[1].mappings;

console.log('upstream 26.1 serverbound 包数:', Object.keys(upMap).length);
console.log('fork 26.2 serverbound 包数:', Object.keys(forkMap).length);

// 按名称对照 ID
const byNameUp = {};
for (const [id, name] of Object.entries(upMap)) byNameUp[name] = id;
const byNameFork = {};
for (const [id, name] of Object.entries(forkMap)) byNameFork[name] = id;

const changed = [];
const onlyUp = [], onlyFork = [];
for (const [name, idUp] of Object.entries(byNameUp)) {
  if (byNameFork[name] === undefined) onlyUp.push(name + '(26.1@' + idUp + ')');
  else if (byNameFork[name] !== idUp) changed.push(name + ': 26.1@' + idUp + ' -> 26.2@' + byNameFork[name]);
}
for (const [name, idF] of Object.entries(byNameFork)) {
  if (byNameUp[name] === undefined) onlyFork.push(name + '(26.2@' + idF + ')');
}

console.log('\nID 变化的包:', changed.length);
changed.forEach(c => console.log(' ', c));
console.log('\n26.1 有而 26.2 没有:', onlyUp.length);
onlyUp.forEach(c => console.log(' ', c));
console.log('\n26.2 有而 26.1 没有:', onlyFork.length);
onlyFork.forEach(c => console.log(' ', c));
