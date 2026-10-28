/*
 * Who an Action goes to: a named person, or a contractor who fixes it through the contractor portal (§5.5).
 * Contractors who already work at the property come first. Values are "p:<id>" or "c:<id>".
 */
import { useQuery } from "@tanstack/react-query"

import { api, type ApiError } from "@bide-comply/api-client"

import type { Person } from "./types"
import { inputCls } from "./ui"

export type OwnerOptions = { people: Person[]; contractors: (Person & { here: boolean })[] }

export function useOwnerOptions(propertyId: string | null | undefined, enabled = true) {
  return useQuery<OwnerOptions, ApiError>({
    queryKey: ["action-owner-options", propertyId ?? null],
    queryFn: () => api.get<OwnerOptions>("/api/actions/owner-options", { property: propertyId ?? undefined }),
    staleTime: 300_000,
    enabled,
  })
}

/** The request body fields for a chosen value. */
export function ownerBody(value: string): { owner_id: string | null; owner_contractor_id: string | null } {
  if (value.startsWith("c:")) return { owner_id: null, owner_contractor_id: value.slice(2) }
  if (value.startsWith("p:")) return { owner_id: value.slice(2), owner_contractor_id: null }
  return { owner_id: null, owner_contractor_id: null }
}

export function ownerLabel(o: OwnerOptions | undefined, value: string): string | undefined {
  const id = value.slice(2)
  return value.startsWith("c:")
    ? o?.contractors.find((c) => c.id === id)?.name
    : o?.people.find((p) => p.id === id)?.name
}

export function OwnerSelect({
  id,
  value,
  onChange,
  options,
  empty,
}: {
  id?: string
  value: string
  onChange: (v: string) => void
  options: OwnerOptions | undefined
  empty: string
}) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={inputCls}>
      <option value="">{empty}</option>
      <optgroup label="People">
        {(options?.people ?? []).map((p) => (
          <option key={p.id} value={`p:${p.id}`}>
            {p.name}
            {p.sub ? ` · ${p.sub}` : ""}
          </option>
        ))}
      </optgroup>
      {(options?.contractors.length ?? 0) > 0 && (
        <optgroup label="Contractors (they mark it fixed with a photo)">
          {options!.contractors.map((c) => (
            <option key={c.id} value={`c:${c.id}`}>
              {c.name}
              {c.sub ? ` · ${c.sub}` : ""}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  )
}
