# Deployment

One image (the repo-root `Dockerfile`), two services:

| Service | `SERVICE_ROLE` | What it runs |
| --- | --- | --- |
| app | `api` (default) | Migrations, the reference seed, then the API on `$PORT`. Serves the web app at `/` and the staff app at `/app`. |
| worker | `worker` | The Arq worker: scheduler every 5 minutes, delivery every minute, Monday 08:30 digest, nightly audit-chain check and retention. |

Both need Postgres 16 and Redis in a UK or EU region (PRD §8 Hosting), and an S3-compatible bucket for evidence with
versioning on (on Railway, a Railway bucket). Files go through the API by default; `S3_DIRECT_URLS=true` switches to
presigned bucket URLs, which needs CORS on the bucket and the bucket origin in the CSP. Copy `env.production.example`
into the services' variables.

Before go-live (PRD §9, §13):

- `SESSION_SECRET`, `GOOGLE_CLIENT_ID`/`SECRET` (OAuth client restricted to the bidehotels.com Workspace), S3, SMTP and
  Slack credentials, all from the secret store. `DEV_LOGIN` must be false; it is refused in production anyway.
- Google 2-Step Verification enforced at the Workspace level; admins on passkeys or security keys.
- The first Super Admin. A new database has nobody who can sign in, so set `BOOTSTRAP_ADMINS` on the app service
  (`Name <email>`, comma-separated for several, Workspace addresses). Start-up adds them only while nobody holds an
  active Super Admin role, so it never undoes a later change in Settings › People; remove the variable once they have
  signed in. To add one by hand: `railway ssh -s bide-comply -e production -- python -m bide_comply.seed --admin
  "Name <email>"`.
- The OAuth redirect URI is `https://<app host>/api/auth/google/callback`.
- Sign in with Bide (once Bide Hub is live): set `BIDE_HUB_ISSUER`, `BIDE_HUB_CLIENT_ID=comply` and
  `BIDE_HUB_CLIENT_SECRET`, which switches Google sign-in off for staff. On the Hub, the `comply` app needs redirect URI
  `https://<app host>/api/auth/bide/callback` (portal and staff app share it), post-logout addresses
  `https://<app host>/` and `https://<app host>/app/`, and back-channel logout URI
  `https://<app host>/api/auth/bide/backchannel-logout`.
- Staff access managed by the Hub (optional, after Sign in with Bide): also set `BIDE_HUB_MANAGES_ACCOUNTS=true`, then on
  the Hub fill in "Accounts managed by the Hub" for `comply` with `https://<app host>/api/auth/bide/provisioning`. The
  Hub imports today's staff and their staff roles first. From then on the Hub decides which staff have access and their
  staff roles (the group roles, Site lead, Keyholder, Staff); taking access away there offboards the person here.
  Outside people, and the Dutyholder, Competent assessor and Contractor roles, stay managed in Settings › People.
- A DPIA, the staff privacy notice (Settings › Messages and wording), DPAs with every sub-processor.
- Retention defaults signed off by David (Settings shows them; the categories are seeded in `seed/library.py`).
- An independent penetration test, and a restore test recorded as a compliance task.
