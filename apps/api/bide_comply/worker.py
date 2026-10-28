"""Arq worker: the scheduler, escalations, delivery, digests, retention and audit checks (PRD §11 Jobs).

pnpm dev:worker        # arq bide_comply.worker.WorkerSettings
"""

import logging
import uuid
from datetime import timedelta

from arq import cron
from sqlalchemy import select, update

from bide_comply import audit, clock, emailer, slack
from bide_comply.config import settings
from bide_comply.db import engine
from bide_comply.jobs.queue import redis_settings
from bide_comply.schema import (
    dutyholder_director,
    escalation,
    leave,
    notification,
    person,
    push_subscription,
    report_export,
    retention_policy,
    scheduled_report,
    submission,
    task,
)
from bide_comply.services import escalations, packs, views, wording
from bide_comply.services.checks import due_reminders, spot_check_sample
from bide_comply.services.register import refresh_property

log = logging.getLogger("bide_comply.worker")


async def tick(ctx) -> None:
    """Every 5 minutes: generate tasks in the horizon, move them with the clock, recompute RAG, run the ladder."""
    try:
        with engine.begin() as conn:
            refresh_property(conn)
            n = escalations.run(conn)
            reminded = due_reminders(conn)
        if n:
            log.info("escalations fired: %s", n)
        if reminded:
            log.info("due reminders sent: %s", reminded)
    except Exception:
        # Task generation failing is the one thing that silently breaks compliance: alert the dev team (§8).
        log.exception("scheduler tick failed")
        raise


async def deliver(ctx) -> None:
    """Every minute: send pending notifications to Slack, email and push. In-app is the row itself."""
    now = clock.now()
    with engine.begin() as conn:
        posted: set = set()
        channel_lines: list[str] = []
        rows = (
            conn.execute(
                select(notification, person.c.email, person.c.slack_id, person.c.preferences)
                .join(person, person.c.id == notification.c.person_id)
                .where(
                    notification.c.delivered == {},
                    (notification.c.hold_until.is_(None)) | (notification.c.hold_until <= now),
                    notification.c.created_at >= now - timedelta(days=2),
                )
                .limit(200)
            )
            .mappings()
            .all()
        )
        away = on_leave_today(conn)
        for n in rows:
            muted = muted_channels(n["preferences"], n["person_id"] in away)
            done: dict = {"app": True}
            # Staff-app pages (a check to send again, the contractor portal) open in the staff app; everything else in the portal.
            staff_app = (n["link"] or "").startswith(("/task/", "/contractor"))
            app_base = settings.field_base_url if staff_app else settings.web_base_url
            link = f"{app_base}{n['link']}" if n["link"] else None
            klass = n["class"]
            # Each person can mute Class B and C channels but never Class A (§7).
            can_mute = klass != "A"
            try:
                if "slack_dm" in n["channels"] and not (can_mute and "slack" in muted):
                    # Escalations carry the full wording from Messages and wording as the body; the title is its short form.
                    text = n["body"] if n["escalation_id"] and n["body"] else n["title"]
                    done["slack"] = slack.dm(n["slack_id"], n["email"], text, link) or "logged"
                if "slack_channel" in n["channels"] and n["escalation_id"] and n["escalation_id"] not in posted:
                    # Collected into one channel post per run. Each line names the check and the property, never a
                    # person (SLK-01).
                    summary = conn.execute(
                        select(escalation.c.summary).where(escalation.c.id == n["escalation_id"])
                    ).scalar()
                    channel_lines.append(summary or n["title"])
                    posted.add(n["escalation_id"])
                    done["channel"] = True
                if "push" in n["channels"] and not (can_mute and "push" in muted):
                    done["push"] = send_push(conn, n["person_id"], n["title"], n["link"], n["body"], str(n["id"]))
                if "email" in n["channels"] and n["email"] and not (can_mute and "email" in muted):
                    emailer.send(n["email"], n["title"], f"{n['title']}\n\n{n['body'] or ''}\n\n{link or ''}".strip())
                    done["email"] = True
            except Exception as e:  # noqa: BLE001 - one bad address mustn't stop the others
                done["error"] = str(e)[:200]
                log.warning("delivery failed for %s: %s", n["id"], e)
            conn.execute(update(notification).where(notification.c.id == n["id"]).values(delivered=done))
        if channel_lines:
            # Counts and a short summary, not a message per item: a busy morning stays one post (SLK-01).
            shown = channel_lines[:8]
            more = len(channel_lines) - len(shown)
            text = (
                f"{len(channel_lines)} new {'item needs' if len(channel_lines) == 1 else 'items need'} attention:\n"
                + "\n".join(f"• {line}" for line in shown)
            )
            if more:
                text += f"\n…and {more} more."
            slack.post(settings.slack_compliance_channel, text, f"{settings.web_base_url}/todo")


