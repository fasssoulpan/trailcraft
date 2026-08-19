/**
 * Shared "hand a `Blob` to the browser's normal file-download UI" boilerplate
 * -- originally inline in `recorder.ts`'s `MediaRecorder#onstop` (P1
 * milestone N5), factored out so P2 Q4's MP4 export path
 * (`frameExport.ts`) can reuse the exact same anchor-click-and-revoke
 * dance instead of duplicating it for a second file type.
 */

/** How long to wait before revoking the object URL -- gives the browser's
 * own download handling time to actually read the blob first (matches the
 * reference implementation's own 3s delay, per `recorder.ts`'s original
 * comment on this constant). */
const REVOKE_DELAY_MS = 3000

/** Sanitises a track/project name into a filesystem-safe filename stem --
 * strips characters invalid on Windows (also the strictest of the desktop
 * targets) and falls back to `fallback` for a name that's empty (or entirely
 * made of invalid characters) after stripping. */
export function sanitizeFilenameStem(name: string, fallback: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_') || fallback
}

/** `YYYY-MM-DD-HH-MM-SS`, filesystem-safe (no colons), for a download
 * filename's timestamp suffix. */
export function filenameTimestamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
}

/**
 * Triggers a normal browser download of `blob` as `filename` via a
 * momentary, never-attached `<a download>` element -- the same mechanism
 * every "save this generated file" flow in this codebase uses (there is no
 * backend to POST a file to; see this project's "no server" README framing).
 * The object URL is revoked `REVOKE_DELAY_MS` after the click rather than
 * immediately, for the reason `REVOKE_DELAY_MS`'s own doc comment gives.
 */
export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS)
}
