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
      // vite-plugin-static-copy always preserves each target's source
      // directory structure under `dest` (unlike rollup-plugin-copy's
      // `flatten` option) -- `rename: { stripBase: true }` is what drops
      // the `node_modules/cesium/Build/Cesium/` prefix so e.g. `Workers/`
      // lands directly at `dist/cesium/Workers/`, matching the flat layout
      // Cesium expects under `window.CESIUM_BASE_URL`.
      targets: ['Workers', 'ThirdParty', 'Assets', 'Widgets'].map((dir) => ({
        src: `node_modules/cesium/Build/Cesium/${dir}`,
        dest: CESIUM_BASE_URL,
        rename: { stripBase: true },
      })),
    }),
  ],
  define: {
    // Read by src/cesium/viewer.ts (see the ambient declaration in
    // src/vite-env.d.ts). Same base path in dev and build: viteStaticCopy
    // also copies into Vite's dev-time public-serving root, so
    // `/cesium/...` resolves identically under `npm run dev` and the built
    // `dist/` output.
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
