import { appPath } from "@/lib/base"
/*
 * Sign-in on the phone (PRD §9.2, design: AppSignin). Staff sign in with Google; the first time on a phone they also
 * enter the 6-digit code we email, after which the phone is trusted for 90 days. In local development a person picker
 * stands in for Google.
 */
import { useMutation, useQuery } from "@tanstack/react-query"
import { api, ApiError } from "@bide-comply/api-client"
import { Mark } from "@bide-comply/ui/components/page"
import { cn } from "@bide-comply/ui/lib/utils"
import { ShieldCheck } from "lucide-react"
import * as React from "react"

import { Page, PrimaryButton } from "@/components/kit"

export function SignInPage() {
  const reason = new URLSearchParams(location.search).get("error")
  const dev = useQuery({
    queryKey: ["dev-people"],
    queryFn: () => api.get<{ id: string; name: string; title: string | null; kind: string }[]>("/api/auth/dev/people"),
    retry: false,
  })
  const devSignIn = useMutation({
    mutationFn: (id: string) => api.post<{ next: string }>("/api/auth/dev", { person_id: id, app: "field" }),
    onSuccess: (r) => {
      window.location.href = appPath(r.next || "/")
    },
  })
  return (
    <Page className="px-6 pt-12">
      <Mark size={44} />
      <h1 className="m-0 mt-6 text-[26px] font-semibold">Sign in</h1>
      <p className="m-0 mt-1.5 text-[16px] text-muted-foreground">Use your bide Google account to see today's checks.</p>
      {reason && (
        <p role="alert" className="mt-4 rounded-xl bg-st-red-bg px-3.5 py-2.5 text-[15px] text-st-red">
          Sign-in didn't work. Try again.
        </p>
      )}
      <a
        href="/api/auth/google/start?app=field&next=%2F"
        className="mt-6 flex h-[52px] items-center justify-center gap-2 rounded-xl bg-primary text-[17px] font-semibold text-primary-foreground no-underline"
      >
        Sign in with Google
      </a>
      <p className="mt-4 text-[14px] text-muted-foreground">
        Contractors: use the link bide emailed you. It works for 7 days, no password needed.
      </p>
      {dev.data && (
        <section className="mt-6 border-t border-divider pt-4 pb-8">
          <h2 className="m-0 mb-2 text-[13.5px] font-medium text-muted-foreground">
            Development sign-in (not available in production)
          </h2>
          {devSignIn.error && (
            <p role="alert" className="text-[14px] text-st-red">
              {devSignIn.error.message}
            </p>
          )}
          <div className="flex flex-col">
            {dev.data.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => devSignIn.mutate(p.id)}
                className="flex min-h-12 items-center justify-between gap-3 rounded-lg px-2 text-left text-[15px] hover:bg-hover"
              >
                <span>{p.name}</span>
                <span className="truncate text-[13px] text-muted-foreground">{p.title}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </Page>
  )
}

/* Six boxes over one real input, so paste and the phone's one-time-code autofill both work. */
function CodeBoxes({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [focused, setFocused] = React.useState(true)
  return (
    <div className="relative mt-6">
      <input
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        aria-label="6-digit code"
        className="absolute inset-0 z-10 w-full cursor-text opacity-0"
        autoFocus
      />
      <div aria-hidden className="flex gap-2">
        {Array.from({ length: 6 }, (_, i) => (
          <div
            key={i}
            className={cn(
              "tabular flex h-14 w-12 items-center justify-center rounded-xl border border-border bg-surface text-[24px] font-semibold",
              focused && i === Math.min(value.length, 5) && "border-focus outline-2 outline-focus/30",
            )}
          >
            {value[i] ?? ""}
          </div>
        ))}
      </div>
    </div>
  )
}

export function CodePage({ stage }: { stage: "code" | "totp" | "totp-setup" }) {
  const pending = useQuery({
    queryKey: ["pending"],
    queryFn: () => api.get<{ stage: string; name: string; email_masked: string }>("/api/auth/pending"),
    retry: false,
  })
  const setup = useQuery({
    queryKey: ["totp-setup"],
    queryFn: () => api.post<{ secret: string; uri: string }>("/api/auth/totp/setup"),
    enabled: stage === "totp-setup",
    retry: false,
  })
  const [code, setCode] = React.useState("")
  const verify = useMutation({
    mutationFn: () => api.post<{ next: string }>(stage === "code" ? "/api/auth/code" : "/api/auth/totp", { code, trust: true }),
    onSuccess: (r) => {
      window.location.href = appPath(r.next || "/")
    },
  })
  const resend = useMutation({ mutationFn: () => api.post("/api/auth/code/resend") })
  const err = verify.error instanceof ApiError ? verify.error.message : null
  const notYou = async () => {
    await api.post("/api/auth/logout").catch(() => undefined)
    window.location.href = appPath("/signin")
  }
  return (
    <Page className="px-6 pt-12">
      <form
        className="flex flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault()
          if (code.length === 6) verify.mutate()
        }}
      >
        <Mark size={44} />
        {stage === "code" ? (
          <>
            <h1 className="m-0 mt-6 text-[24px] font-semibold">Check your email</h1>
            <p className="m-0 mt-1.5 text-[16px] text-muted-foreground">
              This is the first time you've signed in on this phone. We've sent a 6-digit code to{" "}
              <strong className="text-foreground">{pending.data?.email_masked ?? "your email"}</strong>
            </p>
          </>
        ) : stage === "totp-setup" ? (
          <>
            <h1 className="m-0 mt-6 text-[24px] font-semibold">Set up your authenticator app</h1>
            <p className="m-0 mt-1.5 text-[16px] text-muted-foreground">
              Admin accounts confirm sign-in with an authenticator app. Add this key to it, then enter the 6-digit code.
            </p>
            {setup.data && <p className="mt-3 rounded-lg bg-hover px-3 py-2 font-mono text-[14px] break-all">{setup.data.secret}</p>}
          </>
        ) : (
          <>
            <h1 className="m-0 mt-6 text-[24px] font-semibold">Confirm it's you</h1>
            <p className="m-0 mt-1.5 text-[16px] text-muted-foreground">Enter the 6-digit code from your authenticator app.</p>
          </>
        )}
        <CodeBoxes value={code} onChange={setCode} />
        {err && (
          <p role="alert" className="m-0 mt-3 text-[15px] text-st-red">
            {err}
          </p>
        )}
        {stage === "code" && (
          <>
            <p className="m-0 mt-4 text-[14.5px] text-muted-foreground">
              The code works for 10 minutes.{" "}
              <button
                type="button"
                className="min-h-10 font-semibold text-link"
                disabled={resend.isPending}
                onClick={() => resend.mutate()}
              >
                {resend.isSuccess ? "New code sent" : "Send a new code"}
              </button>
            </p>
            <div className="mt-4 flex gap-3 rounded-xl border border-divider bg-surface px-4 py-3.5 text-[15px]">
              <ShieldCheck aria-hidden className="mt-0.5 size-5 shrink-0" />
              <span>After this, the phone is trusted for 90 days. If it is lost, ask Samantha to sign it out.</span>
            </div>
          </>
        )}
        <div className="pb-safe mt-auto pt-8 pb-6">
          <PrimaryButton type="submit" disabled={code.length !== 6 || verify.isPending}>
            Continue
          </PrimaryButton>
          {pending.data && (
            <p className="m-0 mt-3 text-center text-[13.5px] text-muted-foreground">
              Signed in with Google as {pending.data.name} ·{" "}
              <button type="button" className="min-h-10 font-medium text-link" onClick={() => void notYou()}>
                Not you?
              </button>
            </p>
          )}
        </div>
      </form>
    </Page>
  )
}
