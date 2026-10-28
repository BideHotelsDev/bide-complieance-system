/*
 * Contractor portal (design: ContractorPortal) is phase 2. This page shows its layout so the route exists; nothing on
 * it is live yet and the buttons are disabled.
 */
import { Mark } from "@bide-comply/ui/components/page"

import { Page } from "@/components/kit"

const VISITS = [
  { title: "Fire alarm service", when: "Tomorrow", where: "The Villa · visit booked", action: "Upload the report after your visit" },
  { title: "Fix: detector in room 7", when: "Due in 5 days", where: "The View · Urgent priority", action: "Mark as fixed, add photo" },
  { title: "Emergency lighting test", when: "Booked", where: "The View", action: null },
]

export function ContractorPortalPage() {
  return (
    <Page>
      <header className="flex items-center gap-2.5 border-b border-divider bg-surface px-[18px] py-4">
        <Mark size={30} />
        <span className="text-[16px] font-semibold">bide Hotels</span>
        <span className="ml-auto text-[14px] text-muted-foreground">Contractor</span>
      </header>
      <main className="flex flex-1 flex-col gap-3 px-4 pt-4 pb-8">
        <p role="note" className="m-0 rounded-xl bg-st-blue-bg px-4 py-3 text-[15px] text-st-blue">
          Coming in phase 2. Until then, staff log contractor visits in the app.
        </p>
        <h1 className="m-0 mt-1 text-[22px] font-semibold">Hello</h1>
        <p className="m-0 text-[15px] text-muted-foreground">
          This page opens from the link bide emails you. It works for 7 days. No password needed.
        </p>
        <h2 className="m-0 mt-2 text-[14px] font-semibold text-muted-foreground">Your visits</h2>
        {VISITS.map((v) => (
          <div key={v.title} aria-disabled className="rounded-xl border border-divider bg-surface px-4 py-3.5 opacity-70">
            <div className="flex items-start justify-between gap-2">
              <div className="text-[16px] font-semibold">{v.title}</div>
              <span className="text-[13.5px] text-muted-foreground">{v.when}</span>
            </div>
            <div className="text-[14px] text-muted-foreground">{v.where}</div>
            {v.action && (
              <button type="button" disabled className="mt-3 h-12 w-full rounded-xl border border-border text-[15.5px] font-semibold">
                {v.action}
              </button>
            )}
          </div>
        ))}
        <p className="m-0 mt-2 text-[13.5px] text-muted-foreground">
          You can only see visits bide has given you. Your uploads are checked by the site manager before they count.
        </p>
      </main>
    </Page>
  )
}
