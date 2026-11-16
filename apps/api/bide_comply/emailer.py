"""Transactional email. "console" logs who it's for and the subject, never the body (development); "smtp" sends it."""

import logging
import smtplib
from email.message import EmailMessage

from bide_comply.config import settings

log = logging.getLogger("bide_comply.email")
# Development helpers (and tests) read what would have been sent.
outbox: list[dict] = []


def mask(address: str) -> str:
    """kyle@bidehotels.com -> ky…@bidehotels.com: enough to tell messages apart in a log, not to harvest."""
    local, at, domain = address.partition("@")
    return f"{local[:2]}…{at}{domain}" if at else f"{address[:2]}…"


def send(to: str, subject: str, text: str, html: str | None = None) -> None:
    outbox.append({"to": to, "subject": subject, "text": text})
    del outbox[:-50]
    if settings.email_provider != "smtp":
        # The body holds sign-in codes and links, so it's never logged. Tests and dev helpers read `outbox` instead.
        log.info("email (not sent, EMAIL_PROVIDER=%s) to %s: %s", settings.email_provider, mask(to), subject)
        return
    msg = EmailMessage()
    msg["From"] = settings.email_from
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")
    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=20) as s:
        s.starttls()
        if settings.smtp_username:
            s.login(settings.smtp_username, settings.smtp_password)
        s.send_message(msg)
