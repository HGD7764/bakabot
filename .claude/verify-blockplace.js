// 验证 26.2 block_place 补丁:worldBorderHit 已从 def 移除 → 8 字段,25 字节
const { createSerializer } = require('minecraft-protocol/src/transforms/serializer');

const serializer = createSerializer({ state: 'play', isServer: false, version: '26.2', compiled: true });

const packet = {
  name: 'block_place',
  params: {
    hand: 0,
    location: { x: 400, y: 100, z: 200 },
    direction: 1,
    cursorX: 0.5,
    cursorY: 0.5,
    cursorZ: 0.5,
    insideBlock: false,
    sequence: 0
  }
};

const buf = serializer.createPacketBuffer(packet);
console.log('payload 长度:', buf.length, '(补丁前为 26,期望 25)');
console.log('hex:', buf.toString('hex').match(/.{2}/g).join(' '));
console.log('期望布局: 41 | 00(hand) | position×8 | 01(dir) | 3F000000×3(cursor) | 00(insideBlock) | 00(sequence)');
