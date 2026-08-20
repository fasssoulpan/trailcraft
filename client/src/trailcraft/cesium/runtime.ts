/**
 * Cesium runtime bridge.
 *
 * TrailCraft keeps its 3D engine as a separately loaded, versioned browser
 * asset under `/cesium/Cesium.js`. This prevents Rollup from re-optimising
 * Cesium's large engine graph whenever the ordinary Route Brief UI ships.
 * `loadCesiumRuntime` from `loader.ts` must resolve before a module imports
 * any value here.
 */
import type { CesiumRuntime } from './loader'

function requireCesium(): CesiumRuntime {
  if (!window.Cesium) throw new Error('Cesium 运行时尚未加载')
  return window.Cesium
}

// Named exports match the source package API, allowing the 3D feature modules
// to remain explicit and type-safe while the production bundle stays small.
export const ArcGisMapServerImageryProvider = requireCesium().ArcGisMapServerImageryProvider
export const ArcGISTiledElevationTerrainProvider = requireCesium().ArcGISTiledElevationTerrainProvider
export const BoundingSphere = requireCesium().BoundingSphere
export const Cartesian2 = requireCesium().Cartesian2
export const Cartesian3 = requireCesium().Cartesian3
export const Cartographic = requireCesium().Cartographic
export const CesiumMath = requireCesium().Math
export const CesiumTerrainProvider = requireCesium().CesiumTerrainProvider
export const Color = requireCesium().Color
export const ConstantPositionProperty = requireCesium().ConstantPositionProperty
export const ConstantProperty = requireCesium().ConstantProperty
export const EllipsoidTerrainProvider = requireCesium().EllipsoidTerrainProvider
export const GridImageryProvider = requireCesium().GridImageryProvider
export const HeadingPitchRange = requireCesium().HeadingPitchRange
export const HeightReference = requireCesium().HeightReference
export const ImageryLayer = requireCesium().ImageryLayer
export const LabelCollection = requireCesium().LabelCollection
export const LabelStyle = requireCesium().LabelStyle
export const Material = requireCesium().Material
export const Matrix4 = requireCesium().Matrix4
export const NearFarScalar = requireCesium().NearFarScalar
export const PolylineGlowMaterialProperty = requireCesium().PolylineGlowMaterialProperty
export const SceneTransforms = requireCesium().SceneTransforms
export const ScreenSpaceEventType = requireCesium().ScreenSpaceEventType
export const Transforms = requireCesium().Transforms
export const UrlTemplateImageryProvider = requireCesium().UrlTemplateImageryProvider
export const VerticalOrigin = requireCesium().VerticalOrigin
export const Viewer = requireCesium().Viewer
export const sampleTerrainMostDetailed = requireCesium().sampleTerrainMostDetailed
