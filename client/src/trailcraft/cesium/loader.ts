/** Loads the standalone Cesium browser runtime without evaluating any 3D API bindings at app startup. */
export type CesiumRuntime = typeof import('cesium')

declare global {
  interface Window {
    Cesium?: CesiumRuntime
    __trailcraftCesiumLoad?: Promise<CesiumRuntime>
  }
}

const RUNTIME_URL = '/cesium/Cesium.js'
const RUNTIME_LOAD_TIMEOUT_MS = 12_000

export function loadCesiumRuntime(): Promise<CesiumRuntime> {
  if (window.Cesium) return Promise.resolve(window.Cesium)
  if (window.__trailcraftCesiumLoad) return window.__trailcraftCesiumLoad

  window.__trailcraftCesiumLoad = new Promise<CesiumRuntime>((resolve, reject) => {
    const script = document.createElement('script')
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      fn()
    }
    const timeoutId = window.setTimeout(() => finish(() => reject(new Error('Cesium 运行时加载超时'))), RUNTIME_LOAD_TIMEOUT_MS)
    script.async = true
    script.src = RUNTIME_URL
    script.onload = () => finish(() => window.Cesium ? resolve(window.Cesium) : reject(new Error('Cesium 运行时未暴露全局对象')))
    script.onerror = () => finish(() => reject(new Error('Cesium 运行时资源加载失败')))
    document.head.appendChild(script)
  })
  return window.__trailcraftCesiumLoad
}
