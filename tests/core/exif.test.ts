import { describe, it, expect } from 'vitest'
import { parseExif, detectPhotoFormat } from '../../src/core/photo/exif'

// ---------------------------------------------------------------------
// 手写字节数组构造合成 JPEG+EXIF,而不是提交一份二进制 fixture:后者谁都
// 看不出编码了什么,前者每一行断言都能对应到构造时写下的具体字节。
// 结构参考(TIFF 6.0 / Exif 2.3 规范):
//   JPEG: SOI(FFD8) [APP1(FFE1) length "Exif\0\0" <TIFF...>] EOI(FFD9)
//   TIFF: 字节序标记(2) + magic 0x002A(2) + IFD0 偏移(4) + IFD0
//         [+ GPS IFD] [+ Exif SubIFD] [+ 大于 4 字节的字段的数据区]
// ---------------------------------------------------------------------

class ByteWriter {
  private bytes: number[] = []
  constructor(private little: boolean) {}
  u8(v: number): this {
    this.bytes.push(v & 0xff)
    return this
  }
  u16(v: number): this {
    if (this.little) this.bytes.push(v & 0xff, (v >> 8) & 0xff)
    else this.bytes.push((v >> 8) & 0xff, v & 0xff)
    return this
  }
  u32(v: number): this {
    if (this.little) this.bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff)
    else this.bytes.push((v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff)
    return this
  }
  ascii(s: string): this {
    for (const c of s) this.bytes.push(c.charCodeAt(0))
    return this
  }
  toUint8Array(): Uint8Array {
    return new Uint8Array(this.bytes)
  }
}

interface GpsOpt {
  latRef: 'N' | 'S'
  lat: [number, number, number] // deg, min, sec
  lonRef: 'E' | 'W'
  lon: [number, number, number]
}

/** 组装一段完整的 TIFF(从字节序标记开始),按需带 GPS IFD / Exif SubIFD。 */
function buildTiff(opts: { little: boolean; gps?: GpsOpt; dateTimeOriginal?: string; orientation?: number }): Uint8Array {
  const { little, gps, dateTimeOriginal, orientation } = opts
  const hasGps = gps !== undefined
  const hasDto = dateTimeOriginal !== undefined
  const hasOrientation = orientation !== undefined

  let entryCount = 0
  if (hasOrientation) entryCount++
  if (hasGps) entryCount++
  if (hasDto) entryCount++

  const IFD0_SIZE = 2 + entryCount * 12 + 4
  const GPS_IFD_SIZE = 2 + 4 * 12 + 4
  const EXIF_IFD_SIZE = 2 + 1 * 12 + 4

  const gpsIfdOffset = 8 + IFD0_SIZE
  const exifIfdOffset = 8 + IFD0_SIZE + (hasGps ? GPS_IFD_SIZE : 0)
  const dataStart = 8 + IFD0_SIZE + (hasGps ? GPS_IFD_SIZE : 0) + (hasDto ? EXIF_IFD_SIZE : 0)
  const gpsLatDataOffset = dataStart
  const gpsLonDataOffset = gpsLatDataOffset + 24
  const dtoDataOffset = hasGps ? gpsLonDataOffset + 24 : dataStart
  const dtoBytes = hasDto ? dateTimeOriginal!.length + 1 : 0 // 含 NUL 终止符

  const w = new ByteWriter(little)

  // TIFF header
  if (little) w.u8(0x49).u8(0x49)
  else w.u8(0x4d).u8(0x4d)
  w.u16(0x002a)
  w.u32(8)

  // IFD0
  w.u16(entryCount)
  if (hasOrientation) {
    w.u16(0x0112).u16(3).u32(1) // Orientation, SHORT, count 1
    w.u16(orientation!).u16(0) // 内联值 + 2 字节 padding
  }
  if (hasGps) {
    w.u16(0x8825).u16(4).u32(1) // GPS IFD pointer, LONG, count 1
    w.u32(gpsIfdOffset)
  }
  if (hasDto) {
    w.u16(0x8769).u16(4).u32(1) // Exif SubIFD pointer, LONG, count 1
    w.u32(exifIfdOffset)
  }
  w.u32(0) // IFD0 后没有下一个 IFD

  // GPS IFD
  if (hasGps) {
    w.u16(4)
    w.u16(1).u16(2).u32(2) // GPSLatitudeRef, ASCII, count 2
    w.ascii(gps!.latRef).u8(0).u8(0).u8(0) // 内联 "N\0" / "S\0" + 2 字节 padding
    w.u16(2).u16(5).u32(3) // GPSLatitude, RATIONAL, count 3
    w.u32(gpsLatDataOffset)
    w.u16(3).u16(2).u32(2) // GPSLongitudeRef, ASCII, count 2
    w.ascii(gps!.lonRef).u8(0).u8(0).u8(0)
    w.u16(4).u16(5).u32(3) // GPSLongitude, RATIONAL, count 3
    w.u32(gpsLonDataOffset)
    w.u32(0)
  }

  // Exif SubIFD
  if (hasDto) {
    w.u16(1)
    w.u16(0x9003).u16(2).u32(dtoBytes) // DateTimeOriginal, ASCII
    w.u32(dtoDataOffset)
    w.u32(0)
  }

  // 数据区:GPS 的两组 RATIONAL[3],再是 DateTimeOriginal 字符串
  if (hasGps) {
    for (const v of gps!.lat) w.u32(v).u32(1)
    for (const v of gps!.lon) w.u32(v).u32(1)
  }
  if (hasDto) {
    w.ascii(dateTimeOriginal!).u8(0)
  }

  return w.toUint8Array()
}

