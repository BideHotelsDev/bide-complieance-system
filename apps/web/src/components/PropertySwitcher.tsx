import { Building2, Check, ChevronsUpDown } from "lucide-react"
import { Popover as PopoverPrimitive } from "radix-ui"
import * as React from "react"

import { cn } from "@bide-comply/ui/lib/utils"

import { useProperty } from "@/lib/property"
import { useMe } from "@/lib/session"

export function PropertySwitcher() {
  const me = useMe().data
  const { property, setPropertyId } = useProperty()
  const [open, setOpen] = React.useState(false)
  if (!me) return null
  const n = me.properties.length
  const single = n === 1
  const allLabel = me.all_properties ? "All properties" : me.spvs.length ? me.spvs[0] : "Your properties"
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label={`Choose property, currently ${property?.name ?? allLabel}`}
          className="flex w-full items-center gap-2.5 rounded-[10px] border border-border bg-surface px-2.5 py-2 text-left text-[13px]"
        >
          <span className="inline-flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-primary text-[11px] font-bold text-primary-foreground">
            {property ? property.code : <Building2 className="size-4" />}
          </span>
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-[14px] font-semibold">
              {property?.name ?? (single ? me.properties[0].name : allLabel)}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {property ? "Change property" : single ? me.properties[0].town : `All ${n} properties`}
            </span>
          </span>
          {!single && <ChevronsUpDown className="size-4 text-muted-foreground" />}
        </button>
      </PopoverPrimitive.Trigger>
      {!single && (
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            align="start"
            sideOffset={6}
            className="z-50 w-[240px] rounded-lg border border-border bg-popover p-1.5 shadow-lg"
          >
            <div role="listbox" aria-label="Properties">
              {[
                { id: null as string | null, name: allLabel, code: "", town: `All ${n} properties` },
                ...me.properties,
              ].map((p) => (
                <button
                  key={p.id ?? "all"}
                  type="button"
                  role="option"
                  aria-selected={(property?.id ?? null) === p.id}
                  onClick={() => {
                    setPropertyId(p.id)
                    setOpen(false)
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-hover"
                >
                  <span className="inline-flex h-5 w-7 shrink-0 items-center justify-center rounded bg-hover text-[10.5px] font-semibold text-ink2">
                    {p.code || "All"}
                  </span>
                  <span className="flex-1 truncate">{p.name}</span>
                  <Check className={cn("size-4", (property?.id ?? null) === p.id ? "opacity-100" : "opacity-0")} />
                </button>
              ))}
            </div>
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      )}
    </PopoverPrimitive.Root>
  )
}
