/**
 * Plain export-pipeline constants/types shared between `frameExport.ts`
 * (the Cesium-touching orchestrator, only ever reached through the dynamic
 * `import()` boundary `ui/FlyView.tsx` documents) and `ui/FlyControls.tsx`
 * (statically imported, part of the main bundle).
 *
 * Deliberately free of any `cesium`/`mp4-muxer` import -- same rule
 * `cameraPath.ts`/`overlay/*.ts` follow for the same reason -- so
 * `FlyControls.tsx` can render the resolution picker and progress label
 * synchronously, before the export chunk has even started loading, without
 * pulling Cesium or the encoder into the main bundle just to know a
 * resolution's width/height/label.
 */

export interface ExportResolution {
  width: number
  height: number
  label: string
}

export const EXPORT_FPS = 30

/** The two resolutions Q4 supports. Q5 (multi-aspect-ratio output) adds
 * variants on top of these -- every stage of this pipeline (compositor,
 * renderer, encoder) takes `width`/`height` as plain parameters end-to-end
 * specifically so Q5 doesn't have to touch any of them, per the milestone
 * brief's "do not architect anything that would block it" instruction. */
export const EXPORT_RESOLUTIONS = {
  '1080p': { width: 1920, height: 1080, label: '1080p' },
  '4k': { width: 3840, height: 2160, label: '4K' },
} as const satisfies Record<string, ExportResolution>

export type ExportResolutionKey = keyof typeof EXPORT_RESOLUTIONS

/** `'probing'` -- running the WebCodecs capability probe. `'prefetching'`/
 * `'rendering'` -- the deterministic renderer's own two phases (or, for the
 * `MediaRecorder` fallback, `'rendering'` covers its entire real-time
 * capture since it has no separate prefetch step). `'finalizing'` -- the
 * encoder is flushing/muxing. `'saving'` -- handing the finished file to the
 * browser's download UI. `'idle'` -- no export in progress. */
export type ExportPhase = 'probing' | 'prefetching' | 'rendering' | 'finalizing' | 'saving' | 'idle'

export interface ExportProgressInfo {
  phase: ExportPhase
  index: number
  total: number
}

export type ExportMode = 'deterministic' | 'fallback'