function buildJpeg(tiff: Uint8Array): ArrayBuffer {
  const exifSig = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00] // "Exif\0\0"
  const payload = new Uint8Array(exifSig.length + tiff.length)
  payload.set(exifSig, 0)
  payload.set(tiff, exifSig.length)
  const appLength = 2 + payload.length // 长度字段自身也算在内,且恒为大端
  const head = [0xff, 0xd8, 0xff, 0xe1, (appLength >> 8) & 0xff, appLength & 0xff]
  const tail = [0xff, 0xd9]
  const out = new Uint8Array(head.length + payload.length + tail.length)
  out.set(head, 0)
  out.set(payload, head.length)
  out.set(tail, head.length + payload.length)
  return out.buffer
}

function jpegWithNoExif(): ArrayBuffer {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer
}

describe('detectPhotoFormat', () => {
  it('recognises a JPEG magic number', () => {
    expect(detectPhotoFormat(buildJpeg(buildTiff({ little: true })))).toBe('jpeg')
  })
  it('recognises an HEIC/ISOBMFF ftyp box', () => {
    const bytes = new Uint8Array([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, // size + 'ftyp'
      0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x00, 0x00, // 'heic' major brand + padding
    ])
    expect(detectPhotoFormat(bytes.buffer)).toBe('heic')
  })
  it('recognises a PNG magic number as not-jpeg', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(detectPhotoFormat(bytes.buffer)).toBe('png')
  })
  it('falls back to unknown for unrecognised bytes', () => {
    expect(detectPhotoFormat(new Uint8Array([1, 2, 3]).buffer)).toBe('unknown')
  })
})

describe('parseExif GPS hemisphere sign handling', () => {
  const cases: Array<{ label: string; gps: GpsOpt; lat: number; lon: number }> = [
    {
      label: 'N/E both positive',
      gps: { latRef: 'N', lat: [39, 54, 30], lonRef: 'E', lon: [116, 24, 36] },
      lat: 39 + 54 / 60 + 30 / 3600,
      lon: 116 + 24 / 60 + 36 / 3600,
    },
    {
      label: 'N/W: lon negative',
      gps: { latRef: 'N', lat: [39, 54, 30], lonRef: 'W', lon: [116, 24, 36] },
      lat: 39 + 54 / 60 + 30 / 3600,
      lon: -(116 + 24 / 60 + 36 / 3600),
    },
    {
      label: 'S/E: lat negative',
      gps: { latRef: 'S', lat: [22, 32, 0], lonRef: 'E', lon: [114, 5, 0] },
      lat: -(22 + 32 / 60),
      lon: 114 + 5 / 60,
    },
    {
      label: 'S/W: both negative',
      gps: { latRef: 'S', lat: [22, 32, 0], lonRef: 'W', lon: [114, 5, 0] },
      lat: -(22 + 32 / 60),
      lon: -(114 + 5 / 60),
    },
  ]

  for (const { label, gps, lat, lon } of cases) {
    it(`${label} (little-endian TIFF)`, () => {
      const result = parseExif(buildJpeg(buildTiff({ little: true, gps })))
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data.gps?.lat).toBeCloseTo(lat, 9)
      expect(result.data.gps?.lon).toBeCloseTo(lon, 9)
    })
  }

  it('big-endian TIFF ("MM") decodes identically to little-endian', () => {
    const gps: GpsOpt = { latRef: 'N', lat: [39, 54, 30], lonRef: 'E', lon: [116, 24, 36] }
    const result = parseExif(buildJpeg(buildTiff({ little: false, gps })))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.gps?.lat).toBeCloseTo(39 + 54 / 60 + 30 / 3600, 9)
    expect(result.data.gps?.lon).toBeCloseTo(116 + 24 / 60 + 36 / 3600, 9)
  })
})

