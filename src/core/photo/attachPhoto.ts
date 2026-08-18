/**
 * 单张照片"选中文件 -> 可以塞进 CheckPoint.photoUrl 的东西"的完整流程:
 * 读 EXIF(`exif.ts`,纯函数)-> 按 Orientation 摆正并缩小(`downscale.ts`,
 * DOM canvas)。`CpPanel.tsx`(手动为某个 CP 挑一张照片)和 P3-R2 commit 3
 * 的批量照片锚定入口共用这一个函数,不各自实现一遍"读文件、解析、缩放"。
 *
 * ## 隐私
 * 全部在本机内存里完成,没有任何网络请求——和这个应用的整体架构(见项目
 * 说明:本地优先、无后端)一致,但这里刻意再重申一遍:EXIF 里的 GPS/拍摄
 * 时间是"用户在什么时间出现在什么地方"的直接证据,是本项目遇到的隐私敏感度
 * 最高的一类数据,调用方(CpPanel.tsx)必须在照片上传控件旁边把这句话讲给
 * 用户听,不能假设"本地优先"这个大原则不言自明。
 *
 * ## 存储决策
 * `photoUrl` 存的是**缩放并重新编码后的 JPEG data URI**,直接内嵌进
 * `CheckPoint`(进而随整个工程一起写进 IndexedDB、也写进导出的工程 JSON
 * 文件),不是"存 Blob 到单独的 IndexedDB 表、工程文件里只留一个 id"。
 *
 * 权衡过三条路:
 *  1. **(选中)缩放后的 JPEG 存成 data URI,直接嵌进工程 JSON。**
 *     成本:工程文件体积明显变大——原图 2-5MB 经 `downscale.ts` 压到长边
 *     `MAX_DIMENSION_PX`(1440px)、JPEG 质量 `JPEG_QUALITY`(0.82)后通常
 *     几十到几百 KB,base64 再增加约 33%。一条赛道几十个 CP、每个一张照片,
 *     工程 JSON 可能因此长到几 MB——但这对一个已经内嵌里程/海拔数组的 JSON
 *     文件不是数量级上的新问题。
 *     收益:**工程文件天生自包含**。`core/model/project.ts` 的设计前提就是
 *     "一个文件就是完整的工程"(连坐标系、配速参数都在里面),导出后拷到
 *     另一台机器、甚至直接用别的 GIS 工具打开,不需要伴随任何"记得把照片
 *     文件夹也发过去"的手动步骤——导出即可用,重新导入照片原样还在,这正是
 *     任务要求的"project export must remain usable"里最直接的读法。
 *  2. **(否决)原图/缩放图存 Blob 到 IndexedDB 的独立 photos 表,工程 JSON
 *     里只留一个 id。** 省了 base64 的 33% 膨胀,读写工程时也更快;但导出
 *     的工程 JSON 文件本身会变成"半个工程"——照片引用在,数据不在,导出后
 *     发给别人 / 换一台电脑重新导入,CP 卡片上的照片全部消失,而且是那种
 *     "静默变成空白,不报错"的消失,正是 `docs/P0-验收记录.md` §五点名过
 *     不能再犯的那类问题。要保留这条路线的"导出可用"就得再实现一层"导出时
 *     把用到的 Blob 一起打进 zip",是这个里程碑范围之外的工作量。
 *  3. **(否决)只存一张更小的缩略图 data URI(比如 320px),原图完全丢弃。**
 *     体积最小,但"缩略图"这个词本身在暗示"还有个原图在别处"，实际上没有
 *     ——用户以为的"我的照片"其实已经不可逆地被砍成一张小图。选 1 已经在
 *     缩放,不需要为了再省那几十 KB 多一层"缩略图 vs 原图"的心智负担;
 *     `MAX_DIMENSION_PX=1440` 本身就是"够用的分辨率",不是"缩略图"。
 *
 * 因为方案 1 把"图"和"引用"焊死在同一个字段里,`updateCp(id, { photoUrl:
 * undefined })` 清空引用就是清空全部存储——不存在需要额外回收的孤儿 Blob,
 * 也就不需要方案 2 会需要的那套"storage-key 记账"逻辑(P3-R2 任务描述里
 * 提到的"unit test any storage-key/reference bookkeeping"，在方案 1 下
 * 根本不存在这类记账要测)。
 *
 * ## EXIF 剥离
 * `downscale.ts` 通过 canvas 重新编码而不是直接转发原始字节,天然清除了
 * 原图的全部 EXIF(包括 GPS、拍摄时间)——`photoUrl` 里存的、连同导出文件
 * 里带出去的,都是"干净"的图。这不是额外做的一步,是选了"缩放"这条路
 * 之后免费获得的副作用,但后果是刻意想要的:工程 JSON 经常会被整个分享
 * 给别人当路书用,照片本身不该在导出后继续携带作者在起点拍照时的精确
 * GPS/时间。锚定阶段(commit 3)用到的 GPS/时间只存在于内存里的解析结果、
 * 只落进 `CheckPoint.anchorIndex`(一个轨迹点下标,不是坐标)和可选的
 * `cutoffTime` 类字段,不会连同 EXIF 原文一起写进工程文件。
 */
