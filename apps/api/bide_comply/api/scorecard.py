"""Team scorecard and the monthly site league (SCO-01..05).

Three numbers per person per week, only what the person controls: checks on time (95%), evidence complete (100%),
actions closed on time (90%). A failed check that is reported scores the same as a pass. Individual numbers are
visible only to the person and their managers; sites compete in the league, not individuals.
"""

import uuid
from datetime import date, timedelta

from fastapi import APIRouter
from sqlalchemy import func, select

from bide_comply import clock
from bide_comply.auth import Current
from bide_comply.authz import scope_filter
from bide_comply.db import ConnDep
from bide_comply.engine import kpi
from bide_comply.schema import (
    action,
    person,
    property_,
    register_item,
    role_assignment,
    submission,
    submission_evidence,
    task,
)
from bide_comply.services import views
from bide_comply.services.common import fmt_day, initials
from bide_comply.services.register import get_setting, scores

router = APIRouter(prefix="/api", tags=["scorecard"])


def person_week(conn, person_id: uuid.UUID, start: date, end: date) -> dict:
    """One person's three numbers for the week starting `start`."""
    s, e = clock.start_of_day(start), clock.end_of_day(end)
    # Attribution (SCH-13): completions count to whoever completed them; late and missed to the owner at the time.
    done = conn.execute(
        select(task.c.id, task.c.due_at, task.c.completed_at, task.c.status).where(
            task.c.completed_by == person_id, task.c.due_at >= s, task.c.due_at <= e
        )
    ).all()
    owed = conn.execute(
        select(task.c.id, task.c.status).where(
            task.c.owner_id == person_id,
            task.c.due_at >= s,
            task.c.due_at <= min(e, clock.now()),
            task.c.status.in_(("overdue", "missed")),
        )
    ).all()
    tally = kpi.TaskTally()
    for t in done:
        tally.due += 1
        if t.completed_at and t.completed_at <= t.due_at:
            tally.on_time += 1
        else:
            tally.late += 1
        n = conn.execute(
            select(func.count())
            .select_from(submission_evidence.join(submission, submission.c.id == submission_evidence.c.submission_id))
            .where(submission.c.task_id == t.id)
        ).scalar()
        tally.evidence_complete += 1 if n else 0
    for t in owed:
        tally.due += 1
        tally.missed += 1 if t.status == "missed" else 0
    acts_due = conn.execute(
        select(action.c.due_on, action.c.closed_on, action.c.status).where(
            action.c.owner_id == person_id, action.c.due_on >= start, action.c.due_on <= end
        )
    ).all()
    on_time_acts = sum(1 for a in acts_due if a.closed_on and a.closed_on <= a.due_on)
    return {
        "checks": tally.due,
        "on_time": tally.on_time_pct,
        "evidence": tally.evidence_pct,
        "actions": round(100 * on_time_acts / len(acts_due)) if acts_due else None,
        "actions_due": len(acts_due),
        "failed_reported": sum(1 for t in done if t.status == "failed"),
    }


