"""Frequencies: what each one means for scheduling, amber windows and labels (PRD §4.2, SCH-01).

Three scheduling modes:

- calendar: one task per calendar period (day, week, month). Staff see these in Today.
- rolling: one task at a time, due a fixed interval after the work was last done (quarterly and longer).
- expiry: certificates and licences; the task appears at expiry minus a lead time (SCH-03).
- event: no automatic task (on change, each event, each booking); the item is kept current by hand or by an
  integration, and stays red until it has evidence.
"""

from dataclasses import dataclass

from dateutil.relativedelta import relativedelta


@dataclass(frozen=True)
class Frequency:
    key: str
    label: str
    mode: str  # calendar | rolling | expiry | event
    period: str | None = None  # calendar: day | week | month
    interval: relativedelta | None = None  # rolling and expiry
    warning_days: int = 3


FREQUENCIES: dict[str, Frequency] = {
    f.key: f
    for f in [
        # "Each visit, recorded weekly" (BH-CMP-001 §8): one record a week covering the visits.
        Frequency("each_visit", "Each visit", "calendar", period="week", warning_days=3),
        Frequency("daily", "Daily", "calendar", period="day", warning_days=0),
        Frequency("daily_in_use", "Daily in use", "calendar", period="day", warning_days=0),
        Frequency("weekly", "Weekly", "calendar", period="week", warning_days=3),
        Frequency("monthly", "Monthly", "calendar", period="month", warning_days=3),
        Frequency("quarterly", "Quarterly", "rolling", interval=relativedelta(months=3), warning_days=14),
        Frequency("six_monthly", "6-monthly", "rolling", interval=relativedelta(months=6), warning_days=14),
        Frequency("annual", "Annual", "rolling", interval=relativedelta(years=1), warning_days=60),
        Frequency("two_yearly", "2-yearly", "rolling", interval=relativedelta(years=2), warning_days=60),
        Frequency("five_yearly", "5-yearly", "rolling", interval=relativedelta(years=5), warning_days=60),
        Frequency("ten_yearly", "10-yearly", "rolling", interval=relativedelta(years=10), warning_days=60),
        Frequency("per_licence", "Per licence", "expiry", warning_days=60),
        Frequency("on_change", "On change", "event", warning_days=0),
        Frequency("each_event", "Each event", "event", warning_days=0),
        Frequency("each_booking", "Each booking", "event", warning_days=0),
        Frequency("on_hire", "On hire + renewal", "expiry", warning_days=60),
        Frequency("custom", "Custom", "calendar", period="day", warning_days=3),
    ]
}

# Certificates warn at 60 days whatever their interval: contractors need booking (§4.2).
CERTIFICATE_WARNING_DAYS = 60
CERTIFICATE_LEAD_DAYS = 60


def get(key: str) -> Frequency:
    try:
        return FREQUENCIES[key]
    except KeyError:
        raise ValueError(f"Unknown frequency {key!r}") from None


def label(key: str | None) -> str:
    if not key:
        return ""
    f = FREQUENCIES.get(key)
    return f.label if f else key


def warning_days(
    frequency: str, kind: str, template_override: int | None, windows: dict[str, int] | None = None
) -> int:
    """Days before the due date that an item turns Amber. Editable per frequency (CMS-04) and per template."""
    if template_override is not None:
        return template_override
    if kind == "certificate":
        return (windows or {}).get("certificate", CERTIFICATE_WARNING_DAYS)
    if windows and frequency in windows:
        return windows[frequency]
    return get(frequency).warning_days