def on_leave_today(conn) -> set:
    t0 = clock.today()
    return set(
        conn.execute(
            select(leave.c.person_id).where(leave.c.starts_on <= t0, leave.c.ends_on >= t0, leave.c.ended_at.is_(None))
        ).scalars()
    )


def muted_channels(prefs: dict | None, on_leave: bool) -> set[str]:
    """The channels a person has turned off (Class A ignores this, §7). Me › Phone notifications off stops pushes; Me ›
    Quiet on days off holds pushes and Slack while they're on leave. The in-app inbox always gets the row."""
    prefs = prefs or {}
    muted = set(prefs.get("muted", []))
    if prefs.get("push") is False:
        muted.add("push")
    if on_leave and prefs.get("quiet_days_off"):
        muted |= {"push", "slack"}
    return muted


def send_push(conn, person_id, title: str, link: str | None, body: str | None = None, tag: str | None = None) -> int:
    """Web Push to every subscribed device (iOS 16.4+ needs the app installed). Gone subscriptions are removed."""
    if not (settings.vapid_private_key and settings.vapid_public_key):
        return 0
    import json

    from pywebpush import WebPushException, webpush

    sent = 0
    for sub in conn.execute(select(push_subscription).where(push_subscription.c.person_id == person_id)).mappings():
        try:
            webpush(
                subscription_info={"endpoint": sub["endpoint"], "keys": sub["keys"]},
                # The staff app's service worker shows it and opens `link` on tap (apps/field/public/push-sw.js).
                data=json.dumps({"title": title, "body": body, "link": link, "tag": tag}),
                vapid_private_key=settings.vapid_private_key,
                vapid_claims={"sub": settings.vapid_subject},
                ttl=3600,
            )
            sent += 1
        except WebPushException as e:
            if e.response is not None and e.response.status_code in (404, 410):
                conn.execute(push_subscription.delete().where(push_subscription.c.id == sub["id"]))
    return sent


