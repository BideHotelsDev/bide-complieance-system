"""Transactional email. "console" logs the message (development); "smtp" sends it."""

import logging
import smtplib
from email.message import EmailMessage

from bide_comply.config import settings

log = logging.getLogger("bide_comply.email")
# Development helpers (and tests) read what would have been sent.
outbox: list[dict] = []


def send(to: str, subject: str, text: str, html: str | None = None) -> None:
    outbox.append({"to": to, "subject": subject, "text": text})
    del outbox[:-50]
    if settings.email_provider != "smtp":
        log.info("email to %s: %s\n%s", to, subject, text)
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