@router.get("/scorecard")
def scorecard(pr: Current, conn: ConnDep, week: date | None = None, property: uuid.UUID | None = None) -> dict:  # noqa: A002
    pr.require("scorecard.view")
    today = clock.today()
    start = clock.monday_of(week or today)
    end = start + timedelta(days=6)
    targets = get_setting(conn, "scorecard_targets", {"on_time": 95, "evidence": 100, "actions": 90})
    # People in scope: anyone with a role at a property I can see, or a group role.
    q = (
        select(person.c.id, person.c.name, role_assignment.c.role, property_.c.name.label("property"))
        .join(role_assignment, role_assignment.c.person_id == person.c.id)
        .outerjoin(property_, property_.c.id == role_assignment.c.property_id)
        .where(
            person.c.employment_status == "active",
            person.c.kind == "staff",
            role_assignment.c.role.in_(("staff", "keyholder", "site_lead", "register_keeper", "systems")),
            scope_filter(pr, role_assignment.c.property_id) | role_assignment.c.property_id.is_(None),
        )
    )
    if property:
        q = q.where(role_assignment.c.property_id == property)
    people: dict[uuid.UUID, dict] = {}
    for r in conn.execute(q):
        p = people.setdefault(
            r.id, {"id": str(r.id), "name": r.name, "initials": initials(r.name), "properties": set()}
        )
        p["properties"].add(r.property or "Group")
    rows = []
    for pid, p in people.items():
        wk = person_week(conn, pid, start, end)
        streak = 0
        for i in range(1, 27):
            ws = start - timedelta(weeks=i)
            prev = person_week(conn, pid, ws, ws + timedelta(days=6))
            if prev["checks"] and prev["on_time"] == 100:
                streak += 1
            else:
                break
        if wk["checks"] and wk["on_time"] == 100:
            streak += 1
        rows.append(
            {
                **p,
                "properties": sorted(p["properties"]),
                "property": " · ".join(sorted(p["properties"])),
                "on_time": wk["on_time"],
                "on_time_band": kpi.band(wk["on_time"], targets["on_time"]),
                "evidence": wk["evidence"],
                "evidence_band": kpi.band(wk["evidence"], targets["evidence"]),
                "actions": wk["actions"],
                "actions_band": kpi.band(wk["actions"], targets["actions"]),
                "checks": wk["checks"],
                "actions_due": wk["actions_due"],
                "streak": streak,
            }
        )
    rows.sort(key=lambda r: (r["checks"] == 0 and r["actions_due"] == 0, r["name"]))
    l10 = views.l10(conn, pr, property)
    # Site league: monthly score per property, best first; a Clean Sheet month has zero overdue items (SCO-04).
    props = [p for p in views.visible_properties(conn, pr) if p["stage"] == "trading"]
    sc = scores(conn, [p["id"] for p in props])
    league = []
    for p in props:
        s = sc.get(p["id"])
        if not s:
            league.append({"property": p["name"], "score": None, "joins": "Joins once its register is loaded"})
            continue
        overdue = conn.execute(
            select(func.count()).where(register_item.c.property_id == p["id"], register_item.c.status == "red")
        ).scalar()
        league.append({"property": p["name"], "score": s.percent, "clean_sheet": overdue == 0, "red_line": s.red_line})
    league.sort(key=lambda x: -(x["score"] if x["score"] is not None else -1))
    # Properties not yet trading are listed after the league: they join once they open (SCO-04).
    for p in views.visible_properties(conn, pr):
        if p["stage"] != "trading":
            league.append({"property": p["name"], "score": None, "joins": "Joins once it opens"})
    for i, row in enumerate(league, start=1):
        row["position"] = i if row["score"] is not None else None
    return {
        "week_start": start,
        "week_label": f"Week of {fmt_day(start)} {start.year}",
        "prev_week": start - timedelta(weeks=1),
        "next_week": start + timedelta(weeks=1) if start < clock.monday_of(today) else None,
        "targets": targets,
        "goals": [
            {
                "label": "Life-safety checks late",
                "value": l10["class_a_overdue"],
                "goal": "0",
                "on_goal": l10["class_a_overdue"] == 0,
            },
            {
                "label": "Checks done on time",
                "value": l10["on_time_last_7"],
                "unit": "%",
                "goal": "95% or more",
                "on_goal": l10["on_time_last_7"] is not None and l10["on_time_last_7"] >= 95,
            },
            {
                "label": "Urgent actions past 7 days",
                "value": l10["high_over_7"],
                "goal": "0",
                "on_goal": l10["high_over_7"] == 0,
            },
        ],
        "people": rows,
        "league": league,
        "month_label": today.strftime("%B"),
        "definitions": {k: kpi.DEFINITIONS[k] for k in ("on_time", "evidence_complete", "actions_on_time")},
    }
