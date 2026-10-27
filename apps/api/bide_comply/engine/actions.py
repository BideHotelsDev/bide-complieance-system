"""Actions & Advisories: priority windows and close rules (PRD §4.3, ACT-01..03)."""

from datetime import date, timedelta

PRIORITY_DAYS = {"high": 7, "med": 30, "low": 90}
# Plain-language names shown everywhere (design glossary: Urgent, Soon, Later).
PRIORITY_LABEL = {"high": "Urgent", "med": "Soon", "low": "Later"}
TYPE_LABEL = {"action": "Action", "work_required": "Work required", "advisory": "Advisory"}
SOURCE_LABEL = {
    "failed_check": "Failed check",
    "out_of_range": "Reading out of range",
    "assessor": "Assessor finding",
    "sfrs": "SFRS",
    "insurer": "Insurer",
    "incident": "Incident",
    "snag": "Snag",
    "folder_review": "Folder review",
    "certificate_fail": "Certificate fail",
    "alarm_events": "Alarm events",
    "manual": "Raised by hand",
    "gate": "Opening checklist",
    "contractor_visit": "Contractor visit",
    "hazard": "Reported hazard",
}


def due_date(priority: str, raised_on: date, klass: str | None = None) -> date:
    """HIGH closes within 7 days, and a Class A failure the same day (or an interim measure agreed in writing)."""
    if priority == "high" and klass == "A":
        return raised_on
    return raised_on + timedelta(days=PRIORITY_DAYS[priority])


def default_priority(klass: str | None) -> str:
    """A failed check's Action takes the priority window for its Class (§4.5)."""
    return {"A": "high", "B": "med", "C": "low"}.get(klass or "", "med")


def close_problem(type_: str, evidence_count: int, decision: str | None, reason: str | None) -> str | None:
    """Why an Action can't be closed yet, or None if it can (ACT-02: no evidence, not done)."""
    if type_ == "advisory":
        if not (decision and decision.strip()) or not (reason and reason.strip()):
            return "An Advisory closes only when the decision and its reason are recorded."
        return None
    if evidence_count < 1:
        return "This Action needs closing evidence: a photo, scan or certificate that shows it is fixed."
    return None


def is_late(status: str, due_on: date, today: date) -> bool:
    return status != "closed" and due_on < today


def days_left_label(due_on: date, today: date, raised_on: date | None = None, status: str = "open") -> str:
    delta = (due_on - today).days
    if status == "to_confirm" and raised_on:
        return f"open {(today - raised_on).days} days"
    if delta < 0:
        return f"{-delta} {'day' if delta == -1 else 'days'} late"
    if delta == 0:
        return "due today"
    return f"in {delta} {'day' if delta == 1 else 'days'}"
