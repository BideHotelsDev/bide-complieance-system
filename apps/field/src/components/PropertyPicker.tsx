import { Check } from "lucide-react"

import { useMe, useProperty } from "@/lib/session"

import { Sheet } from "./Sheet"

/* Switch property (only offered to people who work at more than one). */
export function PropertyPicker({ onClose }: { onClose: () => void }) {
  const me = useMe()
  const { propertyId, setPropertyId } = useProperty()
  return (
    <Sheet open onClose={onClose} title="Switch property">
      <div className="flex flex-col pb-4">
        {me.data?.properties.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={p.id === propertyId}
            onClick={() => {
              setPropertyId(p.id)
              onClose()
            }}
            className="flex min-h-[52px] items-center justify-between border-b border-divider text-left text-[16px] last:border-0"
          >
            <span>
              {p.name}
              {p.town && <span className="text-muted-foreground"> · {p.town}</span>}
            </span>
            {p.id === propertyId && <Check aria-hidden className="size-5" />}
          </button>
        ))}
      </div>
    </Sheet>
  )
}
