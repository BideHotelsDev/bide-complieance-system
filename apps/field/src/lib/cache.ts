/*
 * Today's and overdue tasks stay readable with no signal (EXE-06, §8 Offline). The last good answer for each cached
 * path is kept in IndexedDB; when the network is unreachable the app shows that copy instead. Only the paths a
 * person needs to do their checks are cached: staff documents are never kept on the phone.
 */
import { api, ApiError, qs, type Query } from "@bide-comply/api-client"
import { clear, createStore, get, set } from "idb-keyval"

const store = createStore("bide-comply-cache", "responses")

type Hit<T> = { at: number; data: T }

export async function cachedGet<T>(path: string, q?: Query): Promise<T> {
  const key = path + qs(q)
  try {
    const data = await api.get<T>(path, q)
    void set(key, { at: Date.now(), data } satisfies Hit<T>, store).catch(() => undefined)
    return data
  } catch (e) {
    if (e instanceof ApiError && e.status === 0) {
      const hit = await get<Hit<T>>(key, store).catch(() => undefined)
      if (hit) return hit.data
    }
    throw e
  }
}

export function clearCache(): Promise<void> {
  return clear(store)
}
