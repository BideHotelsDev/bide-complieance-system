/*
 * The browser-tab title for a screen, e.g. "People and roles · bide Comply" (UX audit F9). React 19 lifts a <title>
 * rendered anywhere into <head>, so each route renders one; the app name follows Appearance.
 */
import { useBranding } from "../lib/theme"

export function PageTitle({ title }: { title?: string }) {
  const { appName } = useBranding()
  return <title>{title ? `${title} · ${appName}` : appName}</title>
}
