/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'

// Cesium resolves its own worker/asset URLs at runtime relative to
// `window.CESIUM_BASE_URL` (see node_modules/cesium/Source/Core/buildModuleUrl.js).
// It ships those assets (Workers/ThirdParty/Assets/Widgets) as static files
// rather than bundling them, so they're copied verbatim into `dist/cesium`
// by `viteStaticCopy` below and this constant just has to agree with where
// they land. This is the setup documented in Cesium's own Vite guide
// (https://cesium.com/learn/cesiumjs-learn/cesiumjs-quickstart/#vite), the
// same approach the cyber-trail-hud reference project uses.
const CESIUM_BASE_URL = 'cesium'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    viteStaticCopy({
      // By default vite-plugin-static-copy preserves each matched file's
      // full path *relative to the project root* under `dest` -- so copying
      // `node_modules/cesium/Build/Cesium/Workers` would land at
      // `dist/cesium/node_modules/cesium/Build/Cesium/Workers/...`, not
      // `dist/cesium/Workers/...`. `rename: { stripBase: N }` strips the
      // leading N path segments from that relative path before it's
      // rejoined under `dest`. `node_modules/cesium/Build/Cesium/` is 4
      // segments, so `stripBase: 4` leaves exactly `Workers/...`,
      // `Assets/...`, etc, which is the flat layout Cesium expects under
      // `window.CESIUM_BASE_URL`. (`stripBase: true` strips *all* segments
      // of each file's directory, which flattens every file -- including
      // ones nested several directories deep, e.g. under `Assets/Images/`
      // or `Widgets/Viewer/` -- into one directory, silently merging
      // same-named files and breaking Cesium's own asset lookups.)
      targets: ['Workers', 'ThirdParty', 'Assets', 'Widgets'].map((dir) => ({
        src: `node_modules/cesium/Build/Cesium/${dir}`,
        dest: CESIUM_BASE_URL,
        rename: { stripBase: 4 },
      })),
    }),
  ],
  // MapLibre GL creates its tile-parsing worker from a blob built out of its
  // own bundled source. Letting Vite's dependency optimizer (esbuild)
  // pre-bundle maplibre-gl breaks that blob: the worker starts but never
  // answers, so GeoJSON sources never finish parsing into tiles. Raster
  // basemaps still paint (they need no worker) and DOM markers still show,
  // so the only visible symptom is that track polylines never draw and
  // `map.isStyleLoaded()` stays false forever -- which is exactly what was
  // observed in the browser (dev badge verdict "GeoJSON 源未完成解析",
  // source.loaded() === false with 4000 valid coordinates in the source).
  // Excluding it from pre-bundling makes Vite serve the package's own ESM
  // build untouched, keeping the worker blob intact.
  optimizeDeps: {
    exclude: ['maplibre-gl'],
  },
  define: {
    // Read by src/cesium/viewer.ts (see the ambient declaration in
    // src/vite-env.d.ts). Same base path in dev and build: vite-plugin-
    // static-copy registers a dev-server middleware (see its `apply:
    // 'serve'` plugin) that serves each target at the same `dest` path
    // it would copy to during a build, so `/cesium/...` resolves
    // identically under `npm run dev` and the built `dist/` output --
    // it does not literally write files to disk in dev.
    CESIUM_BASE_URL: JSON.stringify(`/${CESIUM_BASE_URL}`),
  },
  build: {
    // Cesium (~7 MB unminified) must never enter the main bundle -- it's
    // only ever reached via a dynamic import() from src/ui/FlyView.tsx, so
    // the bundler already isolates it into its own chunk by default. This
    // just pins that chunk to a stable, predictable name instead of leaving
    // it to content-hash-only naming. (Vite 8's bundler is rolldown, whose
    // `manualChunks` only accepts the function form, unlike classic
    // Rollup's object-map shorthand.)
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/cesium/')) return 'cesium'
          return undefined
        },
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
  },
})
