/**
 * 从 JPEG 文件的 APP1/Exif 段解析 GPS 坐标、拍摄时间(DateTimeOriginal)和
 * 方向(Orientation)。纯函数,只操作 ArrayBuffer,不碰 DOM/File API,因此
 * 可以在 Node 测试环境里直接跑(见 tests/core/exif.test.ts,用手写字节数组
 * 构造合成 JPEG,而不是提交一个二进制 fixture——后者不诚实,谁都看不出
 * 里面到底编码了什么,改起来也不知道会不会破坏断言)。
 *
 * ## 坐标系
 * EXIF GPS 标签(GPSLatitude/GPSLongitude)按标准定义就是 WGS-84,不存在
 * "厂商私有坐标系"这回事。TrailCraft 内部也统一用 WGS-84(见
 * `core/model/track.ts` 的 `Crs`/坐标转换管线),所以这里没有、也不需要
 * 任何坐标系转换——刻意写这条注释,是因为这是一个面向中国市场的应用,
 * 项目里其它几乎所有"外部坐标"入口(高德/腾讯底图、GCJ-02 火星坐标系
 * 相关处理)都有一次转换,以后维护者看到"EXIF 读出来直接用"大概率会犯嘀咕
 * "是不是漏转了",在这里明确说清楚:没漏,EXIF GPS 本来就是 WGS-84。
 *
 * ## 为什么不引入现成的 EXIF 库
 * 调研过 exifr / exif-js / piexifjs 这类常见选择,最终决定手写一个聚焦的
 * TIFF/IFD 解析器,而不是加依赖:
 *  - 只需要三个字段(GPS 经纬度、DateTimeOriginal、Orientation)。完整的
 *    EXIF 标签空间有几百个 tag,一个通用库要处理厂商私有 MakerNote、缩略图
 *    IFD、XMP 等本项目完全用不到的复杂度,体积和攻击面都远超需要。
 *  - JPEG 的 EXIF 是良定义的"APP1 段里塞一份 TIFF"结构,手写一个只读
 *    IFD0 + GPS IFD + Exif SubIFD 三张表的解析器,行为完全可控,能被下面
 *    的合成字节数组测试精确覆盖到每个分支(四个半球的符号处理、DMS→十进制
 *    转换、EXIF 缺失、GPS 缺失、数据截断)。
 *  - 不给一个本地优先、无后端的应用增加一条供应链依赖。
 * 如果未来要支持 HEIC 的 EXIF(目前明确不支持,见 `detectPhotoFormat`),
 * 那会是引入依赖更充分的理由——HEIC 是 ISOBMFF box 结构包着 TIFF,手写代价
 * 显著上升;到那时应该用动态 import 把库排除在主 bundle 之外。
 */

export interface ExifGps {
  lat: number
  lon: number
}

export interface ExifData {
  gps?: ExifGps
  /** EXIF 原始字符串,如 "2026:08:06 09:15:32"——不含时区,是相机本地时间。 */
  dateTimeOriginal?: string
  /** 上面那个字符串按"拍摄地本地时间"解析出的毫秒时间戳;解析失败则不出现该字段。 */
  dateTimeOriginalMs?: number
  /** EXIF Orientation tag,取值 1-8。缺失时调用方应按 1(不旋转)处理。 */
  orientation?: number
}

export type PhotoFormat = 'jpeg' | 'heic' | 'png' | 'unknown'

export type ExifParseResult =
  | { ok: true; data: ExifData }
  | { ok: false; reason: 'unsupported-format'; format: PhotoFormat; detail: string }
  | { ok: false; reason: 'corrupt'; detail: string }

/**
 * 基于文件头 magic number 的格式探测。特意把 HEIC 单独识别出来(而不是
 * 归进笼统的"unknown"):HEIC 是苹果设备近几年的默认拍照格式,用户很可能
 * 直接把 HEIC 文件拖进来,笼统报错"格式不支持"会让人摸不着头脑,应当明确
 * 告诉他们发生了什么、该怎么办(见 parseExif 里的 detail 文案)。
 */
export function detectPhotoFormat(buffer: ArrayBuffer): PhotoFormat {
  const bytes = new Uint8Array(buffer)
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70 // 'ftyp'
  ) {
    // ISOBMFF 的 'ftyp' box 头——HEIC/HEIF/AVIF 都用这个容器格式。这里不去
    // 细分 major brand(heic/heix/mif1/avif/...),只要是 ftyp 容器就统一
    // 当作"HEIC 系"处理:反正当前一律不支持解析,精确区分 AVIF 和 HEIC
    // 对用户提示没有实际意义。
    return 'heic'
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  ) {
    return 'png'
  }
  return 'unknown'
}

/**
 * 解析一张照片的 EXIF 信息。永远不抛异常——任何解析失败都归一成
 * `{ ok: false, ... }`,由调用方决定怎么向用户呈现,这是项目"拒绝默默
 * 编造数据,宁可大声报错"的一贯要求(见 docs/P0-验收记录.md §五)在这里的
 * 体现:解析失败就是失败,不能悄悄返回一个"看起来正常但其实是猜的"结果。
 */
