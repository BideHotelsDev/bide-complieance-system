/*
 * Typed words that haven't been sent yet: a reject comment, an approval note, an Action's decision, a new Action's
 * description. They're kept in this tab's sessionStorage as they're typed, so switching to another item and back,
 * a reload, or an idle sign-out followed by signing in again doesn't lose them. Keyed by the signed-in person, so the
 * next person on a shared computer never sees them; sessionStorage also ends with the tab. Cleared once sent.
 */
import * as React from "react"

import { useMe } from "./session"

const PREFIX = "bc-draft:"

function read(k: string): string | null {
  try {
    return sessionStorage.getItem(k)
  } catch {
    return null
  }
}

function write(k: string, v: string) {
  try {
    if (v) sessionStorage.setItem(k, v)
    else sessionStorage.removeItem(k)
  } catch {
    // Private mode or storage full: the words still work, they just aren't kept.
  }
}

/**
 * Like useState for a text field, kept per person and `key` (e.g. "reject:<submission id>"). `initial` is used when
 * nothing is kept, e.g. a decision already saved on the server. Returns [value, set, clear].
 */
export function useDraft(key: string, initial = ""): [string, (v: string) => void, () => void] {
  const me = useMe().data?.id
  const k = me ? `${PREFIX}${me}:${key}` : null
  const [value, setValue] = React.useState(() => (k ? read(k) : null) ?? initial)
  // A different item (or the person loading) brings its own kept words, or the starting text. A new starting text
  // (the server's copy arriving or changing) shows only while nothing typed is kept.
  const [seen, setSeen] = React.useState({ k, initial })
  if (seen.k !== k || seen.initial !== initial) {
    setSeen({ k, initial })
    setValue((k ? read(k) : null) ?? initial)
  }
  const set = React.useCallback(
    (v: string) => {
      setValue(v)
      if (k) write(k, v === initial ? "" : v)
    },
    [k, initial],
  )
  const clear = React.useCallback(() => {
    setValue(initial)
    if (k) write(k, "")
  }, [k, initial])
  return [value, set, clear]
}

/* Remove everything kept for everyone in this tab: on a deliberate sign-out. */
export function clearDrafts() {
  try {
    for (const k of Object.keys(sessionStorage)) if (k.startsWith(PREFIX)) sessionStorage.removeItem(k)
  } catch {
    // Nothing to do.
  }
}
