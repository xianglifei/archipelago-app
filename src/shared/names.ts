// 岛名随机词库(M2.2:命名岛给随机建议,一键采用)
// 居民名字库:双音节叠音英文名,取自「岛上名字总表」的「✅ 推荐」档;
// Momo 已被主 Bot 占用,不在列。邀请新居民时优先从这里挑还没人用的。

const ISLAND_WORDS = [
  '芒果', '灯塔', '菠萝', '鲸歌', '季风', '贝壳', '海盐', '椰子',
  '星光', '帆船', '珊瑚', '浮云', '海风', '月牙', '远帆', '青屿'
]

export const ISLANDER_NAMES = [
  'Bebe', 'Bibi', 'Bobo', 'Chacha', 'Chuchu', 'Cici', 'Coco',
  'Dede', 'Didi', 'Dodo', 'Dudu', 'Fifi', 'Gigi', 'Gogo', 'Gugu',
  'Huhu', 'Jiji', 'Jojo', 'Keke', 'Kiki', 'Koko', 'Kuku',
  'Lala', 'Lili', 'Lolo', 'Lulu', 'Mimi', 'Mumu', 'Nene', 'Nunu',
  'Pepe', 'Pompom', 'Sasa', 'Sisi', 'Tata', 'Titi', 'Toto', 'Tutu',
  'Vivi', 'Wawa', 'Yiyi', 'Yoyo', 'Yuyu', 'Zuzu'
]

export function randomIslandName(): string {
  const word = ISLAND_WORDS[Math.floor(Math.random() * ISLAND_WORDS.length)]!
  return `${word}岛`
}

export function randomIslanderName(): string {
  return ISLANDER_NAMES[Math.floor(Math.random() * ISLANDER_NAMES.length)]!
}
