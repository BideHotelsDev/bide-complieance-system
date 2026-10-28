/* A simple signature box: draw with a finger, Clear to start again. The value is a PNG data URL. */
import * as React from "react"

export function SignaturePad({
  value,
  onChange,
  labelledBy,
}: {
  value: string | null
  onChange: (v: string | null) => void
  labelledBy?: string
}) {
  const canvas = React.useRef<HTMLCanvasElement>(null)
  const drawing = React.useRef(false)
  const dirty = React.useRef(false)

  React.useEffect(() => {
    const c = canvas.current
    if (!c) return
    const ratio = window.devicePixelRatio || 1
    c.width = c.offsetWidth * ratio
    c.height = c.offsetHeight * ratio
    const ctx = c.getContext("2d")
    if (!ctx) return
    ctx.scale(ratio, ratio)
    ctx.lineWidth = 2.5
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    ctx.strokeStyle = getComputedStyle(c).color
  }, [])

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  return (
    <div>
      <canvas
        ref={canvas}
        role="img"
        aria-labelledby={labelledBy}
        aria-description={value ? "Signed" : "Not signed yet. Sign with your finger."}
        className="block h-40 w-full touch-none rounded-xl border border-dashed border-border bg-surface text-foreground"
        onPointerDown={(e) => {
          const ctx = canvas.current?.getContext("2d")
          if (!ctx) return
          e.currentTarget.setPointerCapture(e.pointerId)
          drawing.current = true
          const p = pos(e)
          ctx.beginPath()
          ctx.moveTo(p.x, p.y)
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return
          const ctx = canvas.current?.getContext("2d")
          if (!ctx) return
          const p = pos(e)
          ctx.lineTo(p.x, p.y)
          ctx.stroke()
          dirty.current = true
        }}
        onPointerUp={() => {
          drawing.current = false
          if (dirty.current && canvas.current) onChange(canvas.current.toDataURL("image/png"))
        }}
      />
      <div className="mt-1.5 flex items-center justify-between text-[13.5px] text-muted-foreground">
        <span>{value ? "Signed" : "Sign with your finger"}</span>
        <button
          type="button"
          className="h-10 px-2 font-semibold text-link"
          onClick={() => {
            const c = canvas.current
            c?.getContext("2d")?.clearRect(0, 0, c.width, c.height)
            dirty.current = false
            onChange(null)
          }}
        >
          Clear
        </button>
      </div>
    </div>
  )
}
