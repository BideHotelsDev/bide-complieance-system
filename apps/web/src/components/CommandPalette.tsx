/*
 * ⌘K / Ctrl+K: one search for everything (design: Components › Global search). Results grouped by type, keyboard
 * first, each carrying its status so you can triage without opening it, and the scope shown. Recent items show
 * before typing.
 */
import { useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Command } from "cmdk"
import { FileText, Search } from "lucide-react"
import { Dialog as DialogPrimitive } from "radix-ui"
import * as React from "react"

import { api } from "@bide-comply/api-client"
import { ClassBadge, PriorityBadge, RagBadge, type Rag } from "@bide-comply/ui/components/status"

import { useProperty } from "@/lib/property"

type Item = {
  id: string
  ref?: string
  title: string
  sub?: string
  class?: string
  status?: string
  priority?: string
  link: string
}
type Group = { type: string; label: string; items: Item[] }
const RECENT = "bc-recent"

function recent(): Item[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT) ?? "[]") as Item[]
  } catch {
    return []
  }
}

function remember(it: Item) {
  try {
    localStorage.setItem(RECENT, JSON.stringify([it, ...recent().filter((r) => r.link !== it.link)].slice(0, 6)))
  } catch {
    /* ignore */
  }
}

function Highlight({ text, q }: { text: string; q: string }) {
  if (q.length < 2) return <>{text}</>
  const i = text.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, i)}
      <strong className="font-semibold">{text.slice(i, i + q.length)}</strong>
      {text.slice(i + q.length)}
    </>
  )
}

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [q, setQ] = React.useState("")
  const [debounced, setDebounced] = React.useState("")
  const navigate = useNavigate()
  const { propertyId } = useProperty()
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250)
    return () => clearTimeout(t)
  }, [q])
  const res = useQuery({
    queryKey: ["search", debounced, propertyId],
    queryFn: () =>
      api.get<{ groups: Group[]; scope_label: string }>("/api/search", { q: debounced, property: propertyId }),
    enabled: open && debounced.length >= 2,
  })
  const go = (it: Item) => {
    remember(it)
    onOpenChange(false)
    setQ("")
    void navigate({ to: it.link })
  }
  const groups =
    debounced.length >= 2 ? (res.data?.groups ?? []) : [{ type: "recent", label: "Recent", items: recent() }]
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/30" />
        <DialogPrimitive.Content
          aria-label="Search"
          className="fixed top-[12vh] left-1/2 z-50 w-[min(640px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover shadow-2xl"
        >
          <DialogPrimitive.Title className="sr-only">Search everything</DialogPrimitive.Title>
          <Command shouldFilter={false} label="Search everything">
            <div className="flex items-center gap-2 border-b border-divider px-3.5">
              <Search className="size-4 text-muted-foreground" />
              <Command.Input
                value={q}
                onValueChange={setQ}
                placeholder="Search checks, actions, people, certificates…"
                aria-label="Search everything"
                className="h-12 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
              />
              <kbd className="rounded border border-border px-1.5 text-[11px] text-subtle">Esc</kbd>
            </div>
            <Command.List className="max-h-[420px] overflow-y-auto p-1.5">
              {debounced.length >= 2 && res.data && groups.length === 0 && (
                <Command.Empty className="px-3 py-8 text-center text-[13px] text-muted-foreground">
                  No results for "{debounced}".
                </Command.Empty>
              )}
              {debounced.length < 2 && groups[0].items.length === 0 && (
                <div className="px-3 py-6 text-center text-[13px] text-muted-foreground">
                  Type to search checks, actions, people and certificates.
                </div>
              )}
              {groups.map((g) =>
                g.items.length ? (
                  <Command.Group
                    key={g.type}
                    heading={`${g.label} · ${g.items.length}`}
                    className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
                  >
                    {g.items.map((it) => (
                      <Command.Item
                        key={it.link + it.id}
                        value={it.link + it.id}
                        onSelect={() => go(it)}
                        className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-[13.5px] data-[selected=true]:bg-hover"
                      >
                        {it.class ? <ClassBadge klass={it.class} /> : <FileText className="size-4 text-subtle" />}
                        <span className="min-w-0 flex-1 truncate">
                          <Highlight text={it.title} q={debounced} />
                          {(it.ref || it.sub) && (
                            <span className="ml-2 text-xs text-muted-foreground">
                              {[it.ref, it.sub].filter(Boolean).join(" · ")}
                            </span>
                          )}
                        </span>
                        {it.status && ["green", "amber", "red", "grey"].includes(it.status) && (
                          <RagBadge status={it.status as Rag} />
                        )}
                        {it.priority && <PriorityBadge priority={it.priority as "high" | "med" | "low"} />}
                      </Command.Item>
                    ))}
                  </Command.Group>
                ) : null,
              )}
            </Command.List>
            <div className="flex gap-4 border-t border-divider px-3.5 py-2 text-xs text-muted-foreground">
              <span>↑ ↓ move</span>
              <span>↵ open</span>
              <span className="ml-auto">
                {res.data?.scope_label ?? (propertyId ? "Searching this property" : "Searching all your properties")}
              </span>
            </div>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
