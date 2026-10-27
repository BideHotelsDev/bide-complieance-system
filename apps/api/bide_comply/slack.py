"""Slack (SLK-01..05). Messages carry a summary and a deep link only, never document contents or personal data
beyond a name (§9.5). Without a bot token, messages are logged instead of sent.
"""

import hashlib
import hmac
import logging
import time

from bide_comply.config import settings

log = logging.getLogger("bide_comply.slack")
sent: list[dict] = []  # development and tests read what would have been sent


def _client():
    if not settings.slack_bot_token:
        return None
    from slack_sdk import WebClient

    return WebClient(token=settings.slack_bot_token)


def _record(kind: str, target: str, text: str) -> None:
    sent.append({"kind": kind, "target": target, "text": text})
    del sent[:-100]


def dm(slack_id: str | None, email: str | None, text: str, link: str | None = None) -> str | None:
    body = f"{text}\n<{link}|Open in bide Comply>" if link else text
    c = _client()
    if c is None:
        log.info("slack dm %s: %s", slack_id or email, body)
        _record("dm", slack_id or email or "?", body)
        return None
    uid = slack_id
    if not uid and email:
        uid = c.users_lookupByEmail(email=email)["user"]["id"]
    if not uid:
        return None
    ch = c.conversations_open(users=uid)["channel"]["id"]
    return c.chat_postMessage(channel=ch, text=body, unfurl_links=False)["ts"]


def post(channel: str, text: str, link: str | None = None) -> str | None:
    body = f"{text}\n<{link}|Open in bide Comply>" if link else text
    c = _client()
    if c is None:
        log.info("slack %s: %s", channel, body)
        _record("channel", channel, body)
        return None
    return c.chat_postMessage(channel=channel, text=body, unfurl_links=False)["ts"]


def verify_signature(timestamp: str, signature: str, body: bytes) -> bool:
    """Every inbound Slack request is checked against the signing secret (§9.5)."""
    if not settings.slack_signing_secret or abs(time.time() - int(timestamp)) > 300:
        return False
    base = f"v0:{timestamp}:{body.decode()}".encode()
    mine = "v0=" + hmac.new(settings.slack_signing_secret.encode(), base, hashlib.sha256).hexdigest()
    return hmac.compare_digest(mine, signature)
