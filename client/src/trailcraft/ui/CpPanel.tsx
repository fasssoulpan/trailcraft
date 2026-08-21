import { useState } from 'react'
import { useAppStore } from '../state/appStore'
import { CP_KIND_LABELS, CP_KIND_MARKS, CP_KIND_OPTIONS, type CpKind } from '../core/model/checkpoint'
import { isoToLocalInputValue, localInputValueToIso } from '../core/util/localTime'
import { attachPhoto } from '../core/photo/attachPhoto'
import { anchorPhotosToTrack, type PhotoGpsInput } from '../core/pipeline/photoAnchor'
import { Section } from './primitives/Section'
import { Button } from './primitives/Button'

/** ± 按钮每次挪动锚点的全精度轨迹点数;够小以便精细纠偏,又不至于点半天挪不动。 */
const ANCHOR_NUDGE_STEP = 5

type PhotoUploadStatus = { phase: 'loading' } | { phase: 'error'; message: string }

type BatchPhotoStatus =
  | { phase: 'loading' }
  | {
      phase: 'done'
      createdCount: number
      updatedCount: number
      /** 有 GPS 但离轨迹太远,被 anchorPhotosToTrack 拒绝的照片。 */
      rejected: { name: string; distanceM: number }[]
      /** 完全没有 GPS 的照片——不是错误,只是无法自动定位,列出来提醒用户
       * 去下面对应 CP(或新建的 CP)手动添加。 */
      noGps: string[]
      /** EXIF/图片本身解析失败的照片(如 HEIC、损坏文件)。 */
      failed: { name: string; message: string }[]
    }

// datetime-local <-> ISO 8601(含时区)的转换约定见 core/util/localTime.ts 顶部
// 注释;PacePanel.tsx 的起跑时间输入复用同一份实现。

