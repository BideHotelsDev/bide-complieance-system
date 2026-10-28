/*
 * Sign-in (PRD §9.2, design: Dialogs › First sign-in on a new computer, You've been signed out). Staff use Google;
 * outside people (assessor, SPV directors, contractors) get an emailed link. A new device needs the emailed code,
 * and admin roles also confirm with an authenticator app. In local development a person picker stands in for Google.
 */
import { useNavigate, useSearch } from "@tanstack/react-router"
import { useMutation, useQuery } from "@tanstack/react-query"
import * as React from "react"

import { api, ApiError } from "@bide-comply/api-client"
import { Button } from "@bide-comply/ui/components/button"
import { Mark } from "@bide-comply/ui/components/page"

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-[400px] rounded-xl border border-divider bg-surface p-6 shadow-sm">
        <div className="mb-5 flex items-center gap-2">
          <Mark size={26} />
          <span className="text-[15px] font-semibold">bide Comply</span>
        </div>
        {children}
      </div>
    </div>
  )
}

export function SignInPage() {
  const search = useSearch({ strict: false }) as { next?: string; error?: string; reason?: string }
  const navigate = useNavigate()
  const [email, setEmail] = React.useState("")
  const [sent, setSent] = React.useState(false)
  const dev = useQuery({
    queryKey: ["dev-people"],
    queryFn: () => api.get<{ id: string; name: string; title: string | null; kind: string }[]>("/api/auth/dev/people"),
    retry: false,
  })
  const devSignIn = useMutation({
    mutationFn: (id: string) => api.post<{ next: string }>("/api/auth/dev", { person_id: id, app: "web" }),
    onSuccess: (r) => {
      window.location.href = search.next && search.next !== "/signin" ? search.next : r.next
    },
  })
  const magic = useMutation({
    mutationFn: () => api.post("/api/auth/magic", { email, app: "web" }),
    onSuccess: () => setSent(true),
  })
  return (
    <Frame>
      {search.reason === "idle" ? (
        <>
          <h1 className="m-0 text-[18px] font-semibold">You've been signed out</h1>
          <p className="mt-1 text-[13.5px] text-muted-foreground">
            For safety, after 30 minutes without activity. Anything you were typing has been kept on this computer. Sign
            in again to carry on where you left off.
          </p>
        </>
      ) : (
        <>
          <h1 className="m-0 text-[18px] font-semibold">Sign in</h1>
          <p className="mt-1 text-[13.5px] text-muted-foreground">Use your bide Google account.</p>
        </>
      )}
      {search.error && (
        <p role="alert" className="mt-3 rounded-md bg-st-red-bg px-3 py-2 text-[13px] text-st-red">
          {search.error === "link"
            ? "That sign-in link has expired. Ask for a new one below."
            : "Sign-in didn't work. Try again."}
        </p>
      )}
      <Button asChild size="lg" className="mt-4 w-full">
        <a href={`/api/auth/google/start?app=web&next=${encodeURIComponent(search.next ?? "/")}`}>
          Sign in with Google
        </a>
      </Button>
      <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-divider" />
        No bide account?
        <span className="h-px flex-1 bg-divider" />
      </div>
      {sent ? (
        <p className="text-[13.5px]">
          If <strong>{email}</strong> is set up in bide Comply, a sign-in link is on its way. It works for 7 days.
        </p>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (email.includes("@")) magic.mutate()
          }}
        >
          <label className="flex flex-col gap-1 text-xs font-medium text-ink2">
            Email address (assessors, SPV directors and contractors)
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-9 rounded-md border border-border bg-surface px-2.5 text-[14px] font-normal text-foreground"
              autoComplete="email"
            />
          </label>
          <Button type="submit" variant="secondary" disabled={magic.isPending}>
            Email me a sign-in link
          </Button>
        </form>
      )}
      {dev.data && (
        <div className="mt-6 border-t border-divider pt-4">
          <div className="mb-2 text-xs font-medium text-muted-foreground">
            Development sign-in (not available in production)
          </div>
          <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
            {dev.data.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => devSignIn.mutate(p.id)}
                className="flex items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-hover"
              >
                <span>{p.name}</span>
                <span className="text-xs text-muted-foreground">{p.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <button type="button" className="sr-only" onClick={() => navigate({ to: "/" })}>
        Home
      </button>
    </Frame>
  )
}

function CodeBoxes({ value, onChange, length = 6 }: { value: string; onChange: (v: string) => void; length?: number }) {
  return (
    <input
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={length}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, length))}
      aria-label={`${length}-digit code`}
      className="tabular h-14 w-full rounded-lg border border-border bg-surface text-center text-[26px] font-semibold tracking-[0.5em]"
      autoFocus
    />
  )
}

