# Frontend conventions

The source of truth for every screen is the product design canvas (40 artboards) and the PRD. Match the design's
layout, words and hierarchy. Where the design shows illustrative numbers, show the real numbers from the API.

## Apps and packages

| Path | What |
| --- | --- |
| `apps/web` | Management portal and admin CMS. Vite + React 19 + TanStack Router (code-based, `src/router.tsx`) + TanStack Query. Port 5180, proxies `/api` to the API on 8310. |
| `apps/field` | Staff app (installable PWA). Port 5181, same proxy. |
| `packages/ui` | Shared tokens (`styles.css`) and components. Import as `@bide-comply/ui/components/<file>` and `@bide-comply/ui/lib/utils`. |
| `packages/api-client` | `api.get/post/put/patch/del`, `upload()`, `download()`, `ApiError`. Import from `@bide-comply/api-client`. |

## UI kit (packages/ui/src/components)

- `status.tsx`: `Pill`, `RagBadge` (Green/Amber/Red/Grey), `TaskBadge`, `GateItemBadge`, `GateBadge`, `ClassBadge`, `PriorityBadge` (Urgent/Soon/Later), `FlagBadge`, `ScoreRing`.
- `filter-bar.tsx`: `QuickViews`, `SearchBox` (debounced 250 ms, `/` focuses it), `FacetButton`, `FilterBar`, `Summary` (the sentence that says what's on screen), `Segmented`.
- `data-table.tsx`: `DataTable` (TanStack Table; sticky header, aria-sort, groups, bulk bar, mobile cards), `Pagination`.
- `page.tsx`: `PageHeader`, `Breadcrumb`, `Card`, `Kpi`, `Dl`, `SideSheet`, `Skeleton`, `LoadingRows`, `LoadingPage`, `EmptyState`, `ErrorState`, `NoPermission`, `Callout`, `Avatar`, `Mark`.
- `charts.tsx`: `ChartCard`, `Donut`, `LineTrend`, `PairBars`, `HBars`, `Heatmap`, `ExpiryTimeline`, `MeterBar`, `MixBar`. Each has "View as table".
- `toaster.tsx`: `toast`, `toastError`.
- shadcn primitives: `button`, `input`, `textarea`, `select`, `checkbox`, `switch`, `dialog`, `alert-dialog`, `sheet`, `popover`, `dropdown-menu`, `tabs`, `tooltip`, `table`, `card`, `label`, `separator`, `scroll-area`, `skeleton`, `avatar`, `badge`, `command`.

Colours come only from tokens (Tailwind classes such as `bg-surface`, `text-muted-foreground`, `border-divider`,
`text-st-red`, `bg-st-amber-bg`, `text-link`). Never hard-code a hex in a component: the theme editor must be able to
change it (CMS-13).

## Patterns

- Lists: the server returns `{rows, total, page, page_size, views, facets, summary, any_filter}` (see
  `apps/api/bide_comply/api/listing.py`). Render `QuickViews` first, then `FilterBar` with `SearchBox` and facets, then
  the `Summary` sentence, then the table. Keep all list state in the URL with `useParams()` from `src/lib/params.ts`
  (multi-value filters comma-separated; the API accepts the same).
- The property switcher (`useProperty()` in `src/lib/property.tsx`) scopes every page: pass `property: propertyId`
  to list endpoints that accept it.
- Every data view has loading (skeleton), empty (says why and offers the next step), error (plain message + Try
  again) and no-permission states.
- Clicking a row opens a `SideSheet` so people keep their place; use `?sel=<id>` in the URL.
- Dialogs are for decisions that need a reason or can't be undone; name the main button after the action, never
  "OK". Confirm with a toast; offer Undo where reversible.
- Dates en-GB via `src/lib/format.ts` (`fmtDate`, `fmtDay`, `fmtTime`). Tabular numbers (`tabular` class) in tables
  and KPIs. IDs in `mono-id`.
- Words: Urgent / Soon / Later, Life safety, Actions to fix, Opening checklist, evidence, due soon, overdue,
  signed off. British English. No capitals for emphasis, no exclamation marks, no emoji.
- Accessibility: real `<button>` and `<a>`, labels on inputs, `aria-label` on icon buttons, visible focus, status
  never by colour alone.
- Permissions: `useMe().data.can[...]` hides what a person can't do; the API enforces it anyway.

## Running it

```
pnpm dev:infra     # Postgres 16 on 5434 and Redis on 6380, no Docker needed
pnpm db:reset      # development only: fresh schema + demo data
pnpm dev:api       # http://localhost:8310 (docs at /api/docs)
pnpm dev:worker
pnpm dev:web       # http://localhost:5180
pnpm dev:field     # http://localhost:5181
```

Sign in locally with the development person picker on the sign-in page (`DEV_LOGIN=true`; refused in production).
