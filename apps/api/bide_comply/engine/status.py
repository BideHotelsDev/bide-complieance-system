"""RAG status per register item, and the weighted property score with the red-line rule (PRD §4.2).

Pure functions over plain values so the rules can be read and tested on their own. The services layer gathers the
inputs from the database.
"""

from dataclasses import dataclass, field
from datetime import date, timedelta

GREEN, AMBER, RED, GREY = "green", "amber", "red", "grey"
DEFAULT_WEIGHTS = {"A": 3, "B": 2, "C": 1}


@dataclass
class ItemFacts:
    klass: str
    state: str  # on | off | paused | draft
    next_due_on: date | None
    last_done_on: date | None
    warning_days: int
    mode: str  # calendar | rolling | expiry | event
    # The latest task whose due date has passed, if any: its lifecycle status.
    latest_due_task_status: str | None = None
    latest_due_task_has_evidence: bool = True
    open_fail_actions: int = 0  # Actions from a failed check or certificate fail, still open (DOC-07)
    unsigned: bool = False  # e.g. the FRA exists but the dutyholder hasn't signed it
    current_task_done: bool = False  # this period's task is already passed/verified


@dataclass
class ItemStatus:
    status: str
    reason: str | None = None


def item_status(f: ItemFacts, today: date) -> ItemStatus:
    if f.state in ("off", "paused"):
        return ItemStatus(GREY, "paused" if f.state == "paused" else "not applicable")
    if f.open_fail_actions:
        # A failed check or a certificate with fails can't go Green until those Actions close (§5, DOC-07).
        return ItemStatus(RED, "fail open")
    if f.latest_due_task_status in ("overdue", "missed"):
        return ItemStatus(RED, f.latest_due_task_status)
    if f.latest_due_task_status in ("passed", "verified", "submitted") and not f.latest_due_task_has_evidence:
        return ItemStatus(RED, "no evidence")
    if f.unsigned:
        return ItemStatus(RED, "unsigned")
    if f.last_done_on is None and f.mode in ("rolling", "expiry", "event"):
        # Never evidenced: there is nothing to be in date with.
        return ItemStatus(RED, "no record")
    if f.next_due_on is None:
        return ItemStatus(GREEN if f.last_done_on else RED, None if f.last_done_on else "no record")
    if f.next_due_on < today:
        return ItemStatus(RED, "overdue")
    if f.current_task_done and f.mode == "calendar":
        return ItemStatus(GREEN)
    if f.next_due_on - timedelta(days=f.warning_days) <= today:
        return ItemStatus(AMBER, "due soon")
    return ItemStatus(GREEN)


@dataclass
class ScoreInput:
    klass: str
    status: str


@dataclass
class Score:
    earned: int
    available: int
    percent: int | None  # None when nothing is scored yet (no register loaded)
    red_line: bool  # a Class A item is RED, so the property shows RED whatever its percentage
    status: str
    counts: dict[str, int] = field(default_factory=dict)
    class_a_red: int = 0


def property_score(items: list[ScoreInput], weights: dict[str, int] | None = None) -> Score:
    """Points earned ÷ points available. GREEN and AMBER earn their weight, RED nothing, GREY is excluded."""
    weights = weights or DEFAULT_WEIGHTS
    earned = available = 0
    counts = {GREEN: 0, AMBER: 0, RED: 0, GREY: 0}
    class_a_red = 0
    for it in items:
        counts[it.status] = counts.get(it.status, 0) + 1
        if it.status == GREY:
            continue
        w = weights.get(it.klass, 1)
        available += w
        if it.status in (GREEN, AMBER):
            earned += w
        elif it.status == RED and it.klass == "A":
            class_a_red += 1
    percent = round(100 * earned / available) if available else None
    red_line = class_a_red > 0
    if percent is None:
        status = GREY
    elif red_line or percent < 80:
        # "You cannot score your way past a broken alarm."
        status = RED
    elif percent < 95:
        status = AMBER
    else:
        status = GREEN
    return Score(earned, available, percent, red_line, status, counts, class_a_red)
