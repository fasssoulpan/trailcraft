/**
 * Which of the sidebar's four task groups (数据/规划/分析/输出, see App.tsx)
 * are expanded is a UI preference, exactly like `mode.ts`'s
 * 规划/巡游 mode, `theme.ts`'s theme choice, and `layout.ts`'s splitter
 * sizes: it's "this device's last-used state", not project data and not an
 * undo-able edit. Persisted to localStorage with every access wrapped in
 * try/catch, same reasoning as those modules (localStorage doesn't exist in
 * the Node test environment).
 *
 * Defaults open the two groups almost every session touches first (数据:
 * get a track in; 规划: edit it) and collapse the other two (分析/输出: used
 * once you already have a track shaped the way you want) -- this is what
 * actually fixes the "ten always-open panels in one scroll" problem the
 * redesign brief called out, rather than just relabelling it.
 *
 * There is deliberately no 视图 group: basemap/contour/radar now sit in the
 * pinned header beside the mode switch, because which basemap you want is a
 * function of which mode you are in -- the user asked for the two to live
 * together. A stale `view` key from an older build is simply ignored by the
 * key-by-key merge in loadSidebarGroups.
 */

export interface SidebarGroupState {
  data: boolean
  plan: boolean
  analysis: boolean
  output: boolean
}

const STORAGE_KEY = 'trailcraft:sidebar-groups:v1'

export const DEFAULT_SIDEBAR_GROUPS: SidebarGroupState = {
  data: true,
  plan: true,
  analysis: false,
  output: false,
}

const GROUP_KEYS = Object.keys(DEFAULT_SIDEBAR_GROUPS) as (keyof SidebarGroupState)[]

/** Reads the persisted group open/closed state, falling back to the
 * defaults above whenever localStorage is unavailable, empty, or holds
 * something unparsable -- tolerating a partial/old-shape object the same
 * way layout.ts's loadLayoutSizes does, key by key. */
export function loadSidebarGroups(): SidebarGroupState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SIDEBAR_GROUPS }
    const parsed = JSON.parse(raw) as Partial<SidebarGroupState>
    const result = { ...DEFAULT_SIDEBAR_GROUPS }
    for (const key of GROUP_KEYS) {
      if (typeof parsed[key] === 'boolean') result[key] = parsed[key] as boolean
    }
    return result
  } catch {
    return { ...DEFAULT_SIDEBAR_GROUPS }
  }
}

export function saveSidebarGroups(state: SidebarGroupState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Quota errors / privacy-mode / no localStorage at all: losing the
    // preference is harmless, defaults just apply again on next load.
  }
}