import { parseExif, type ExifData } from './exif'
import { downscaleAndReorient } from './downscale'

export interface AttachedPhoto {
  /** 缩放、摆正、EXIF 已剥离的 JPEG data URI——可以直接赋给 `CheckPoint.photoUrl`。 */
  photoUrl: string
  /** 原图 EXIF 解析出的 GPS(如果有);WGS-84,见 `exif.ts` 顶部说明。 */
  gps?: { lat: number; lon: number }
  /** 原图 EXIF 解析出的拍摄时间(如果有),毫秒时间戳。 */
  dateTimeOriginalMs?: number
}

export type AttachPhotoResult = { ok: true; photo: AttachedPhoto } | { ok: false; message: string }

/**
 * `file` 通常来自 `<input type="file">`。永远不抛异常——任何失败都归一成
 * `{ ok: false, message }`,调用方直接把 message 展示给用户,不需要自己再
 * 拼错误文案。
 */
export async function attachPhoto(file: File): Promise<AttachPhotoResult> {
  let exifData: ExifData = {}
  try {
    const buf = await file.arrayBuffer()
    const exifResult = parseExif(buf)
    if (!exifResult.ok) {
      // HEIC 是浏览器原生解码大概率也会失败的格式(尤其非 Apple 平台),
      // 与其让下面的 createImageBitmap 抛一个用户看不懂的底层错误,不如
      // 在这里就用 exif.ts 已经准备好的中文说明直接拦下来。
      if (exifResult.reason === 'unsupported-format' && exifResult.format === 'heic') {
        return { ok: false, message: exifResult.detail }
      }
      // 其余情况(EXIF 段损坏、不是 JPEG 但也不是 HEIC 比如 PNG)不代表
      // 图片本身不能显示——EXIF 只是元数据,PNG 这类格式本来就通常不带
      // EXIF——继续往下走,让浏览器自己的解码器试一次,拿不到 GPS/方向/
      // 拍摄时间就当没有,不是错误。
    } else {
      exifData = exifResult.data
    }
  } catch (e) {
    return { ok: false, message: `无法读取该照片的 EXIF 信息:${e instanceof Error ? e.message : String(e)}` }
  }

  try {
    const photoUrl = await downscaleAndReorient(file, exifData.orientation)
    return {
      ok: true,
      photo: { photoUrl, gps: exifData.gps, dateTimeOriginalMs: exifData.dateTimeOriginalMs },
    }
  } catch (e) {
    return { ok: false, message: `无法解码该图片(可能不是受支持的图片格式):${e instanceof Error ? e.message : String(e)}` }
  }
}
