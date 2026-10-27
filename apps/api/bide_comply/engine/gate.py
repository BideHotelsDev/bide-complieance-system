"""Opening gate status (BH-CMP-002, GATE-02..04)."""

from dataclasses import dataclass, field

NOT_READY, READY, TRADING_A_OPEN = "not_ready", "ready_to_open", "trading_a_open"
SECTIONS = {
    "A": "Approvals, legal & insurance",
    "B": "Fire risk assessment & strategy",
    "C": "Fire systems & building",
    "D": "Electrical, gas, water & wellness",
    "E": "Furniture & fit-out",
    "F": "People & response",
    "G": "Guests",
    "H": "Records, H&S & go-live",
}
OPEN_STATUSES = {"not_started", "in_progress", "to_confirm"}


@dataclass
class GateItemFacts:
    ref: str
    section: str
    klass: str
    applies: bool
    status: str
    has_evidence: bool


@dataclass
class GateSummary:
    status: str
    applicable: int
    done: int
    percent: int
    class_a_applicable: int
    class_a_done: int
    class_a_open: int
    to_confirm: int
    sections: list[dict] = field(default_factory=list)


def is_done(it: GateItemFacts) -> bool:
    # Done only counts with evidence. "To confirm" means bide believes it may be done but hasn't checked: open.
    return it.status == "done" and it.has_evidence


def summarise(items: list[GateItemFacts], trading: bool) -> GateSummary:
    applicable = [i for i in items if i.applies and i.status != "na"]
    done = [i for i in applicable if is_done(i)]
    a_items = [i for i in applicable if i.klass == "A"]
    a_done = [i for i in a_items if is_done(i)]
    a_open = len(a_items) - len(a_done)
    if a_open == 0 and a_items:
        status = READY
    elif trading:
        status = TRADING_A_OPEN  # immediate action: guests are staying with life-safety items open
    else:
        status = NOT_READY
    sections = []
    for key, name in SECTIONS.items():
        sec = [i for i in applicable if i.section == key]
        sec_done = [i for i in sec if is_done(i)]
        sections.append(
            {
                "key": key,
                "name": name,
                "total": len(sec),
                "done": len(sec_done),
                "a_open": len([i for i in sec if i.klass == "A" and not is_done(i)]),
                "in_progress": len([i for i in sec if i.status == "in_progress"]),
                "to_confirm": len([i for i in sec if i.status == "to_confirm"]),
                "not_started": len([i for i in sec if i.status == "not_started"]),
            }
        )
    return GateSummary(
        status=status,
        applicable=len(applicable),
        done=len(done),
        percent=round(100 * len(done) / len(applicable)) if applicable else 0,
        class_a_applicable=len(a_items),
        class_a_done=len(a_done),
        class_a_open=a_open,
        to_confirm=len([i for i in applicable if i.status == "to_confirm"]),
        sections=sections,
    )


def can_sign(summary: GateSummary) -> bool:
    """H08 gate sign-off only when every applicable Class A item is Done with evidence (GATE-04)."""
    return summary.status == READY
