"""Fixed KPI definitions, shown in tooltips (DSH-10) and used by the scorecard (SCO-01..03)."""

from dataclasses import dataclass

DEFINITIONS = {
    "score": "Points earned ÷ points available. Class A = 3, B = 2, C = 1. Green and Amber earn their weight, Red "
    "earns nothing, Grey (approved N/A) is left out. Any Class A item Red turns the property Red whatever the "
    "percentage.",
    "on_time": "Checks completed by their due time ÷ (checks due − approved N/A).",
    "completion": "Checks completed, including late ones ÷ (checks due − approved N/A).",
    "missed": "Checks that closed as Missed ÷ (checks due − approved N/A).",
    "verification_rate": "Submissions verified ÷ submissions that require verification.",
    "evidence_complete": "Completed checks with every required photo or file ÷ completed checks.",
    "actions_on_time": "Actions closed within their priority window ÷ Actions due in the period.",
    "class_a_overdue": "Class A register items currently Red.",
    "high_over_7": "Urgent (HIGH) Actions open for more than 7 days.",
}


@dataclass
class TaskTally:
    due: int = 0
    na: int = 0
    on_time: int = 0
    late: int = 0
    missed: int = 0
    failed: int = 0
    evidence_complete: int = 0
    needs_verification: int = 0
    verified: int = 0

    @property
    def denominator(self) -> int:
        return max(self.due - self.na, 0)

    def pct(self, n: int) -> int | None:
        d = self.denominator
        return round(100 * n / d) if d else None

    @property
    def on_time_pct(self) -> int | None:
        return self.pct(self.on_time)

    @property
    def completion_pct(self) -> int | None:
        # Failed checks were done and reported: they count as completed (SCO-02, fails never cost points).
        return self.pct(self.on_time + self.late)

    @property
    def missed_pct(self) -> int | None:
        return self.pct(self.missed)

    @property
    def verification_pct(self) -> int | None:
        return round(100 * self.verified / self.needs_verification) if self.needs_verification else None

    @property
    def evidence_pct(self) -> int | None:
        done = self.on_time + self.late
        return round(100 * self.evidence_complete / done) if done else None


def band(value: int | None, target: int) -> str:
    """Scorecard bars: amber below target, red below 80% (design: Team scorecard)."""
    if value is None:
        return "none"
    if value >= target:
        return "green"
    if value >= 80:
        return "amber"
    return "red"