export function parseExif(buffer: ArrayBuffer): ExifParseResult {
  const format = detectPhotoFormat(buffer)
  if (format === 'heic') {
    return {
      ok: false,
      reason: 'unsupported-format',
      format,
      detail: 'HEIC 格式暂不支持解析 EXIF。请在系统相机设置里把照片格式改为"兼容性最好"(JPEG),或先用系统自带的转换功能转成 JPEG 再导入。',
    }
  }
  if (format !== 'jpeg') {
    return {
      ok: false,
      reason: 'unsupported-format',
      format,
      detail: '不是 JPEG 文件,无法解析 EXIF。',
    }
  }
  try {
    return { ok: true, data: parseJpegExif(buffer) }
  } catch (e) {
    return { ok: false, reason: 'corrupt', detail: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 扫描 JPEG 的段(marker segment)链,找到 APP1 里带 "Exif\0\0" 签名的那个
 * 段,交给 `parseTiff` 解析。找不到就返回空对象——一张有效的 JPEG完全可以
 * 不含任何 EXIF(社交软件转发常见的二次编码、截图等),这不是错误,只是
 * "没有元数据可用",调用方(P3-R2 commit 3 的锚定逻辑)据此把它当作"需要
 * 用户手动指定位置的照片"处理,而不是拒绝导入。
 */
function parseJpegExif(buffer: ArrayBuffer): ExifData {
  const view = new DataView(buffer)
  if (view.byteLength < 4) throw new Error('文件过短,不是有效的 JPEG')
  if (view.getUint16(0) !== 0xffd8) throw new Error('缺少 JPEG SOI 标记')

  let offset = 2
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset)
    if ((marker & 0xff00) !== 0xff00) throw new Error(`偏移 ${offset} 处不是合法的 JPEG 段标记`)
    // SOS(扫描开始)之后是压缩图像数据,不会再出现 APP 段;EOI 是文件结尾。
    // 两者都没有长度字段,必须在读 length 之前拦下。
    if (marker === 0xffd9 || marker === 0xffda) break
    const length = view.getUint16(offset + 2)
    if (length < 2) throw new Error('JPEG 段长度字段非法')
    if (marker === 0xffe1) {
      const sigStart = offset + 4
      if (
        sigStart + 6 <= view.byteLength &&
        view.getUint8(sigStart) === 0x45 && // E
        view.getUint8(sigStart + 1) === 0x78 && // x
        view.getUint8(sigStart + 2) === 0x69 && // i
        view.getUint8(sigStart + 3) === 0x66 && // f
        view.getUint8(sigStart + 4) === 0x00 &&
        view.getUint8(sigStart + 5) === 0x00
      ) {
        return parseTiff(view, sigStart + 6)
      }
    }
    offset += 2 + length
  }
  return {}
}

// --- TIFF/IFD 解析 -----------------------------------------------------
// TIFF 标签的数据类型编号 -> 单个元素的字节数(只列出 EXIF 会用到的几种;
// SBYTE/UNDEFINED/SSHORT/SLONG/FLOAT/DOUBLE 补全是为了让"未知但结构合法"
// 的字段仍能正确计算长度、不至于因为按 1 字节误算而把后续解析带偏)。
const TYPE_SIZE: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
}

interface IfdEntry {
  type: number
  count: number
  /** 12 字节条目里 value/offset 那 4 个字节在 buffer 里的绝对位置。 */
  valueFieldOffset: number
}

function readIfd(view: DataView, tiffStart: number, ifdOffset: number, little: boolean): Map<number, IfdEntry> {
  const absIfd = tiffStart + ifdOffset
  if (absIfd + 2 > view.byteLength) throw new Error('IFD 偏移越界')
  const count = view.getUint16(absIfd, little)
  const entries = new Map<number, IfdEntry>()
  for (let i = 0; i < count; i++) {
    const entryOffset = absIfd + 2 + i * 12
    if (entryOffset + 12 > view.byteLength) throw new Error('IFD 条目越界')
    const tag = view.getUint16(entryOffset, little)
    const type = view.getUint16(entryOffset + 2, little)
    const cnt = view.getUint32(entryOffset + 4, little)
    entries.set(tag, { type, count: cnt, valueFieldOffset: entryOffset + 8 })
  }
  return entries
}

/** 值 <=4 字节时直接内联在条目里;否则条目里存的是相对 tiffStart 的偏移。 */
function valueDataOffset(view: DataView, tiffStart: number, entry: IfdEntry, little: boolean): number {
  const size = (TYPE_SIZE[entry.type] ?? 1) * entry.count
  if (size <= 4) return entry.valueFieldOffset
  const rel = view.getUint32(entry.valueFieldOffset, little)
  return tiffStart + rel
}

function readAscii(view: DataView, tiffStart: number, entry: IfdEntry, little: boolean): string {
  const off = valueDataOffset(view, tiffStart, entry, little)
  if (off + entry.count > view.byteLength) throw new Error('ASCII 字段越界')
  let s = ''
  for (let i = 0; i < entry.count; i++) {
    const c = view.getUint8(off + i)
    if (c === 0) break
    s += String.fromCharCode(c)
  }
  return s
}

