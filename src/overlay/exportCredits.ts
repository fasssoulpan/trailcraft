/**
 * Compliance credits text composition (方案 V2.1 §5.6 「片尾自动附署名模板
 * …用户导出即合规」; P2 plan §2.1 交付物 9 「合规片尾:自动附加数据源署名」;
 * milestone Q5 commit 3). Pure and Cesium-free -- the whole point being that
 * this is the one part of the credits tail worth unit-testing (`captureDraw
 * .ts`'s new `drawCreditsCard` just paints whatever this module hands it).
 *
 * ---- Never assume Esri (or OSM) ----
 * `cesium/viewer.ts`'s provider chain can end up on MapTiler, Esri, or (for
 * terrain) a flat ellipsoid with nothing to credit -- see that module's own
 * `ProviderReport`. This function takes exactly what actually got selected
 * (`ExportCreditInput`) and never fabricates a credit for a provider that
 * wasn't reached. In particular: the P2 plan's own example list for this
 * deliverable is 「OSM / Esri / Copernicus 等」, but the video export path
 * (3D flythrough only -- `ui/FlyView.tsx`'s export button doesn't exist in
 * 2D planning mode) never actually uses OSM or Copernicus anywhere in this
 * codebase; only `map/basemapStyle.ts`'s separate 2D MapLibre planning view
 * uses OSM, which an export never captures. Composing credits from the
 * ACTUAL `ProviderReport`/`basemapStyle` rather than that generic example
 * list is what keeps this module honest.
 *
 * ---- Two basemap styles, two different imagery credits ----
 * `cesium/viewer.ts`'s "plan" style (二维平面图) always shows the Esri
 * Street layer and always uses the flat `EllipsoidTerrainProvider`
 * (`cesium/basemap.ts#terrainProviderForStyle`), REGARDLESS of what
 * `ProviderReport.terrain`/`.imagery` say -- those two fields describe the
 * "satellite" style's own selection only (see `viewer.ts#createViewer`: the
 * plan-style imagery layer is always `ESRI_STREET_URL`/`ESRI_STREET_CREDIT`,
 * never `selectImagery`'s result). An export recorded while the user had
 * "二维平面图" active must credit what was actually on screen, not what the
 * satellite style would have used -- `basemapStyle` here is exactly the
 * discriminator `viewer.ts`'s own `CesiumBasemapHandle#creditFor` uses for
 * the identical decision.
 */
import type { TerrainSource, ImagerySource } from '../cesium/terrainSelection'
import { ESRI_IMAGERY_CREDIT, ESRI_STREET_CREDIT } from '../cesium/terrainSelection'
import type { BasemapStyle } from '../state/basemapPref'

export interface ExportCreditInput {
  terrain: TerrainSource
  imagery: ImagerySource
  basemapStyle: BasemapStyle
}

export interface ExportCredits {
  /** One line per data source actually used to render this export's frames
   * -- never fabricated, never assumes Esri. Always at least one entry. */
  dataCredits: string[]
  /** Present whenever this export's frames used no external terrain data at
   * all (flat ellipsoid, whether from the "plan" style's own design or a
   * downgrade after every real terrain service was unreachable) -- an
   * honest note, not a "credit", matching `ui/FlyView.tsx#TERRAIN_LABEL`'s
   * own "a silent downgrade must not look like broken rendering" convention
   * applied to the exported file instead of the live badge. */
  terrainFallbackNote?: string
  /** Always present: background music is never bundled with TrailCraft (the
   * P2 plan is explicit that users must supply their own royalty-free
   * track) -- omitting this note would let a user believe the app cleared
   * audio rights on their behalf, which it never does. */
  musicNote: string
}

const TERRAIN_CREDIT: Partial<Record<TerrainSource, string>> = {
  maptiler: '地形数据 © MapTiler',
  esri: '地形数据来自 Esri World Elevation 3D',
}

const IMAGERY_CREDIT: Record<ImagerySource, string> = {
  maptiler: '影像数据 © MapTiler',
  esri: `影像数据来自 ${ESRI_IMAGERY_CREDIT}`,
}

const MUSIC_NOTE = '背景音乐未内置，如需公开发布请自行添加已获授权的音乐'

/**
 * Composes the credits text for one export, given exactly what
 * `cesium/viewer.ts` reported was in use. Pure -- no Canvas/Cesium/DOM, so
 * every branch (both basemap styles, all three terrain sources, both
 * imagery sources) is directly unit-testable without a real Viewer.
 */
export function composeExportCredits(input: ExportCreditInput): ExportCredits {
  const dataCredits: string[] = []
  let terrainFallbackNote: string | undefined

  if (input.basemapStyle === 'plan') {
    // See this file's header comment -- "plan" always shows the Esri street
    // layer over a flat ellipsoid, independent of `input.terrain`/`.imagery`.
    dataCredits.push(`影像数据来自 ${ESRI_STREET_CREDIT}`)
    terrainFallbackNote = '地形：平面（该样式不使用三维地形数据）'
  } else {
    dataCredits.push(IMAGERY_CREDIT[input.imagery])
    const terrainCredit = TERRAIN_CREDIT[input.terrain]
    if (terrainCredit) {
      dataCredits.push(terrainCredit)
    } else {
      terrainFallbackNote = '地形：平面（三维地形服务不可达，本次导出未使用外部地形数据）'
    }
  }

  return { dataCredits, terrainFallbackNote, musicNote: MUSIC_NOTE }
}
