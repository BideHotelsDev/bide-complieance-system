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

/* Metres between two points (haversine), as the server measures the geofence (services/checks.py). */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = 6371000
  const rad = (x: number) => (x * Math.PI) / 180
  const dp = rad(b.lat - a.lat)
  const dl = rad(b.lng - a.lng)
  const h = Math.sin(dp / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dl / 2) ** 2
  return 2 * r * Math.asin(Math.sqrt(h))
}

/* On site or not, only if the person has already allowed location (never prompts here; the check asks when sent). The
   fix is cached for a minute, so sending the check straight after reuses it rather than reading again. */
export async function onSite(site: { lat: number; lng: number; radius_m: number }): Promise<boolean | null> {
  try {
    const perm = await navigator.permissions?.query({ name: "geolocation" as PermissionName })
    if (perm?.state !== "granted") return null
  } catch {
    return null
  }
  const fix = await locateOnce(4000)
  if (!fix) return null
  return distanceM(fix, site) <= site.radius_m + fix.accuracy
}
