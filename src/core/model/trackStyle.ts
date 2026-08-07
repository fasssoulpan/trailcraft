/**
 * 轨迹配色/线宽:自动分配 + 用户覆盖后的持久化。
 *
 * 纯函数,不依赖 maplibre-gl/DOM,方便在 Node 测试环境里直接测——真正把
 * 这些值画到地图上的地方是 `src/map/trackLayer.ts`。
 */
import type { Track } from './track'

/**
 * 固定调色板,按顺序循环分配给新导入的轨迹。挑选原则:
 * - 与 CP 图钉颜色(`src/map/trackLayer.ts` 的 `CP_KIND_COLORS`)、悬停光标
 *   颜色(同文件 `syncHoverMarker` 用的 `#1d4ed8`)都没有精确撞色——最容易
 *   混淆的是悬停光标那个蓝色,之前版本的调色板里恰好也有同一个蓝
 *   (`#1d4ed8`),导致某条轨迹的线色和悬停光标本身颜色相同、难以区分,
 *   这里直接把蓝色从轨迹调色板里去掉,而不是改悬停光标的颜色(悬停光标的
 *   蓝色更早、更广泛地被当作"当前位置"的视觉约定)。
 * - 在地形图/OSM 底图上都有足够的辨识度(避开与常见地图前景色——比如
 *   OSM 森林的深绿、水系的浅蓝——太接近的色相)。
 */
export const TRACK_PALETTE: readonly string[] = [
  '#e63946', // red
  '#f4a261', // orange
  '#2a9d8f', // teal
  '#9333ea', // purple
  '#0891b2', // cyan
  '#c2410c', // rust
  '#be185d', // magenta
  '#854d0e', // brown
]

export const DEFAULT_LINE_WIDTH = 3

/**
 * 下一条新轨迹该用的颜色,基于已经在用的颜色序列(按轨迹顺序)。
 *
 * 两条约束:
 * - 用完调色板后从头循环(`existingColors.length % TRACK_PALETTE.length`
 *   决定起始下标)。
 * - 不会与"上一条"轨迹的颜色相同——正常循环本身已经保证这一点(相邻两个
 *   下标对应调色板里不同的颜色),但用户可以手动把某条轨迹的颜色改成
 *   调色板里的任意值(见 TrackList 的颜色选择器),这可能让"按下标计算出
 *   的下一个颜色"恰好撞上"用户刚手动改成的上一条轨迹颜色"。这里从计算出
 *   的起始下标开始,顺着调色板往后找,直到找到一个和 `existingColors` 最后
 *   一个元素不同的颜色为止(调色板长度为 1 时无处可退,原样返回)。
 */
export function nextTrackColor(existingColors: readonly string[]): string {
  const paletteLen = TRACK_PALETTE.length
  const start = existingColors.length % paletteLen
  const last = existingColors[existingColors.length - 1]
  for (let i = 0; i < paletteLen; i++) {
    const candidate = TRACK_PALETTE[(start + i) % paletteLen]
    if (candidate !== last) return candidate
  }
  return TRACK_PALETTE[start]
}

/**
 * 给缺少 color/lineWidth 的轨迹补上默认样式(新导入的轨迹、或者由没有这两个
 * 字段的旧工程文件读回来的轨迹),已经有值的轨迹原样保留、且返回同一个对象
 * 引用(不触发不必要的重渲染/重新计算)。
 *
 * 颜色按 `tracks` 的数组顺序依次分配,`colors` 累加已经"确定下来"的颜色
 * (无论是原有的还是刚分配的)喂给下一次 `nextTrackColor` 调用,这样即使
 * 数组里穿插着已有颜色和待分配颜色,"相邻轨迹颜色不同"这条约束也始终按
 * 实际序列生效,而不只是按下标生效。
 */
export function backfillTrackStyles(tracks: Track[]): Track[] {
  const colors: string[] = []
  return tracks.map((t) => {
    const color = t.meta.color ?? nextTrackColor(colors)
    const lineWidth = t.meta.lineWidth ?? DEFAULT_LINE_WIDTH
    colors.push(color)
    if (t.meta.color === color && t.meta.lineWidth === lineWidth) return t
    return { ...t, meta: { ...t.meta, color, lineWidth } }
  })
}
