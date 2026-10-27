from datetime import UTC, date, datetime, time

import pytest

from bide_comply import clock
from bide_comply.engine import actions, forms, gate, schedule
from bide_comply.engine.status import AMBER, GREEN, GREY, RED, ItemFacts, ScoreInput, item_status, property_score

TODAY = date(2026, 10, 26)  # a Monday


def facts(**kw) -> ItemFacts:
    base = dict(
        klass="A",
        state="on",
        next_due_on=date(2026, 11, 20),
        last_done_on=date(2026, 10, 20),
        warning_days=3,
        mode="rolling",
    )
    base.update(kw)
    return ItemFacts(**base)


class TestItemStatus:
    def test_in_date_is_green(self):
        assert item_status(facts(), TODAY).status == GREEN

    def test_inside_warning_window_is_amber(self):
        assert item_status(facts(next_due_on=date(2026, 10, 28)), TODAY).status == AMBER

    def test_past_due_is_red(self):
        s = item_status(facts(next_due_on=date(2026, 10, 25)), TODAY)
        assert (s.status, s.reason) == (RED, "overdue")

    def test_never_done_is_red(self):
        assert item_status(facts(last_done_on=None, next_due_on=None), TODAY).reason == "no record"

    def test_done_without_evidence_is_red(self):
        s = item_status(facts(latest_due_task_status="passed", latest_due_task_has_evidence=False), TODAY)
        assert s.reason == "no evidence"

    def test_open_fail_action_keeps_it_red_even_with_a_later_expiry(self):
        s = item_status(facts(next_due_on=date(2027, 8, 20), open_fail_actions=1), TODAY)
        assert (s.status, s.reason) == (RED, "fail open")

    def test_switched_off_is_grey(self):
        assert item_status(facts(state="off"), TODAY).status == GREY


class TestScore:
    def test_weighted_score_and_red_line(self):
        items = [
            ScoreInput("A", GREEN),
            ScoreInput("A", RED),
            ScoreInput("B", GREEN),
            ScoreInput("C", AMBER),
            ScoreInput("C", GREY),
        ]
        s = property_score(items)
        assert (s.earned, s.available) == (6, 9)
        assert s.percent == 67
        assert s.red_line and s.status == RED

    def test_high_percentage_still_red_with_one_class_a_red(self):
        items = [ScoreInput("B", GREEN)] * 40 + [ScoreInput("A", GREEN)] * 10 + [ScoreInput("A", RED)]
        s = property_score(items)
        assert s.percent == 97 and s.status == RED

    def test_all_green_scores_green(self):
        assert property_score([ScoreInput("A", GREEN), ScoreInput("B", AMBER)]).status == GREEN

    def test_nothing_loaded(self):
        assert property_score([]).percent is None


class TestSchedule:
    def plan(self, **kw):
        base = dict(
            frequency="weekly",
            kind="check",
            due_time=time(23, 59),
            late_rule="late",
            window_hours=None,
            anchor_date=None,
            last_done_on=None,
        )
        base.update(kw)
        return schedule.Plan(**base)

    def test_weekly_one_task_per_iso_week_due_sunday(self):
        occ = schedule.occurrences(self.plan(), TODAY, date(2026, 11, 15))
        assert [o.period_key for o in occ] == ["2026-W44", "2026-W45", "2026-W46"]
        assert clock.london(occ[0].due_at).date() == date(2026, 11, 1)

    def test_weekly_anchor_weekday(self):
        occ = schedule.occurrences(self.plan(anchor_date=date(2026, 10, 19)), TODAY, date(2026, 11, 1))
        assert clock.london(occ[0].due_at).date() == TODAY  # Mondays

    def test_missed_rule_closes_window_at_due(self):
        occ = schedule.occurrences(self.plan(frequency="daily", late_rule="missed"), TODAY, TODAY)
        assert occ[0].window_closes_at == occ[0].due_at

    def test_monthly_due_last_day(self):
        occ = schedule.occurrences(self.plan(frequency="monthly"), date(2027, 2, 3), date(2027, 2, 28))
        assert clock.london(occ[0].due_at).date() == date(2027, 2, 28)

    def test_rolling_due_interval_after_last_done(self):
        occ = schedule.occurrences(self.plan(frequency="six_monthly", last_done_on=date(2026, 8, 6)), TODAY, TODAY)
        assert clock.london(occ[0].due_at).date() == date(2027, 2, 6)

    def test_certificate_task_opens_60_days_before_expiry(self):
        p = self.plan(frequency="annual", kind="certificate", expires_on=date(2027, 8, 19))
        p = schedule.Plan(**{**p.__dict__, "frequency": "per_licence"})
        occ = schedule.occurrences(p, TODAY, TODAY)
        assert clock.london(occ[0].window_opens_at).date() == date(2027, 6, 20)

    def test_bst_change(self):
        # Clocks go back on Sun 25 Oct 2026; a 23:59 due time stays 23:59 in London.
        occ = schedule.occurrences(self.plan(frequency="daily"), date(2026, 10, 24), date(2026, 10, 26))
        assert all(clock.london(o.due_at).time() == time(23, 59) for o in occ)

    def test_time_status(self):
        opens = datetime(2026, 10, 26, 0, 0, tzinfo=UTC)
        due = datetime(2026, 10, 26, 22, 59, tzinfo=UTC)
        assert (
            schedule.time_status("scheduled", datetime(2026, 10, 25, tzinfo=UTC), opens, due, None, "late")
            == "scheduled"
        )
        assert (
            schedule.time_status("scheduled", datetime(2026, 10, 26, 9, tzinfo=UTC), opens, due, None, "late") == "open"
        )
        assert (
            schedule.time_status("open", datetime(2026, 10, 27, 9, tzinfo=UTC), opens, due, None, "late") == "overdue"
        )
        assert (
            schedule.time_status("open", datetime(2026, 10, 27, 9, tzinfo=UTC), opens, due, due, "missed") == "missed"
        )
        assert schedule.time_status("passed", datetime(2026, 10, 27, tzinfo=UTC), opens, due, None, "late") == "passed"


