/*
 * List state lives in the URL query string (shareable, works with Back, §10.4). Pages read params with
 * useParams() and change them with set(); multi-value filters are comma-separated.
 */
import { useNavigate, useSearch } from "@tanstack/react-router"
import * as React from "react"

export type Params = Record<string, string | undefined>

export function useParams(): [Params, (patch: Params, opts?: { replace?: boolean }) => void] {
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const navigate = useNavigate()
  const params = React.useMemo(() => {
    const out: Params = {}
    for (const [k, v] of Object.entries(search)) if (v !== undefined && v !== null && v !== "") out[k] = String(v)
    return out
  }, [search])
  const set = React.useCallback(
    (patch: Params, opts?: { replace?: boolean }) => {
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => {
          const next: Record<string, unknown> = { ...prev, ...patch }
          for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === "") delete next[k]
          return next
        },
        replace: opts?.replace ?? true,
      })
    },
    [navigate],
  )
  return [params, set]
}

export function list(v: string | undefined): string[] {
  return v ? v.split(",").filter(Boolean) : []
}