/** SHORT(类型 3)恒好 2 字节,永远内联在条目里,不会走 offset 分支。 */
function readShort(view: DataView, entry: IfdEntry, little: boolean): number {
  return view.getUint16(entry.valueFieldOffset, little)
}

function readRationalArray(view: DataView, tiffStart: number, entry: IfdEntry, little: boolean): number[] {
  const off = valueDataOffset(view, tiffStart, entry, little)
  const out: number[] = []
  for (let i = 0; i < entry.count; i++) {
    const base = off + i * 8
    if (base + 8 > view.byteLength) throw new Error('RATIONAL 字段越界')
    const num = view.getUint32(base, little)
    const den = view.getUint32(base + 4, little)
    out.push(den === 0 ? 0 : num / den)
  }
  return out
}

function dmsToDecimal(deg: number, min: number, sec: number): number {
  return deg + min / 60 + sec / 3600
}

/** GPS IFD 里必须凑齐 ref+值两两配对才算有效坐标,缺一样都当作"没有 GPS"。 */
function readGps(view: DataView, tiffStart: number, gpsIfd: Map<number, IfdEntry>, little: boolean): ExifGps | undefined {
  const latRefEntry = gpsIfd.get(1) // GPSLatitudeRef
  const latEntry = gpsIfd.get(2) // GPSLatitude
  const lonRefEntry = gpsIfd.get(3) // GPSLongitudeRef
  const lonEntry = gpsIfd.get(4) // GPSLongitude
  if (!latRefEntry || !latEntry || !lonRefEntry || !lonEntry) return undefined

  const latRef = readAscii(view, tiffStart, latRefEntry, little).trim().toUpperCase()
  const lonRef = readAscii(view, tiffStart, lonRefEntry, little).trim().toUpperCase()
  const latDms = readRationalArray(view, tiffStart, latEntry, little)
  const lonDms = readRationalArray(view, tiffStart, lonEntry, little)
  if (latDms.length < 3 || lonDms.length < 3) return undefined

  let lat = dmsToDecimal(latDms[0], latDms[1], latDms[2])
  let lon = dmsToDecimal(lonDms[0], lonDms[1], lonDms[2])
  if (latRef === 'S') lat = -lat
  if (lonRef === 'W') lon = -lon
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined
  return { lat, lon }
}

/** "YYYY:MM:DD HH:MM:SS"(EXIF 标准格式,无时区)-> 按拍摄地本地时间解析的毫秒时间戳。 */
function parseExifDateTime(raw: string): number | undefined {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw.trim())
  if (!m) return undefined
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number)
  const date = new Date(y, mo - 1, d, h, mi, s)
  return Number.isNaN(date.getTime()) ? undefined : date.getTime()
}

function parseTiff(view: DataView, tiffStart: number): ExifData {
  if (tiffStart + 8 > view.byteLength) throw new Error('TIFF 头越界')
  const b0 = view.getUint8(tiffStart)
  const b1 = view.getUint8(tiffStart + 1)
  let little: boolean
  if (b0 === 0x49 && b1 === 0x49) little = true // 'II'
  else if (b0 === 0x4d && b1 === 0x4d) little = false // 'MM'
  else throw new Error('无法识别的 TIFF 字节序标记')

  const magic = view.getUint16(tiffStart + 2, little)
  if (magic !== 0x002a) throw new Error('TIFF magic number 不匹配')

  const ifd0Offset = view.getUint32(tiffStart + 4, little)
  const ifd0 = readIfd(view, tiffStart, ifd0Offset, little)

  const data: ExifData = {}

  const orientationEntry = ifd0.get(0x0112)
  if (orientationEntry) {
    const o = readShort(view, orientationEntry, little)
    if (o >= 1 && o <= 8) data.orientation = o
  }

  const exifPtrEntry = ifd0.get(0x8769) // Exif SubIFD 指针
  if (exifPtrEntry) {
    const exifIfdOffset = view.getUint32(exifPtrEntry.valueFieldOffset, little)
    const exifIfd = readIfd(view, tiffStart, exifIfdOffset, little)
    const dtoEntry = exifIfd.get(0x9003) // DateTimeOriginal
    if (dtoEntry) {
      const raw = readAscii(view, tiffStart, dtoEntry, little)
      if (raw) {
        data.dateTimeOriginal = raw
        const ms = parseExifDateTime(raw)
        if (ms !== undefined) data.dateTimeOriginalMs = ms
      }
    }
  }

  const gpsPtrEntry = ifd0.get(0x8825) // GPS IFD 指针
  if (gpsPtrEntry) {
    const gpsIfdOffset = view.getUint32(gpsPtrEntry.valueFieldOffset, little)
    const gpsIfd = readIfd(view, tiffStart, gpsIfdOffset, little)
    const gps = readGps(view, tiffStart, gpsIfd, little)
    if (gps) data.gps = gps
  }

  return data
}
