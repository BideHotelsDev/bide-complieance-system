/*
 * Location is read once, when a check is sent, never continuously (§9.6). A short timeout keeps the button quick; a
 * refusal or no fix simply sends without it.
 */
export type Fix = { lat: number; lng: number; accuracy: number }

export function locateOnce(timeoutMs = 5000): Promise<Fix | null> {
  if (!("geolocation" in navigator)) return Promise.resolve(null)
  return new Promise((resolve) => {
    const done = (v: Fix | null) => {
      clearTimeout(timer)
      resolve(v)
    }
    const timer = setTimeout(() => resolve(null), timeoutMs + 500)
    try {
      navigator.geolocation.getCurrentPosition(
        (p) => done({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
        () => done(null),
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 },
      )
    } catch {
      done(null)
    }
  })
}
