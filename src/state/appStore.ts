import { create } from 'zustand'
import type { Crs, Track } from '../core/model/track'

export interface HoverState { trackId: string; index: number } // 全轨迹点索引

interface AppState {
  tracks: Track[]
  activeTrackId?: string
  hover?: HoverState
  sourceMemory: Record<string, Crs>
  addTrack(t: Track): void
  removeTrack(id: string): void
  setActive(id: string): void
  setHover(h?: HoverState): void
  rememberSource(creator: string, crs: Crs): void
}

export const useAppStore = create<AppState>((set) => ({
  tracks: [], sourceMemory: {},
  addTrack: (t) => set((s) => ({ tracks: [...s.tracks, t], activeTrackId: t.id })),
  removeTrack: (id) => set((s) => ({
    tracks: s.tracks.filter((x) => x.id !== id),
    activeTrackId: s.activeTrackId === id ? undefined : s.activeTrackId,
    hover: s.hover?.trackId === id ? undefined : s.hover,
  })),
  setActive: (id) => set({ activeTrackId: id }),
  setHover: (h) => set({ hover: h }),
  rememberSource: (creator, crs) => set((s) => ({ sourceMemory: { ...s.sourceMemory, [creator]: crs } })),
}))