async def monday_digest(ctx) -> None:
    """Monday 08:30 to #bide-compliance and by email to David and the dutyholders, with the three L10 numbers (DSH-08)."""
    with engine.begin() as conn:
        row = (
            conn.execute(select(scheduled_report).where(scheduled_report.c.kind == "monday_digest")).mappings().first()
        )
        if row and not row["enabled"]:
            return
        from bide_comply.authz import Principal

        everyone = Principal(
            person_id=uuid.UUID(int=0),
            name="Digest",
            email=None,
            kind="system",
            roles={"super_admin": {None}},
            scope=None,
        )
        l10 = views.l10(conn, everyone, None)
        props = views.visible_properties(conn, everyone)
        lines = []
        for p in props:
            s = views.property_summary(conn, p)
            if not s["register_loaded"]:
                continue
            lines.append(
                f"• {p['name']}: score {s['score']}%{' (red: life safety open)' if s['red_line'] else ''}, "
                f"{s['class_a_late']} life-safety late, {s['actions']['urgent']} urgent actions"
            )
        on_time = f"{l10['on_time_last_7']}%" if l10["on_time_last_7"] is not None else "not enough checks yet"
        # The opening line is the "Monday digest" wording from Settings › Messages and wording (CMS-17).
        text = (
            wording.text(
                conn,
                "monday_digest",
                f"Good morning. This week: {l10['class_a_overdue']} life-safety items overdue (goal 0), {on_time} of "
                f"checks done on time last week (goal 95%), {l10['high_over_7']} urgent actions open more than 7 days "
                "(goal 0).",
                {"class_a_overdue": l10["class_a_overdue"], "on_time": on_time, "high_over_7": l10["high_over_7"]},
            )
            + "\n"
            + "\n".join(lines)
        )
        slack.post(settings.slack_compliance_channel, text, f"{settings.web_base_url}/")
        for email in conn.execute(
            select(person.c.email).where(
                person.c.email.isnot(None),
                person.c.employment_status == "active",
                person.c.id.in_(select(dutyholder_director.c.person_id)),
            )
        ).scalars():
            emailer.send(email, "bide Comply · Monday digest", text)
        conn.execute(
            update(scheduled_report).where(scheduled_report.c.kind == "monday_digest").values(last_run_at=clock.now())
        )


async def nightly(ctx) -> None:
    """03:00: check the audit chain, then the retention jobs (AUD-02, AUD-03)."""
    with engine.begin() as conn:
        ok, n, broken = audit.verify_chain(conn)
        audit.record(
            conn,
            audit.NIGHTLY,
            category="settings",
            action="audit.chain_check",
            summary=f"Checked the audit chain: {'intact' if ok else f'broken at event {broken}'}",
            after={"events": n},
        )
        if not ok:
            log.error("AUDIT CHAIN BROKEN at %s", broken)
        today = clock.today()
        removed = 0
        for pol in conn.execute(select(retention_policy).where(retention_policy.c.action == "delete")).mappings():
            if pol["category"] == "location_data":
                cutoff = clock.start_of_day(today - timedelta(days=365 * pol["years"]))
                res = conn.execute(
                    update(submission)
                    .where(submission.c.server_time < cutoff, submission.c.lat.isnot(None))
                    .values(lat=None, lng=None, accuracy_m=None)
                )
                removed += res.rowcount or 0
        if removed:
            audit.record(
                conn,
                audit.NIGHTLY,
                category="settings",
                action="retention.run",
                summary=f"Retention: removed location coordinates from {removed} submissions (geofence result kept)",
            )


async def weekly_spot_check(ctx) -> None:
    """Monday: pick 1 in 10 of last week's passed submissions for the system owner's evidence spot-check (VER-02)."""
    with engine.begin() as conn:
        since = clock.start_of_day(clock.monday_of(clock.today()) - timedelta(weeks=1))
        for sid in spot_check_sample(conn, since):
            tid = conn.execute(select(submission.c.task_id).where(submission.c.id == sid)).scalar()
            conn.execute(update(task).where(task.c.id == tid).values(spot_check=True))


async def build_pack(ctx, export_id: str) -> None:
    with engine.begin() as conn:
        try:
            packs.build(conn, uuid.UUID(export_id))
        except Exception as e:
            log.exception("pack %s failed", export_id)
            conn.rollback()
            with engine.begin() as c2:
                c2.execute(
                    update(report_export)
                    .where(report_export.c.id == uuid.UUID(export_id))
                    .values(status="failed", error=str(e)[:500])
                )


class WorkerSettings:
    redis_settings = redis_settings()
    functions = [build_pack]
    cron_jobs = [
        cron(tick, minute=set(range(0, 60, 5)), run_at_startup=True),
        cron(deliver, minute=set(range(60))),
        cron(monday_digest, weekday="mon", hour=8, minute=30),
        cron(weekly_spot_check, weekday="mon", hour=6, minute=0),
        cron(nightly, hour=3, minute=0),
    ]
    # Cron times are London wall-clock times (SCH-04).
    timezone = clock.LONDON
    max_jobs = 4
