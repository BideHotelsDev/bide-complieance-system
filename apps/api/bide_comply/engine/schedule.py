"""Which task occurrences a register item should have, and the lifecycle status of a task at a moment.

The scheduler is idempotent: it computes the occurrences a register item should have in the horizon, and the
services layer inserts the ones that don't exist yet (one task per period key). Past tasks are never touched when a
plan changes; future, untouched ones are regenerated (SCH-09).
"""

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

from dateutil.relativedelta import relativedelta
from dateutil.rrule import rrulestr

from bide_comply import clock
from bide_comply.engine import frequency as freq


@dataclass(frozen=True)
class Occurrence:
    period_key: str
    due_at: datetime
    window_opens_at: datetime
    window_closes_at: datetime | None  # None: completable late


@dataclass(frozen=True)
class Plan:
    frequency: str
    kind: str  # template kind
    due_time: time
    late_rule: str  # late | missed
    window_hours: int | None
    anchor_date: date | None  # weekly: the weekday to do it; monthly: the day of month
    last_done_on: date | None
    expires_on: date | None = None  # certificates: the current certificate's expiry
    lead_days: int | None = None
    rrule: str | None = None


def _window_close(due_at: datetime, late_rule: str) -> datetime | None:
    return due_at if late_rule == "missed" else None


def _calendar_occurrence(p: Plan, period_start: date, period: str) -> Occurrence:
    if period == "day":
        due_day = period_start
        key = period_start.isoformat()
    elif period == "week":
        iso = period_start.isocalendar()
        key = f"{iso.year}-W{iso.week:02d}"
        # Due on the anchor weekday if one is set, else the last day of the week.
        offset = p.anchor_date.weekday() if p.anchor_date else 6
        due_day = period_start + timedelta(days=offset)
    else:  # month
        key = period_start.strftime("%Y-%m")
        last = (period_start + relativedelta(months=1)) - timedelta(days=1)
        due_day = min(period_start.replace(day=p.anchor_date.day), last) if p.anchor_date else last
    due_at = clock.at_london(due_day, p.due_time)
    if p.window_hours:
        opens = due_at - timedelta(hours=p.window_hours)
    else:
        opens = clock.start_of_day(period_start)
    return Occurrence(key, due_at, opens, _window_close(due_at, p.late_rule))


def _period_starts(period: str, start: date, end: date) -> list[date]:
    if period == "day":
        first = start
        step = relativedelta(days=1)
    elif period == "week":
        first = clock.monday_of(start)
        step = relativedelta(weeks=1)
    else:
        first = start.replace(day=1)
        step = relativedelta(months=1)
    out = []
    d = first
    while d <= end:
        out.append(d)
        d = d + step
    return out


def occurrences(p: Plan, start: date, horizon_end: date) -> list[Occurrence]:
    """Occurrences from `start` (normally the item's activation, or today) to the horizon end."""
    f = freq.get(p.frequency)

    if p.rrule:
        rule = rrulestr(p.rrule, dtstart=datetime.combine(p.anchor_date or start, p.due_time))
        out = []
        for dt in rule.between(datetime.combine(start, time(0)), datetime.combine(horizon_end, time(23, 59)), inc=True):
            due_at = clock.at_london(dt.date(), p.due_time)
            opens = due_at - timedelta(hours=p.window_hours or 24)
            out.append(Occurrence(dt.date().isoformat(), due_at, opens, _window_close(due_at, p.late_rule)))
        return out

    if f.mode == "calendar":
        return [
            _calendar_occurrence(p, s, f.period or "day") for s in _period_starts(f.period or "day", start, horizon_end)
        ]

    if f.mode == "rolling":
        # One task at a time: due an interval after the work was last done. Never done: due straight away.
        assert f.interval is not None
        due_day = (p.last_done_on + f.interval) if p.last_done_on else (p.anchor_date or start)
        due_at = clock.at_london(due_day, p.due_time)
        warn = freq.warning_days(p.frequency, p.kind, None)
        opens = clock.start_of_day(due_day - timedelta(days=max(warn, 1)))
        if p.last_done_on:
            # Never let the next one open before the last one was done.
            opens = max(opens, clock.start_of_day(p.last_done_on + timedelta(days=1)))
        return [Occurrence(due_day.isoformat(), due_at, opens, _window_close(due_at, p.late_rule))]

    if f.mode == "expiry":
        # The renewal task appears at expiry minus the lead time and is due on the expiry date (SCH-03).
        due_day = p.expires_on or p.anchor_date or start
        lead = p.lead_days if p.lead_days is not None else freq.CERTIFICATE_LEAD_DAYS
        due_at = clock.at_london(due_day, p.due_time)
        opens = clock.start_of_day(due_day - timedelta(days=lead))
        return [Occurrence(f"exp-{due_day.isoformat()}", due_at, opens, None)]

    return []  # event-driven: nothing automatic


def next_due(p: Plan, today: date) -> date | None:
    """The date the register shows as Next due."""
    f = freq.get(p.frequency)
    if f.mode == "rolling":
        assert f.interval is not None
        return (p.last_done_on + f.interval) if p.last_done_on else None
    if f.mode == "expiry":
        return p.expires_on
    if f.mode == "event":
        return None
    occ = occurrences(p, today, today + timedelta(days=62))
    return clock.london(occ[0].due_at).date() if occ else None


# ---------------------------------------------------------------------------------------------------------------------
# Task lifecycle (PRD §10.2): Scheduled, Open, Due soon, Overdue, Submitted, Passed, Verified, Failed, Missed, N/A
# ---------------------------------------------------------------------------------------------------------------------

TERMINAL = {"passed", "verified", "failed", "missed", "na", "cancelled"}
DUE_SOON_HOURS = 2


def time_status(
    current: str, now: datetime, opens: datetime, due: datetime, closes: datetime | None, late_rule: str
) -> str:
    """Advance a task's status with the clock. Submissions move it into Submitted / Passed / Failed elsewhere."""
    if current in TERMINAL or current == "submitted":
        return current
    if now < opens:
        return "scheduled"
    if now <= due:
        return "open"
    if late_rule == "missed" and closes is not None and now > closes:
        return "missed"
    return "overdue"


def display_status(status: str, now: datetime, due: datetime) -> str:
    """'Due soon' is a display state: an open task due within 2 hours."""
    if status == "open" and due - now <= timedelta(hours=DUE_SOON_HOURS):
        return "due_soon"
    return status
