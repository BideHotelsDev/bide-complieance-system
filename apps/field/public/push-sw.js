/* global self, clients, URL */
/*
 * Web push for the staff app (PRD §7 Channels, §10.8). Imported by the service worker vite-plugin-pwa generates
 * (vite.config.ts, workbox.importScripts). The API's worker sends {title, body, link, tag} (worker.send_push).
 * Links to staff-app screens open in the app; anything else (an Action, Approvals) opens the management portal.
 */
const FIELD = /^\/(task\/[^/?#]+|history|documents|me|report|contractor-visit)([/?#]|$)/

function target(link) {
  const scope = self.registration.scope
  if (!link) return scope
  if (/^https?:\/\//.test(link)) return link
  if (link === "/" || FIELD.test(link)) return new URL(link.slice(1), scope).href
  return new URL(link, self.location.origin).href
}

self.addEventListener("push", (event) => {
  let data
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: event.data ? event.data.text() : "" }
  }
  const icon = new URL("icon-192.png", self.registration.scope).href
  event.waitUntil(
    self.registration.showNotification(data.title || "bide Comply", {
      body: data.body || undefined,
      tag: data.tag || undefined,
      icon,
      badge: icon,
      data: { link: data.link || null },
    }),
  )
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const url = target(event.notification.data && event.notification.data.link)
  event.waitUntil(
    (async () => {
      const open = await clients.matchAll({ type: "window", includeUncontrolled: true })
      const inScope = (u) => u.startsWith(self.registration.scope)
      const same = open.find((c) => inScope(c.url) === inScope(url))
      if (same && "navigate" in same) {
        await same.focus()
        return same.navigate(url)
      }
      return clients.openWindow(url)
    })(),
  )
})
