/// <reference types="vite/client" />

// Set via `define` in vite.config.ts to the public path Cesium's static
// assets (Workers/ThirdParty/Assets/Widgets, copied by viteStaticCopy) are
// served from. Cesium reads `window.CESIUM_BASE_URL` at runtime -- see
// src/cesium/viewer.ts for where that global is set from this constant.
declare const CESIUM_BASE_URL: string

interface ImportMetaEnv {
  /** Optional MapTiler API key -- enables the higher-fidelity terrain/imagery path in src/cesium/viewer.ts. Absence is the normal case. */
  readonly VITE_MAPTILER_API_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
