/*
 * Who does a check (design: Components › Done by combobox). A searchable list grouped into Pools, People and
 * Contractors with secondary text, a tick on the chosen one, and the golden-rule message under it: generic names
 * such as "TBC" or "Housekeeping" are not accepted (golden rule 2).
 */
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Check, ChevronDown } from "lucide-react"
import { api, ApiError } from "@bide-comply/api-client"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@bide-comply/ui/components/command"
import { Avatar } from "@bide-comply/ui/components/page"
import { Popover, PopoverContent, PopoverTrigger } from "@bide-comply/ui/components/popover"
import { Pill } from "@bide-comply/ui/components/status"
import { cn } from "@bide-comply/ui/lib/utils"

export type Kind = "pool" | "person" | "contractor" | "mode" | "clear"
export type Opt = { kind: Kind; id: string; label: string; secondary?: string; initials?: string }

type PoolRow = { id: string; name: string; property: string | null; members: { id: string; name: string }[] }
type PersonRow = {
  id: string
  name: string
  initials: string
  title: string | null
  roles: { label: string; property: string }[]
}
type ContractorRow = { id: string; name: string; trade: string | null }

const initialsOf = (n: string) =>
  n
    .replace(/[[\]]/g, "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("")

export function useAssignees(propertyId: string | null | undefined) {
  const pools = useQuery({
    queryKey: ["pools", propertyId ?? "all"],
    queryFn: () => api.get<{ rows: PoolRow[] }>("/api/pools", { property: propertyId ?? undefined }),
    staleTime: 60_000,
  })
  const people = useQuery({
    queryKey: ["people-options"],
    queryFn: () => api.get<{ rows: PersonRow[] }>("/api/people", { page_size: 100 }),
    staleTime: 60_000,
    retry: (n, e) => !(e instanceof ApiError && e.status === 403) && n < 2,
  })
  const contractors = useQuery({
    queryKey: ["contractors"],
    queryFn: () => api.get<{ rows: ContractorRow[] }>("/api/contractors"),
    staleTime: 60_000,
  })
  return React.useMemo(() => {
    const pool: Opt[] = (pools.data?.rows ?? []).map((p) => ({
      kind: "pool",
      id: p.id,
      label: p.name,
      secondary: p.members.length === 1 ? "1 person" : `${p.members.length} people`,
      initials: initialsOf(p.name),
    }))
    const person: Opt[] = (people.data?.rows ?? []).map((p) => ({
      kind: "person",
      id: p.id,
      label: p.name,
      secondary: p.roles[0] ? p.roles[0].label : (p.title ?? undefined),
      initials: p.initials,
    }))
    const contractor: Opt[] = (contractors.data?.rows ?? []).map((c) => ({
      kind: "contractor",
      id: c.id,
      label: c.name,
      secondary: c.trade ?? undefined,
      initials: initialsOf(c.name),
    }))
    return { pool, person, contractor, loading: pools.isLoading || people.isLoading || contractors.isLoading }
  }, [pools.data, people.data, contractors.data, pools.isLoading, people.isLoading, contractors.isLoading])
}

const GROUP_LABEL: Record<string, string> = {
  mode: "Verification",
  pool: "Pools",
  person: "People",
  contractor: "Contractors",
}

export function AssigneePicker({
  label,
  value,
  selected,
  options,
  invalid,
  error,
  footnote,
  placeholder = "Type a name",
  onPick,
  onFreeText,
  disabled,
  badge,
  className,
}: {
  label: string
  value: string
  selected?: { kind: Kind; id: string } | null
  options: { kind: Kind; items: Opt[] }[]
  invalid?: boolean
  error?: string | null
  footnote?: React.ReactNode
  placeholder?: string
  onPick: (o: Opt) => void
  onFreeText?: (text: string) => void
  disabled?: boolean
  badge?: React.ReactNode
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  const [search, setSearch] = React.useState("")
  const s = search.trim().toLowerCase()
  const groups = options
    .map((g) => ({
      ...g,
      items: s ? g.items.filter((o) => `${o.label} ${o.secondary ?? ""}`.toLowerCase().includes(s)) : g.items,
    }))
    .filter((g) => g.items.length > 0)
  const total = groups.reduce((n, g) => n + g.items.length, 0)
  const hi = (text: string) => {
    if (!s) return text
    const i = text.toLowerCase().indexOf(s)
    if (i < 0) return text
    return (
      <>
        {text.slice(0, i)}
        <strong className="font-semibold">{text.slice(i, i + s.length)}</strong>
        {text.slice(i + s.length)}
      </>
    )
  }
  return (
    <div className={cn("min-w-0", className)}>
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o)
          if (!o) setSearch("")
        }}
      >
        <PopoverTrigger asChild disabled={disabled}>
          <button
            type="button"
            aria-label={`${label}: ${value}`}
            aria-haspopup="listbox"
            aria-invalid={invalid || !!error || undefined}
            className={cn(
              "flex h-8 w-full min-w-0 items-center gap-1.5 rounded-md border px-2 text-left text-[13px] outline-none focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-default",
              invalid || error
                ? "border-st-red/60 bg-st-red-bg text-st-red"
                : "border-transparent hover:border-border disabled:hover:border-transparent",
              open && "border-st-blue bg-surface",
            )}
          >
            <span className="min-w-0 flex-1 truncate" title={value}>
              {value}
            </span>
            {badge}
            {!disabled && <ChevronDown aria-hidden className="size-3.5 shrink-0 opacity-60" />}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[300px] p-0">
          <Command shouldFilter={false} label={label}>
            <CommandInput
              value={search}
              onValueChange={setSearch}
              placeholder={placeholder}
              onKeyDown={(e) => {
                if (e.key === "Enter" && total === 0 && search.trim() && onFreeText) {
                  e.preventDefault()
                  onFreeText(search.trim())
                  setOpen(false)
                  setSearch("")
                }
              }}
            />
            <CommandList className="max-h-72">
              <CommandEmpty>
                {search.trim()
                  ? `No one called “${search.trim()}”. Press Enter to check it anyway.`
                  : "Nothing to choose from"}
              </CommandEmpty>
              {groups.map((g) => (
                <CommandGroup key={g.kind} heading={GROUP_LABEL[g.kind]}>
                  {g.items.map((o) => {
                    const on = selected?.kind === o.kind && selected.id === o.id
                    return (
                      <CommandItem
                        key={`${o.kind}-${o.id}`}
                        value={`${o.kind}-${o.id}`}
                        onSelect={() => {
                          onPick(o)
                          setOpen(false)
                          setSearch("")
                        }}
                        className="gap-2"
                      >
                        {o.kind !== "mode" && o.kind !== "clear" && (
                          <Avatar initials={o.initials ?? initialsOf(o.label)} className="size-6 text-[10px]" />
                        )}
                        <span className="min-w-0 flex-1 truncate">{hi(o.label)}</span>
                        {o.kind === "contractor" ? (
                          <Pill tone="grey" className="h-[18px] px-1.5 text-[11px]">
                            Contractor
                          </Pill>
                        ) : (
                          o.secondary && <span className="shrink-0 text-xs text-muted-foreground">{o.secondary}</span>
                        )}
                        {on && <Check aria-label="Chosen" className="size-4 text-foreground" />}
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              ))}
            </CommandList>
            {footnote && (
              <div className="border-t border-divider px-3 py-2 text-xs text-muted-foreground">{footnote}</div>
            )}
          </Command>
        </PopoverContent>
      </Popover>
      {error && (
        <div role="alert" className="mt-0.5 px-2 text-[11.5px] leading-snug text-st-red">
          {error}
        </div>
      )}
    </div>
  )
}
