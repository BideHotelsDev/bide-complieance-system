# bide Comply

The app version of David's group compliance system: the BH-CMP-001 register and operating plan, and the BH-CMP-002
pre-launch checklist. It lists every obligation at every property, dates it, proves it with a photo or certificate,
and shows in ten seconds where the group is behind. Each obligation has a named owner and escalates automatically
when it slips.

- PRD: https://claude.ai/artifact/CcUwE2XHWQKh66d4DBsHwb
- Product design (40 screens): https://claude.ai/artifact/M9RJ6fpTwHH73EBwcgpFWA

## What's here

| Path | What |
| --- | --- |
| `apps/api` | FastAPI, SQLAlchemy Core, Postgres 16, Alembic. The compliance engine (`bide_comply/engine`), services, routers, the Arq worker (`bide_comply/worker.py`) and the seed. |
| `apps/web` | Management portal and admin CMS (React, TanStack Router and Query, Tailwind, shadcn/ui). |
| `apps/field` | Staff app: an installable PWA with in-app camera capture and an offline queue. |
| `packages/ui` | Design tokens and shared components (Linear-style monochrome; colour only for status). |
| `packages/api-client` | The fetch client both apps use (cookie sessions, refresh, CSRF header, uploads). |
| `packages/config` | Shared TypeScript settings. |
| `infra` | Deployment notes and the production environment template. |

The rules from the PRD that the code enforces, and where:

| Rule | Where |
| --- | --- |
| RAG status, weighted score, red-line rule (§4.2) | `engine/status.py`, `services/register.py` |
| Scheduling, windows, late rule, BST (SCH-01..10) | `engine/schedule.py`, `engine/frequency.py` |
| No evidence, not done; in-app camera; geofence; clock skew; offline flags (EXE-*) | `services/checks.py`, `engine/forms.py` |
| One name per item (SCH-05) | `services/common.py` `check_named`, `api/register.py`, `api/setup.py` |
| Actions close only with evidence or a recorded decision (ACT-02) | `engine/actions.py`, `services/actions.py` |
| Opening gate status and H08 lock (GATE-02..04) | `engine/gate.py`, `api/gates.py` |
| Escalation ladder (§7), quiet hours, Class A never muted | `services/notify.py`, `services/escalations.py`, `worker.py` |
| Permission matrix and separation of duties (§2, §9.3) | `authz.py`, tested in `tests/test_authz.py` |
| Sign-in, device trust, rotating refresh tokens (§9.2) | `auth.py` |
| Append-only hash-chained audit log (AUD-01) | `audit.py` and the migration's trigger |
| Evidence integrity (§9.4) | `storage.py`, `services/evidence.py` |

## Run it locally

No Docker or root needed. Postgres 16 comes from the `pgserver` wheel and Redis from the distro packages, both kept
under `.devdata/`.

```sh
cp .env.example .env          # then set SESSION_SECRET
pnpm install
uv sync --directory apps/api
pnpm dev:infra                # Postgres on 5434, Redis on 6380 (leave running)
pnpm db:reset                 # fresh schema and the demo data
pnpm dev:api                  # http://localhost:8310, API docs at /api/docs
pnpm dev:worker               # scheduler, escalations, digests
pnpm dev:web                  # http://localhost:5180
pnpm dev:field                # http://localhost:5181 (staff app)
```

With `DEV_LOGIN=true` the sign-in page lists the demo people, so you can sign in as David (Super Admin), Samantha
(system owner), Pamela (staff at The View), the TDA director (dutyholder for The Villa) or Sandy Riach (assessor)
without Google. It is refused when `ENVIRONMENT=production`.

## Tests and checks

```sh
pnpm test:api      # pytest against a throwaway Postgres database (engine, permission matrix, flows, worker)
pnpm lint
pnpm typecheck
pnpm build
```

## Demo data

The demo seed carries the real rows from BH-CMP-001 and BH-CMP-002 as they appear in the product design (24 Oct 2026):
the six properties and their SPVs, the Actions & Advisories (TV-, TM-, AR-, TH-), the gate notes for The Villa's
section C, the certificates on file and missing, and the approvals waiting. People David's documents leave to confirm
keep the design's placeholders ("[Site lead, The View]"). Every demo address ends `@demo.invalid`.

The BH-CMP-002 workbook isn't in this repo, so 20 of the 56 gate lines carry only their reference and Class until the
workbook is loaded through Settings › Import data. The 36 lines whose wording appears in the PRD or the design are
filled in.
