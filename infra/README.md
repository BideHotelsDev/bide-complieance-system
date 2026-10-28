# Deployment

One image (the repo-root `Dockerfile`), two services:

| Service | `SERVICE_ROLE` | What it runs |
| --- | --- | --- |
| app | `api` (default) | Migrations, the reference seed, then the API on `$PORT`. Serves the web app at `/` and the staff app at `/app`. |
| worker | `worker` | The Arq worker: scheduler every 5 minutes, delivery every minute, Monday 08:30 digest, nightly audit-chain check and retention. |

Both need Postgres 16 and Redis in a UK or EU region (PRD §8 Hosting), and an S3-compatible bucket for evidence with
versioning on. Copy `env.production.example` into the services' variables.

Before go-live (PRD §9, §13):

- `SESSION_SECRET`, `GOOGLE_CLIENT_ID`/`SECRET` (OAuth client restricted to the bidehotels.com Workspace), S3, SMTP and
  Slack credentials, all from the secret store. `DEV_LOGIN` must be false; it is refused in production anyway.
- Google 2-Step Verification enforced at the Workspace level; admins on passkeys or security keys.
- The OAuth redirect URI is `https://<app host>/api/auth/google/callback`.
- A DPIA, the staff privacy notice (Settings › Messages and wording), DPAs with every sub-processor.
- Retention defaults signed off by David (Settings shows them; the categories are seeded in `seed/library.py`).
- An independent penetration test, and a restore test recorded as a compliance task.