export function CodePage({ stage }: { stage: "code" | "totp" | "totp-setup" }) {
  const pending = useQuery({
    queryKey: ["pending"],
    queryFn: () => api.get<{ stage: string; name: string; email_masked: string }>("/api/auth/pending"),
    retry: false,
  })
  const [code, setCode] = React.useState("")
  const [trust, setTrust] = React.useState(true)
  const setup = useQuery({
    queryKey: ["totp-setup"],
    queryFn: () => api.post<{ secret: string; uri: string }>("/api/auth/totp/setup"),
    enabled: stage === "totp-setup",
    retry: false,
  })
  const verify = useMutation({
    mutationFn: () =>
      api.post<{ next: string }>(stage === "code" ? "/api/auth/code" : "/api/auth/totp", { code, trust }),
    onSuccess: (r) => {
      window.location.href = r.next.startsWith("/signin") ? r.next : r.next || "/"
    },
  })
  const resend = useMutation({ mutationFn: () => api.post("/api/auth/code/resend") })
  const err = verify.error instanceof ApiError ? verify.error.message : null
  return (
    <Frame>
      {stage === "code" ? (
        <>
          <h1 className="m-0 text-[18px] font-semibold">Enter the code we emailed you</h1>
          <p className="mt-1 text-[13.5px] text-muted-foreground">
            First sign-in on this computer. Sent to {pending.data?.email_masked ?? "your email"}.
          </p>
        </>
      ) : stage === "totp-setup" ? (
        <>
          <h1 className="m-0 text-[18px] font-semibold">Set up your authenticator app</h1>
          <p className="mt-1 text-[13.5px] text-muted-foreground">
            Admin accounts confirm sign-in with an authenticator app. Add this key to it, then enter the 6-digit code it
            shows.
          </p>
          {setup.data && (
            <p className="mt-3 rounded-md bg-hover px-3 py-2 font-mono text-[13px] break-all">{setup.data.secret}</p>
          )}
        </>
      ) : (
        <>
          <h1 className="m-0 text-[18px] font-semibold">Confirm it's you</h1>
          <p className="mt-1 text-[13.5px] text-muted-foreground">
            Enter the 6-digit code from your authenticator app.
          </p>
        </>
      )}
      <form
        className="mt-4 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (code.length === 6) verify.mutate()
        }}
      >
        <CodeBoxes value={code} onChange={setCode} />
        {err && (
          <p role="alert" className="m-0 text-[13px] text-st-red">
            {err}
          </p>
        )}
        {stage === "code" && (
          <label className="flex items-center gap-2 text-[13.5px]">
            <input
              type="checkbox"
              checked={trust}
              onChange={(e) => setTrust(e.target.checked)}
              className="size-4 accent-[var(--c-primary)]"
            />
            Trust this computer for 90 days
          </label>
        )}
        <div className="flex items-center justify-between gap-2">
          {stage === "code" ? (
            <span className="text-[13px] text-muted-foreground">
              Didn't get it?{" "}
              <button type="button" className="text-link hover:underline" onClick={() => resend.mutate()}>
                Send a new code
              </button>
            </span>
          ) : (
            <span />
          )}
          <Button type="submit" disabled={code.length !== 6 || verify.isPending}>
            Verify
          </Button>
        </div>
        <a href="/signin" className="text-[13px]">
          Use a different account
        </a>
      </form>
    </Frame>
  )
}