export function CpPanel() {
  const tracks = useAppStore((s) => s.tracks)
  const activeTrackId = useAppStore((s) => s.activeTrackId)
  const allCps = useAppStore((s) => s.cps)
  const updateCp = useAppStore((s) => s.updateCp)
  const removeCp = useAppStore((s) => s.removeCp)
  const reorderCp = useAppStore((s) => s.reorderCp)
  const addPhotoCheckpoints = useAppStore((s) => s.addPhotoCheckpoints)
  const reclassifyTrackCheckpoints = useAppStore((s) => s.reclassifyTrackCheckpoints)

  // 每个 CP 独立的照片上传状态(进行中/出错),不是 CheckPoint 本身的字段
  // ——这是纯粹的会话态交互反馈,和 hover/drawCursor 同一类,上传成功后
  // 结果直接写回 photoUrl,状态条目也就没用了,不需要持久化。
  const [photoStatus, setPhotoStatus] = useState<Record<string, PhotoUploadStatus>>({})
  const [reclassifyNotice, setReclassifyNotice] = useState<string | undefined>(undefined)

  async function handlePhotoPick(cpId: string, file: File | undefined) {
    if (!file) return
    setPhotoStatus((s) => ({ ...s, [cpId]: { phase: 'loading' } }))
    const result = await attachPhoto(file)
    if (result.ok) {
      updateCp(cpId, { photoUrl: result.photo.photoUrl })
      setPhotoStatus((s) => {
        const next = { ...s }
        delete next[cpId]
        return next
      })
    } else {
      setPhotoStatus((s) => ({ ...s, [cpId]: { phase: 'error', message: result.message } }))
    }
  }

  function removePhoto(cpId: string) {
    // photoUrl 是照片数据本身(缩放后的 data URI,见 attachPhoto.ts 的存储
    // 决策注释),不是指向别处存储的 id——清空这个字段就是清空全部存储,
    // 不存在需要额外回收的孤儿数据。
    updateCp(cpId, { photoUrl: undefined })
  }

  const activeTrack = tracks.find((t) => t.id === activeTrackId)
  // CheckPoint.trackId (core/model/checkpoint.ts) is the source of truth for
  // which track a CP belongs to -- s.cps holds every track's CPs at once, so
  // this panel must only show/edit the active track's subset, or switching
  // tracks would display (and let the user edit) CPs anchored against a
  // completely different track's geometry.
  const cps = activeTrackId ? allCps.filter((c) => c.trackId === activeTrackId) : []

  function nudge(cp: (typeof cps)[number], delta: number) {
    if (!activeTrack) return
    const n = activeTrack.points.lon.length
    const next = Math.min(n - 1, Math.max(0, cp.anchorIndex + delta))
    if (next === cp.anchorIndex) return
    updateCp(cp.id, { anchorIndex: next })
  }

  // 批量照片锚定(P3-R2 commit 3)的会话态结果反馈,和 photoStatus 同一类
  // ——不持久化,展示一次就够了。
  const [batchStatus, setBatchStatus] = useState<BatchPhotoStatus | undefined>(undefined)

  async function handleBatchPhotos(fileList: FileList | null) {
    if (!fileList || fileList.length === 0 || !activeTrack) return
    setBatchStatus({ phase: 'loading' })
    const files = Array.from(fileList)
    // 每张照片独立读取/解码/缩放,互不阻塞(和 ImportPanel.tsx 批量导入
    // 轨迹文件同一个并发策略),单张失败不影响其它照片继续处理。
    const attached = await Promise.all(files.map(async (file) => ({ file, result: await attachPhoto(file) })))

    const withGps: PhotoGpsInput[] = []
    const noGps: string[] = []
    const failed: { name: string; message: string }[] = []
    for (const { file, result } of attached) {
      if (!result.ok) {
        failed.push({ name: file.name, message: result.message })
        continue
      }
      if (!result.photo.gps) {
        // 没有 GPS 不是错误——EXIF 里压根没有这个信息很常见(见
        // attachPhoto.ts/exif.ts 的说明),留给用户在下面手动挑一个 CP 贴上。
        noGps.push(file.name)
        continue
      }
      withGps.push({
        name: file.name.replace(/\.[^.]+$/, ''), // 去掉扩展名当默认 CP 名,用户可改
        lat: result.photo.gps.lat,
        lon: result.photo.gps.lon,
        photoUrl: result.photo.photoUrl,
        dateTimeOriginalMs: result.photo.dateTimeOriginalMs,
      })
    }

    // anchorPhotosToTrack 要求 existingCps 已经按 track 过滤过——`cps`
    // 正好就是这个组件顶部已经按 activeTrackId 过滤出来的子集。
    const anchorResult = anchorPhotosToTrack(activeTrack, cps, withGps)
    addPhotoCheckpoints(anchorResult.created, anchorResult.updated)

    setBatchStatus({
      phase: 'done',
      createdCount: anchorResult.created.length,
      updatedCount: anchorResult.updated.length,
      rejected: anchorResult.rejected.map((r) => ({ name: r.input.name, distanceM: Math.round(r.distanceM) })),
      noGps,
      failed,
    })
  }

  return (
    <Section
      title="CP 检查点"
      description="在地图上点击轨迹附近位置添加检查点，或从带 GPS 的照片批量生成；可设置关门时间用于配速预警。"
    >
      {activeTrack && (
        <>
          <p className="cp-panel__hint cp-panel__hint--privacy">
            照片仅在本机本地处理和保存,不会上传到任何服务器。
          </p>
          <div className="cp-panel__batch">
            <div className="cp-panel__row">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const changed = reclassifyTrackCheckpoints(activeTrack.id)
                  setReclassifyNotice(changed > 0 ? `已按名称重新分类 ${changed} 个标记。` : '当前标记已符合分类规则。')
                }}
              >
                按名称重新分类标记
              </Button>
              {reclassifyNotice && <span className="cp-panel__hint">{reclassifyNotice}</span>}
            </div>
            <label className="cp-panel__batch-pick">
              从照片批量生成 CP(自动读取 EXIF GPS)
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={(e) => {
                  void handleBatchPhotos(e.target.files)
                  e.target.value = ''
                }}
              />
            </label>
            {batchStatus?.phase === 'loading' && <p className="cp-panel__hint">正在读取照片 EXIF 并锚定…</p>}
            {batchStatus?.phase === 'done' && (
              <div className="cp-panel__batch-result">
                <p className="cp-panel__hint">
                  新建 {batchStatus.createdCount} 个 CP,更新了 {batchStatus.updatedCount} 个已有 CP 的照片。
                </p>
                {batchStatus.noGps.length > 0 && (
                  <p className="cp-panel__hint">
                    {batchStatus.noGps.length} 张照片没有 GPS 信息,已跳过——可在下面对应的 CP 上手动添加:
                    {batchStatus.noGps.join('、')}
                  </p>
                )}
                {batchStatus.rejected.length > 0 && (
                  <p className="cp-panel__hint cp-panel__hint--warn">
                    {batchStatus.rejected.length} 张照片离轨迹太远,已跳过:
                    {batchStatus.rejected.map((r) => `${r.name}(约 ${r.distanceM}m)`).join('、')}
                  </p>
                )}
                {batchStatus.failed.length > 0 && (
                  <p className="cp-panel__hint cp-panel__hint--warn">
                    {batchStatus.failed.length} 张照片无法处理:
                    {batchStatus.failed.map((f) => `${f.name}(${f.message})`).join('、')}
                  </p>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {cps.length === 0 && (
        <p className="cp-panel__hint">
          在地图上点击轨迹附近位置以添加 CP{activeTrack ? ',或用上面的批量照片功能自动生成' : ''}
        </p>
      )}
      {!activeTrack && cps.length > 0 && (
        <p className="cp-panel__hint">未选中轨迹,里程/海拔暂无法计算</p>
      )}

      {cps.length > 0 && (
        <ul className="cp-panel__list">
          {cps.map((cp, i) => {
            const km = activeTrack?.points.cumDist ? activeTrack.points.cumDist[cp.anchorIndex] / 1000 : undefined
            const ele = activeTrack?.points.ele ? activeTrack.points.ele[cp.anchorIndex] : undefined
            const n = activeTrack?.points.lon.length ?? 0

            return (
              <li key={cp.id} className="cp-panel__item">
                <div className="cp-panel__row">
                  <span className="cp-panel__ordinal">{i + 1}</span>
                  <input
                    type="text"
                    className="cp-panel__name"
                    value={cp.name}
                    onChange={(e) => updateCp(cp.id, { name: e.target.value })}
                  />
                  <select
                    value={cp.kind}
                    onChange={(e) => updateCp(cp.id, { kind: e.target.value as CpKind })}
                  >
                    {CP_KIND_OPTIONS.map((k) => (
                      <option key={k} value={k}>
                        {CP_KIND_MARKS[k]} {CP_KIND_LABELS[k]}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="cp-panel__row cp-panel__row--meta">
                  <span>{km !== undefined ? `${km.toFixed(2)} km` : '-- km'}</span>
                  <span>{ele !== undefined && !Number.isNaN(ele) ? `${ele.toFixed(0)} m` : '-- m'}</span>
                  <span className="cp-panel__anchor-index">点 #{cp.anchorIndex}</span>
                </div>

                <div className="cp-panel__row cp-panel__photo-row">
                  {cp.photoUrl && (
                    <div className="cp-panel__photo-preview">
                      <img src={cp.photoUrl} alt="" className="cp-panel__photo-thumb" />
                      <Button size="sm" variant="ghost" className="cp-panel__photo-remove" onClick={() => removePhoto(cp.id)}>
                        移除照片
                      </Button>
                    </div>
                  )}
                  <label className="cp-panel__photo-pick">
                    {cp.photoUrl ? '更换照片' : '添加照片'}
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => {
                        void handlePhotoPick(cp.id, e.target.files?.[0])
                        e.target.value = '' // 允许重复选中同一个文件
                      }}
                    />
                  </label>
                  {photoStatus[cp.id]?.phase === 'loading' && (
                    <span className="cp-panel__photo-status">处理中…</span>
                  )}
                  {photoStatus[cp.id]?.phase === 'error' && (
                    <span className="cp-panel__photo-status cp-panel__photo-status--error">
                      {(photoStatus[cp.id] as { phase: 'error'; message: string }).message}
                    </span>
                  )}
                </div>

                <div className="cp-panel__row">
                  <label className="cp-panel__field">
                    关门时间
                    <input
                      type="datetime-local"
                      value={isoToLocalInputValue(cp.cutoffTime)}
                      onChange={(e) => updateCp(cp.id, { cutoffTime: localInputValueToIso(e.target.value) })}
                    />
                  </label>
                </div>

                <div className="cp-panel__row cp-panel__row--actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!activeTrack || cp.anchorIndex <= 0}
                    onClick={() => nudge(cp, -ANCHOR_NUDGE_STEP)}
                    title="锚点前移"
                  >
                    锚点 −
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!activeTrack || cp.anchorIndex >= n - 1}
                    onClick={() => nudge(cp, ANCHOR_NUDGE_STEP)}
                    title="锚点后移"
                  >
                    锚点 ＋
                  </Button>
                  <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => reorderCp(cp.id, -1)}>
                    上移
                  </Button>
                  <Button size="sm" variant="ghost" disabled={i === cps.length - 1} onClick={() => reorderCp(cp.id, 1)}>
                    下移
                  </Button>
                  <Button size="sm" variant="danger" className="cp-panel__remove" onClick={() => removeCp(cp.id)}>
                    删除
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Section>
  )
}
