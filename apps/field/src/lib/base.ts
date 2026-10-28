/* The staff app is served under /app/ in production (one image with the portal) and at / in development. */
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "")

/** An app path ("/signin") as a URL the browser can open ("/app/signin" in production). */
export function appPath(p: string): string {
  return BASE + (p.startsWith("/") ? p : `/${p}`)
}

export const basepath = BASE || "/"
