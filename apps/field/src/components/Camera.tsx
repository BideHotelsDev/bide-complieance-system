/*
 * The in-app camera (design: AppCamera, EXE-02/03). Evidence photos are taken here, never picked from the gallery, and
 * the original is kept unaltered: the stamp line is shown over the viewfinder, not burnt into the image (the server
 * records who, where and when). Where a live camera isn't available (desktop, some webviews) the phone's own camera
 * is opened through a capture input instead, which is still a camera capture.
 */
import { X, Zap, ZapOff } from "lucide-react"
import * as React from "react"

import { fmtStamp } from "@/lib/format"

type Props = {
  title: string
  hint?: string
  index: number
  total: number
  /* "<property> · <ref> · <P. Mathers>"; the date and time are added live. */
  stampPrefix: string
  exampleUrl?: string | null
  onClose: () => void
  onCapture: (blob: Blob, capturedAt: string) => void
}

export function Camera({ title, hint, index, total, stampPrefix, exampleUrl, onClose, onCapture }: Props) {
  const [now, setNow] = React.useState(() => new Date())
  React.useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000)
    return () => clearInterval(t)
  }, [])
  const video = React.useRef<HTMLVideoElement>(null)
  const fileInput = React.useRef<HTMLInputElement>(null)
  const [stream, setStream] = React.useState<MediaStream | null>(null)
  const [fallback, setFallback] = React.useState(false)
  const [torch, setTorch] = React.useState(false)
  const [torchOk, setTorchOk] = React.useState(false)
  const [example, setExample] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const closeRef = React.useRef<HTMLButtonElement>(null)
  const onCloseRef = React.useRef(onClose)
  React.useEffect(() => {
    onCloseRef.current = onClose
  })

  React.useEffect(() => {
    let cancelled = false
    let s: MediaStream | null = null
    closeRef.current?.focus()
    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setFallback(true)
        return
      }
      try {
        s = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1440 } },
        })
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop())
          return
        }
        setStream(s)
        const caps = s.getVideoTracks()[0]?.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined
        setTorchOk(Boolean(caps?.torch))
      } catch {
        if (!cancelled) setFallback(true)
      }
    }
    void start()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current()
    }
    window.addEventListener("keydown", onKey)
    return () => {
      cancelled = true
      s?.getTracks().forEach((t) => t.stop())
      window.removeEventListener("keydown", onKey)
    }
  }, [])

  React.useEffect(() => {
    if (video.current && stream) {
      video.current.srcObject = stream
      void video.current.play().catch(() => undefined)
    }
  }, [stream])

  const toggleTorch = async () => {
    const track = stream?.getVideoTracks()[0]
    if (!track) return
    try {
      await track.applyConstraints({ advanced: [{ torch: !torch } as MediaTrackConstraintSet] })
      setTorch(!torch)
    } catch {
      setTorchOk(false)
    }
  }

  const shoot = () => {
    if (fallback || !stream) {
      fileInput.current?.click()
      return
    }
    const v = video.current
    if (!v || !v.videoWidth) return
    setBusy(true)
    const at = new Date().toISOString()
    const canvas = document.createElement("canvas")
    canvas.width = v.videoWidth
    canvas.height = v.videoHeight
    canvas.getContext("2d")?.drawImage(v, 0, 0)
    canvas.toBlob(
      (blob) => {
        setBusy(false)
        if (blob) onCapture(blob, at)
      },
      "image/jpeg",
      0.9,
    )
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Camera: ${title}`}
      className="fixed inset-0 z-50 mx-auto flex max-w-[480px] flex-col bg-black text-white"
    >
      <div className="flex items-center justify-between px-3 pt-3">
        <button
          ref={closeRef}
          type="button"
          aria-label="Close camera"
          onClick={onClose}
          className="flex size-12 items-center justify-center rounded-full bg-white/10"
        >
          <X aria-hidden className="size-5" />
        </button>
        <span className="rounded-full bg-white/10 px-3 py-1.5 text-[14px] font-semibold">
          Photo {index} of {total}
        </span>
        <span className="size-12" />
      </div>
      <div className="px-6 pt-3 text-center">
        <h2 className="m-0 text-[18px] font-semibold">{title}</h2>
        {hint && <p className="m-0 mt-0.5 text-[14.5px] text-white/75">{hint}</p>}
      </div>
      <div className="relative mx-3.5 mt-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-white/10">
        {stream && !fallback ? (
          <video ref={video} playsInline muted className="absolute inset-0 size-full object-cover" aria-label="Live camera view" />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center text-[14.5px] text-white/70">
            {fallback
              ? "Tap the shutter to open the camera."
              : "Starting the camera…"}
          </div>
        )}
        {example && exampleUrl && (
          <div className="absolute inset-0 flex flex-col bg-black/85 p-3">
            <img src={exampleUrl} alt={`Example: ${title}`} className="min-h-0 flex-1 rounded-lg object-contain" />
            <button type="button" onClick={() => setExample(false)} className="mt-2 h-12 rounded-xl bg-white/15 text-[15px] font-semibold">
              Back to camera
            </button>
          </div>
        )}
        <Corners />
        <div className="relative mx-3 mt-auto mb-3 rounded-md bg-black/70 px-2.5 py-1.5 font-mono text-[12px] leading-snug">
          {stampPrefix} · {fmtStamp(now)}
        </div>
      </div>
      <div className="flex items-center justify-between px-6 pt-4">
        {torchOk ? (
          <button
            type="button"
            aria-label={torch ? "Flash on" : "Flash off"}
            aria-pressed={torch}
            onClick={() => void toggleTorch()}
            className="flex size-12 items-center justify-center rounded-full bg-white/10"
          >
            {torch ? <Zap aria-hidden className="size-5" /> : <ZapOff aria-hidden className="size-5" />}
          </button>
        ) : (
          <span className="size-12" />
        )}
        <button
          type="button"
          aria-label="Take photo"
          disabled={busy}
          onClick={shoot}
          className="flex size-[78px] items-center justify-center rounded-full border-4 border-white"
        >
          <span className="size-[62px] rounded-full bg-white" />
        </button>
        {exampleUrl ? (
          <button
            type="button"
            aria-label="Show example photo"
            onClick={() => setExample(true)}
            className="size-12 rounded-lg bg-white/15 text-[12px] leading-tight font-semibold"
          >
            See example
          </button>
        ) : (
          <span className="size-12" />
        )}
      </div>
      <p className="pb-safe m-0 px-8 pt-3 pb-4 text-center text-[13px] text-white/60">
        Evidence photos are taken here, not picked from your gallery. The original is kept unaltered.
      </p>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        capture="environment"
        aria-label="Camera capture"
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ""
          if (f) onCapture(f, new Date().toISOString())
        }}
      />
    </div>
  )
}

function Corners() {
  const c = "pointer-events-none absolute size-7 border-white"
  return (
    <>
      <span aria-hidden className={`${c} top-4 left-4 rounded-tl-md border-t-[3px] border-l-[3px]`} />
      <span aria-hidden className={`${c} top-4 right-4 rounded-tr-md border-t-[3px] border-r-[3px]`} />
      <span aria-hidden className={`${c} bottom-16 left-4 rounded-bl-md border-b-[3px] border-l-[3px]`} />
      <span aria-hidden className={`${c} right-4 bottom-16 rounded-br-md border-r-[3px] border-b-[3px]`} />
    </>
  )
}
