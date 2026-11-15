/* Keyboard hints follow the device: ⌘K on Apple keyboards, Ctrl K elsewhere. */
const ua = typeof navigator === "undefined" ? "" : `${navigator.platform} ${navigator.userAgent}`
export const isApple = /Mac|iPhone|iPad|iPod/.test(ua)
export const searchShortcut = isApple ? "⌘K" : "Ctrl K"