class TestActions:
    def test_windows(self):
        assert actions.due_date("high", TODAY) == date(2026, 11, 2)
        assert actions.due_date("high", TODAY, "A") == TODAY
        assert actions.due_date("med", TODAY) == date(2026, 11, 25)
        assert actions.due_date("low", TODAY) == date(2027, 1, 24)

    def test_close_needs_evidence_or_decision(self):
        assert actions.close_problem("action", 0, None, None)
        assert actions.close_problem("action", 1, None, None) is None
        assert actions.close_problem("advisory", 3, "Call 999 first", None)
        assert actions.close_problem("advisory", 0, "Call 999 first", "FRA §4.2") is None


class TestForms:
    FORM = [
        {"key": "panel_normal", "type": "yes_no", "label": "Panel normal", "required": True, "fail_on": "no"},
        {"key": "hot", "type": "number", "label": "Hot water", "unit": " °C", "min": 50, "required": True},
        {"key": "panel_photo", "type": "photo", "label": "Panel photo", "required": True, "min_photos": 1},
    ]

    def test_pass(self):
        e = forms.evaluate(self.FORM, {"panel_normal": "yes", "hot": 52.5}, {"panel_photo": 1})
        assert e.result == "passed" and not e.missing

    def test_reading_out_of_range_fails_but_is_accepted(self):
        e = forms.evaluate(self.FORM, {"panel_normal": "yes", "hot": 46.5}, {"panel_photo": 1})
        assert e.result == "failed" and e.failed_fields[0]["why"] == "below 50 °C"

    def test_missing_photo(self):
        e = forms.evaluate(self.FORM, {"panel_normal": "yes", "hot": 55}, {})
        assert e.missing == ["Panel photo"]

    def test_schema_validation(self):
        with pytest.raises(forms.FormError):
            forms.validate_schema([{"key": "a", "type": "number", "label": "x", "min": 5, "max": 1}])


class TestGate:
    def item(self, ref, klass="A", status="done", evidence=True, applies=True):
        return gate.GateItemFacts(ref, ref[0], klass, applies, status, evidence)

    def test_ready_only_when_every_class_a_done_with_evidence(self):
        s = gate.summarise([self.item("A01"), self.item("B01"), self.item("C01", "B", "not_started")], trading=False)
        assert s.status == gate.READY and gate.can_sign(s)

    def test_done_without_evidence_is_open(self):
        s = gate.summarise([self.item("A01", evidence=False)], trading=False)
        assert s.status == gate.NOT_READY and s.class_a_open == 1

    def test_trading_with_a_items_open(self):
        s = gate.summarise([self.item("A01", status="to_confirm")], trading=True)
        assert s.status == gate.TRADING_A_OPEN and not gate.can_sign(s)
        assert s.to_confirm == 1
