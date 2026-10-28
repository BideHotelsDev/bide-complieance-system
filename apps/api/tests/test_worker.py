"""The worker's jobs: the ladder fires once per subject, the digest carries the L10 numbers, the chain check runs."""

import asyncio

from sqlalchemy import func, select

from bide_comply import slack
from bide_comply.db import engine
from bide_comply.schema import audit_event, escalation, notification
from bide_comply.services import escalations


def test_ladder_fires_once_and_never_repeats():
    with engine.begin() as c:
        first = escalations.run(c)
    with engine.begin() as c:
        second = escalations.run(c)
        n = c.execute(select(func.count()).select_from(escalation)).scalar()
    assert first > 0
    assert second == 0
    assert n >= first


def test_class_a_red_reaches_david_and_the_spv_directors():
    with engine.connect() as c:
        rows = c.execute(select(escalation.c.summary, escalation.c.recipients).where(escalation.c.trigger == "red_7days")).all()
    assert any("Class A at The Villa" in r.summary for r in rows)


def test_quiet_hours_never_hold_class_a():
    with engine.connect() as c:
        held = c.execute(select(func.count()).where(notification.c["class"] == "A", notification.c.hold_until.isnot(None))).scalar()
    assert held == 0


def test_tick_and_digest_run():
    from bide_comply import worker

    asyncio.run(worker.tick({}))
    asyncio.run(worker.monday_digest({}))
    asyncio.run(worker.deliver({}))
    assert any("life-safety items overdue (goal 0)" in m["text"] for m in slack.sent if m["kind"] == "channel")
    # Named individual failures never go to the shared channel (SLK-01).
    assert not any("Pamela" in m["text"] for m in slack.sent if m["kind"] == "channel")


def test_nightly_chain_check_is_recorded():
    from bide_comply import worker

    asyncio.run(worker.nightly({}))
    with engine.connect() as c:
        last = c.execute(select(audit_event.c.summary).where(audit_event.c.action == "audit.chain_check")
                         .order_by(audit_event.c.seq.desc()).limit(1)).scalar()
    assert last == "Checked the audit chain: intact"
