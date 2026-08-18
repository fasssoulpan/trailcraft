/**
 * 把用户选中的原图解码、按 EXIF Orientation 摆正、等比缩小到不超过
 * `MAX_DIMENSION_PX` 的长边,重新编码成 JPEG data URI。
 *
 * 三件事在同一次 canvas 绘制里一次做完:
 *  1. 缩放——CP 面板/CP 卡片里显示的照片从来不需要手机原图的分辨率(常见
 *     4000×3000、2-5MB),必须先降下来再存进工程 JSON,理由见
 *     `attachPhoto.ts` 顶部的存储决策注释。
 *  2. 摆正方向——`exif.ts` 解析出的 Orientation 只是个数字标签,浏览器的
 *     `createImageBitmap`(默认选项下)和 `<canvas>` 都不会替你转,不摆正
 *     会让竖拍的照片在 CP 卡片里横着显示。
 *  3. 清除 EXIF——canvas 重新编码出的 JPEG 天然不带原图的任何元数据,GPS
 *     坐标、拍摄时间等隐私信息因此不会随缩略图一起进入工程文件/导出文件。
 *     这是刻意依赖的副作用,不是巧合(隐私原则见 `attachPhoto.ts`)。
 *
 * 依赖 DOM(`createImageBitmap`/`<canvas>`),不在 Node 测试环境里可跑,
 * 因此没有配套单测——和 `core/export/profileGraphic.ts` 里同样触碰 canvas
 * 的 PNG 绘制部分是同一类"DOM-only,不追加 jsdom 依赖"的既有取舍。
 */

/** 长边上限。1440px 在 CP 面板缩略图/CP 卡片/未来的路书导出里都足够清晰,
 * 同时把典型手机照片压到几十到几百 KB 量级,不会让内嵌到工程 JSON 里的
 * data URI 失控膨胀。 */
export const MAX_DIMENSION_PX = 1440

/** JPEG 重编码质量。0.82 是"肉眼看不出压缩痕迹"和"体积"之间的常见折中,
 * 与本项目其它 PNG/JPEG 导出路径(如 profileGraphic.ts)不追求无损同理。 */
export const JPEG_QUALITY = 0.82

/**
 * `orientation` 传 `exif.ts#ExifData.orientation`(可能是 `undefined`,即
 * "不摆正"，等价于 1)。返回值是一个 `data:image/jpeg;base64,...` 字符串,
 * 可以直接赋给 `CheckPoint.photoUrl`、直接当 `<img src>` 用、也能原样序列化
 * 进工程 JSON。
 */
export async function downscaleAndReorient(file: File | Blob, orientation: number | undefined): Promise<string> {
  const bitmap = await createImageBitmap(file)
  try {
    const srcW = bitmap.width
    const srcH = bitmap.height
    const scale = Math.min(1, MAX_DIMENSION_PX / Math.max(srcW, srcH))
    // drawW/drawH 是"缩放后、尚未按方向旋转"的尺寸——即 ctx.drawImage 的
    // dWidth/dHeight。方向变换矩阵(见下方 applyOrientationTransform)在这
    // 个坐标系里描述,和 canvas 本身的最终宽高（5-8 号方向下宽高互换）分开
    // 处理,两者混在一起算是这类方向变换代码最容易出 bug 的地方。
    const drawW = Math.max(1, Math.round(srcW * scale))
    const drawH = Math.max(1, Math.round(srcH * scale))
    const swapDims = orientation !== undefined && orientation >= 5 && orientation <= 8

    const canvas = document.createElement('canvas')
    canvas.width = swapDims ? drawH : drawW
    canvas.height = swapDims ? drawW : drawH
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法创建 canvas 2D 上下文')

    applyOrientationTransform(ctx, orientation, drawW, drawH)
    ctx.drawImage(bitmap, 0, 0, drawW, drawH)

    return canvas.toDataURL('image/jpeg', JPEG_QUALITY)
  } finally {
    bitmap.close()
  }
}

/**
 * EXIF Orientation(1-8)到 canvas 变换矩阵的标准对照表。`w`/`h` 是绘制时
 * 使用的、旋转前的尺寸(见调用处注释)。1 或未知值不做任何变换。
 */
function applyOrientationTransform(ctx: CanvasRenderingContext2D, orientation: number | undefined, w: number, h: number): void {
  switch (orientation) {
    case 2: // 水平镜像
      ctx.transform(-1, 0, 0, 1, w, 0)
      break
    case 3: // 180°
      ctx.transform(-1, 0, 0, -1, w, h)
      break
    case 4: // 垂直镜像
      ctx.transform(1, 0, 0, -1, 0, h)
      break
    case 5: // 转置(水平镜像 + 顺时针 90°)
      ctx.transform(0, 1, 1, 0, 0, 0)
      break
    case 6: // 顺时针 90°
      ctx.transform(0, 1, -1, 0, h, 0)
      break
    case 7: // 反转置(水平镜像 + 逆时针 90°)
      ctx.transform(0, -1, -1, 0, h, w)
      break
    case 8: // 逆时针 90°
      ctx.transform(0, -1, 1, 0, 0, w)
      break
    default:
      break
  }
}
