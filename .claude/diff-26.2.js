// 对比上游 npm minecraft-data 的 26.2 与 fork 的 26.2:serverbound 包映射与 use_item_on 定义
const stock = require('C:/Users/34708/bakabot/.claude/stock-test/node_modules/minecraft-data');
const fork = require('minecraft-data')('26.2').protocol;
const up = stock('26.2').protocol;
const getMap = (p) => p.play.toServer.types.packet[1][0].type[1].mappings;
const upMap = getMap(up), forkMap = getMap(fork);

// 1) use_item_on 对照
const upId = Object.keys(upMap).find(k => upMap[k] === 'block_place');
const forkId = Object.keys(forkMap).find(k => forkMap[k] === 'block_place');
console.log('block_place id   upstream:', '0x' + upId, '| fork:', '0x' + forkId);
console.log('block_place def  upstream:', JSON.stringify(up.play.toServer.types.packet_block_place));
console.log('block_place def  fork    :', JSON.stringify(fork.play.toServer.types.packet_block_place));

// 2) serverbound 包 ID 差异
const diffs = [];
for (const [id, name] of Object.entries(upMap)) {
  if (forkMap[id] && forkMap[id] !== name) diffs.push(id + ': up=' + name + ' fork=' + forkMap[id]);
  if (!forkMap[id]) diffs.push(id + ': up=' + name + ' fork=(无)');
}
for (const [id, name] of Object.entries(forkMap)) {
  if (!upMap[id]) diffs.push(id + ': fork=' + name + ' up=(无)');
}
console.log('\nserverbound 映射差异共', diffs.length, '处:');
diffs.slice(0, 25).forEach(d => console.log(' ', d));

// 3) keep_alive 对照
console.log('\nserverbound keep_alive upstream:', JSON.stringify(up.play.toServer.types.packet_keep_alive));
console.log('serverbound keep_alive fork    :', JSON.stringify(fork.play.toServer.types.packet_keep_alive));
