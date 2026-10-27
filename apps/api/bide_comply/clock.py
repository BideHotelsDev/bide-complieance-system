"""Time. All business logic runs in Europe/London, including BST changes (SCH-04)."""

from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from bide_comply.config import settings

LONDON = ZoneInfo(settings.business_timezone)

# Tests and the demo pin "now" so the seeded data reads the same every day.
_frozen: datetime | None = None


def freeze(at: datetime | None) -> None:
    global _frozen
    _frozen = at


def now() -> datetime:
    return _frozen if _frozen is not None else datetime.now(UTC)


def today() -> date:
    return now().astimezone(LONDON).date()


def london(dt: datetime) -> datetime:
    return dt.astimezone(LONDON)


def at_london(d: date, t: time) -> datetime:
    """A wall-clock time in London as an aware datetime (correct across the BST change)."""
    return datetime.combine(d, t, tzinfo=LONDON)


def end_of_day(d: date) -> datetime:
    return at_london(d, time(23, 59, 59))


def start_of_day(d: date) -> datetime:
    return at_london(d, time(0, 0))


def parse_hhmm(value: str | None, default: time = time(23, 59)) -> time:
    if not value:
        return default
    h, m = value.split(":")
    return time(int(h), int(m))


def monday_of(d: date) -> date:
    return d - timedelta(days=d.weekday())
