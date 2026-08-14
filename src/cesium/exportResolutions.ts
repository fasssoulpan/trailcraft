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

/** The four aspect ratios milestone Q5 supports, matching the reference
 * `fit-ride-studio` skill's own set (P2 plan §2.1 deliverable 8): 16:9
 * (横屏/B站/YouTube), 9:16 (抖音/小红书/视频号), 1:1 (方形分享), 3:4
 * (社交卡片). */
export type ExportAspectRatioKey = '16:9' | '9:16' | '1:1' | '3:4'

export interface ExportResolution {
  width: number
  height: number
  label: string
  ratio: ExportAspectRatioKey
}

export const EXPORT_FPS = 30

/** Every resolution preset Q5 supports, keyed `${ratio}-${label}` so a
 * single flat map still lets `resolutionKeysForRatio` group by ratio without
 * a second lookup structure. 16:9 is the only ratio with more than one
 * resolution choice (1080p/4K, carried over unchanged from Q4); the other
 * three ratios each ship exactly one resolution, per the milestone brief's
 * table -- every stage downstream of this module (compositor, renderer,
 * encoder) already takes `width`/`height` as plain parameters end-to-end
 * (Q4's own deliberate design, see that milestone's own note), so none of
 * them had to change to support the new entries. */
export const EXPORT_RESOLUTIONS = {
  '16:9-1080p': { width: 1920, height: 1080, label: '1080p', ratio: '16:9' },
  '16:9-4k': { width: 3840, height: 2160, label: '4K', ratio: '16:9' },
  '9:16-1080p': { width: 1080, height: 1920, label: '1080p', ratio: '9:16' },
  '1:1-1080p': { width: 1080, height: 1080, label: '1080p', ratio: '1:1' },
  '3:4-1080p': { width: 1080, height: 1440, label: '1080p', ratio: '3:4' },
} as const satisfies Record<string, ExportResolution>

export type ExportResolutionKey = keyof typeof EXPORT_RESOLUTIONS

/** Display order for the ratio selector -- landscape first (Q4's original,
 * still the default), then the three portrait-ish/square additions in the
 * same order the milestone brief's table lists them. */
export const EXPORT_ASPECT_RATIO_ORDER: ExportAspectRatioKey[] = ['16:9', '9:16', '1:1', '3:4']

export const EXPORT_ASPECT_RATIO_LABELS: Record<ExportAspectRatioKey, string> = {
  '16:9': '16:9',
  '9:16': '9:16',
  '1:1': '1:1',
  '3:4': '3:4',
}

/** The resolution keys belonging to `ratio`, in declaration order --
 * `FlyControls`'s resolution row filters `EXPORT_RESOLUTIONS` down to just
 * these so switching ratio never leaves an unrelated resolution chip
 * selected. Always at least one entry for every key in
 * `EXPORT_ASPECT_RATIO_ORDER` (enforced by construction above, not
 * re-checked at runtime). */
export function resolutionKeysForRatio(ratio: ExportAspectRatioKey): ExportResolutionKey[] {
  return (Object.keys(EXPORT_RESOLUTIONS) as ExportResolutionKey[]).filter((key) => EXPORT_RESOLUTIONS[key].ratio === ratio)
}

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