describe('parseExif DateTimeOriginal and Orientation', () => {
  it('parses DateTimeOriginal as local time and reads Orientation', () => {
    const result = parseExif(
      buildJpeg(buildTiff({ little: true, dateTimeOriginal: '2026:08:06 09:15:32', orientation: 6 })),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.dateTimeOriginal).toBe('2026:08:06 09:15:32')
    expect(result.data.orientation).toBe(6)
    expect(result.data.dateTimeOriginalMs).toBe(new Date(2026, 7, 6, 9, 15, 32).getTime())
  })

  it('leaves orientation undefined when the tag is absent', () => {
    const result = parseExif(buildJpeg(buildTiff({ little: true, dateTimeOriginal: '2026:01:01 00:00:00' })))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.orientation).toBeUndefined()
  })
})

describe('parseExif missing-data cases', () => {
  it('EXIF present but no GPS tags: gps is undefined, not an error', () => {
    const result = parseExif(buildJpeg(buildTiff({ little: true, orientation: 1 })))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.gps).toBeUndefined()
    expect(result.data.orientation).toBe(1)
  })

  it('no EXIF/APP1 segment at all: ok with an empty data object', () => {
    const result = parseExif(jpegWithNoExif())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toEqual({})
  })
})

describe('parseExif error handling', () => {
  it('rejects a non-JPEG, non-HEIC file (PNG magic number)', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    const result = parseExif(bytes.buffer)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('unsupported-format')
    expect(result.format).toBe('png')
  })

  it('reports HEIC explicitly rather than a generic parse failure', () => {
    const bytes = new Uint8Array([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0,
    ])
    const result = parseExif(bytes.buffer)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('unsupported-format')
    expect(result.format).toBe('heic')
    expect(result.detail).toContain('HEIC')
  })

  it('a JPEG magic number with nothing after it is corrupt, not silently empty', () => {
    const result = parseExif(new Uint8Array([0xff, 0xd8, 0xff]).buffer)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('corrupt')
  })

  it('truncating the EXIF data block mid-GPS-IFD is reported as corrupt', () => {
    const gps: GpsOpt = { latRef: 'N', lat: [39, 54, 30], lonRef: 'E', lon: [116, 24, 36] }
    const fullTiff = buildTiff({ little: true, gps })
    // 砍掉最后 30 字节:GPS 的两段 RATIONAL[3] 数据区(共 48 字节)被切掉一部分,
    // 但 JPEG/APP1/TIFF 头和 IFD 条目本身仍完整,确保确实是"解析到一半才崩",
    // 而不是在找到 Exif 签名之前就已经落空退化成"没有 EXIF"的那条路径。
    const truncatedTiff = fullTiff.slice(0, fullTiff.length - 30)
    const result = parseExif(buildJpeg(truncatedTiff))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('corrupt')
  })

  it('an unrecognised TIFF byte-order marker is corrupt', () => {
    const w = new ByteWriter(true)
    w.u8(0x58).u8(0x58) // 既不是 'II' 也不是 'MM'
    w.u16(0x002a)
    w.u32(8)
    w.u16(0)
    w.u32(0)
    const result = parseExif(buildJpeg(w.toUint8Array()))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('corrupt')
  })
})
