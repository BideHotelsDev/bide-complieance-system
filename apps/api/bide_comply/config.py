from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Scripts run with apps/api as the working directory, so the repo-root .env is two levels up.
    # On the host there is no .env; values come from service variables.
    model_config = SettingsConfigDict(env_file=("../../.env", ".env"), extra="ignore")

    environment: str = "development"  # development | staging | production
    database_url: str = "postgresql+psycopg://postgres@localhost:5432/bide_comply"
    redis_url: str = "redis://localhost:6379/0"
    # Proxies in front of the API that each append the address they saw to X-Forwarded-For (Railway's edge: 1). The
    # client IP for rate limits and the audit log is that many entries from the right; 0 uses the socket address.
    trusted_proxy_hops: int = 1

    # Public URLs the browser uses. Magic links, Slack deep links and OIDC redirects point here.
    web_base_url: str = "http://localhost:5180"
    field_base_url: str = "http://localhost:5181"
    api_base_url: str = "http://localhost:8310"
    # Built SPAs served by the API in production (one image). Empty in development: Vite serves them.
    web_dist_dir: Path | None = None
    field_dist_dir: Path | None = None

    # Signs session cookies, OTP and magic-link tokens. Must be set outside development.
    session_secret: str = ""
    access_minutes: int = 15
    refresh_days: int = 30
    admin_idle_minutes: int = 30
    external_session_hours: int = 8
    device_trust_days: int = 90
    otp_minutes: int = 10
    otp_attempts: int = 5

    # Google Workspace SSO (OIDC + PKCE). Only these hd claims may sign in.
    google_client_id: str = ""
    google_client_secret: str = ""
    google_workspace_domains: str = "bidehotels.com"
    # Bide Hub, the group's single sign-on (OIDC). When all three are set, "Sign in with Bide" replaces the Google
    # step for staff; the device code, authenticator app and session rules after it are unchanged.
    bide_hub_issuer: str = ""
    bide_hub_client_id: str = ""
    bide_hub_client_secret: str = ""
    # With Sign in with Bide on, also let the Hub manage which staff have access and their staff roles. Off until an
    # operator turns it on; then the Hub imports the staff first. Outside people stay managed here.
    bide_hub_manages_accounts: bool = False
    # Local development and demos only: sign in as any seeded person without Google. Refused in production.
    dev_login: bool = False
    # First Super Admins for a new install, as "Name <email>, email". Used at start-up only while nobody is a
    # Super Admin; see seed/admins.py.
    bootstrap_admins: str = ""
    # Break-glass sign-in with a password for one Super Admin, for before Google sign-in and email are set up.
    # Off unless all three are set; remove the hash to switch it off. The authenticator app is still required.
    # Make a password and hash with `python -m bide_comply.passwords`.
    admin_login_username: str = ""
    admin_login_email: str = ""
    admin_login_password_hash: str = ""

    # Business logic runs in UK time whatever the viewer's timezone (SCH-04).
    business_timezone: str = "Europe/London"
    # How far ahead the scheduler materialises tasks (PRD §3, rolling 90-day horizon).
    schedule_horizon_days: int = 90
    # A gap this large between device and server time is flagged for review (EXE-04).
    clock_skew_flag_seconds: int = 300
    geofence_default_radius_m: int = 150

    # Evidence storage. "local" writes under storage_dir (development); "s3" uses an S3-compatible bucket.
    storage_backend: str = "local"
    storage_dir: Path = Path("../../.devdata/storage")
    s3_bucket: str = ""
    s3_region: str = "eu-west-2"
    s3_endpoint_url: str = ""
    s3_access_key_id: str = ""
    s3_secret_access_key: str = ""
    # Presigned bucket URLs in the browser instead of going through the API (needs bucket CORS and a CSP change).
    s3_direct_urls: bool = False
    signed_url_seconds: int = 300
    max_image_bytes: int = 15 * 1024 * 1024
    max_pdf_bytes: int = 25 * 1024 * 1024

    # Email: "console" logs messages; "smtp" sends through a mail server.
    email_provider: str = "console"
    email_from: str = "bide Comply <comply@bidehotels.com>"
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""

    # Slack app. Without a bot token messages are logged, not sent.
    slack_bot_token: str = ""
    slack_signing_secret: str = ""
    slack_compliance_channel: str = "#bide-compliance"
    slack_escalations_channel: str = ""

    # Web Push (VAPID). Without keys pushes go to the in-app inbox only.
    vapid_public_key: str = ""
    vapid_private_key: str = ""
    vapid_subject: str = "mailto:comply@bidehotels.com"

    @property
    def workspace_domains(self) -> list[str]:
        return [d.strip().lower() for d in self.google_workspace_domains.split(",") if d.strip()]

    @property
    def bide_hub_on(self) -> bool:
        return bool(self.bide_hub_issuer and self.bide_hub_client_id and self.bide_hub_client_secret)

    @property
    def accounts_managed_by_hub(self) -> bool:
        """The Hub also decides which staff have access and with which staff roles (hub_accounts.py)."""
        return self.bide_hub_on and self.bide_hub_manages_accounts

    @property
    def is_production(self) -> bool:
        return self.environment == "production"


settings = Settings()
