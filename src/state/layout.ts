/**
 * 侧边栏宽度 / 剖面图高度这两个可拖拽调整的布局尺寸,持久化到 localStorage。
 *
 * 刻意不放进工程文件(project.ts)也不放进撤销历史:这是"这台设备上这个
 * 浏览器"的界面偏好,不是工程数据的一部分——换一台电脑打开同一个工程文件
 * 不应该也带着这个尺寸,undo/redo 也不应该把"我刚拖动了分隔条"当一步操作
 * 回滚。localStorage 在 Node 测试环境里不存在,和 state/persist.ts 对
 * IndexedDB 的处理方式一样,这里把每次访问都包在 try/catch 里,而不是在
 * 模块顶层就去碰 localStorage —— 这样这个模块本身仍然可以在测试里被安全
 * import 和调用。
 */

export interface LayoutSizes {
  sidebarWidth: number
  profileHeight: number
}

const STORAGE_KEY = 'trailcraft:layout:v1'

export const DEFAULT_LAYOUT_SIZES: LayoutSizes = { sidebarWidth: 320, profileHeight: 240 }

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(max, min), Math.max(value, min))
}

/** Reads the persisted layout sizes, falling back to defaults whenever
 * localStorage is unavailable, empty, or holds something unparsable. */
export function loadLayoutSizes(): LayoutSizes {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_LAYOUT_SIZES }
    const parsed = JSON.parse(raw) as Partial<LayoutSizes>
    return {
      sidebarWidth:
        typeof parsed.sidebarWidth === 'number' && Number.isFinite(parsed.sidebarWidth)
          ? parsed.sidebarWidth
          : DEFAULT_LAYOUT_SIZES.sidebarWidth,
      profileHeight:
        typeof parsed.profileHeight === 'number' && Number.isFinite(parsed.profileHeight)
          ? parsed.profileHeight
          : DEFAULT_LAYOUT_SIZES.profileHeight,
    }
  } catch {
    return { ...DEFAULT_LAYOUT_SIZES }
  }
}

export function saveLayoutSizes(sizes: LayoutSizes): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes))
  } catch {
    // Quota errors / privacy-mode / no localStorage at all: losing the
    // preference is harmless, defaults just apply again on next load.
  }
}
