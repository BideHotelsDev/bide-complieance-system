"""A date in the past never reads as upcoming (UX audit F2)."""

from datetime import date

from bide_comply.api.home import _insurer_line
from bide_comply.services.common import due_phrase

TODAY = date(2026, 11, 15)


def test_due_phrase_says_overdue_for_past_dates():
    assert due_phrase(date(2026, 11, 9), TODAY) == "Overdue · 6 days"
    assert due_phrase(date(2026, 11, 14), TODAY) == "Overdue · 1 day"
    assert due_phrase(TODAY, TODAY) == "Due today"
    assert due_phrase(date(2026, 11, 20), TODAY) == "Due 20 Nov"
    assert due_phrase(date(2026, 11, 20), TODAY, day=True) == "Due Fri 20 Nov"


def test_home_banner_insurer_line(monkeypatch):
    monkeypatch.setattr("bide_comply.clock.today", lambda: TODAY)
    assert (
        _insurer_line("The Villa", date(2026, 11, 9))
        == "Insurance proof for The Villa is 6 days overdue (due Mon 9 Nov)."
    )
    assert _insurer_line("The Villa", TODAY) == "Insurance proof for The Villa is due today."
