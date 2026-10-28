"""The staff app's connections to the management side: what Pamela does on her phone reaches the register, Evidence
review, Actions to fix and Approvals, and what managers decide comes back to her (design: AppToday..AppMe)."""

import uuid
from datetime import timedelta

from sqlalchemy import delete, func, select, update

from bide_comply import clock
from bide_comply.db import engine
from bide_comply.schema import (
    action,
    action_comment,
    action_evidence,
    leave,
    notification,
    person,
    register_item,
    staff_requirement,
    staff_requirement_type,
    submission,
    task,
)
from bide_comply.services import checks

from .conftest import upload_photo

PAM = "Pamela Mathers"
SAM = "Samantha Kirkland"
LYNNE = "Lynne McCann"


def cards(login) -> list[dict]:
    t = login(PAM, "field").get("/api/field/today").json()
    return t["overdue"] + t["today"]


def task_named(login, part: str) -> dict:
    c = next(c for c in cards(login) if part.lower() in c["full_title"].lower())
    return login(PAM, "field").get(f"/api/field/tasks/{c['task_id']}").json()


def answers(form: list[dict]) -> dict:
    out: dict = {}
    for f in form:
        t = f["type"]
        if t == "yes_no":
            out[f["key"]] = "yes"
        elif t == "pass_fail":
            out[f["key"]] = "pass"
        elif t == "pass_fail_items":
            out[f["key"]] = {i: "pass" for i in (f.get("items") or f.get("options") or [])}
        elif t == "number":
            lo, hi = f.get("min"), f.get("max")
            out[f["key"]] = lo if lo is not None else hi if hi is not None else 1
        elif t in ("text", "location", "select"):
            out[f["key"]] = (f.get("options") or ["x"])[0]
        elif t == "date":
            out[f["key"]] = clock.today().isoformat()
        elif t == "checkbox":
            out[f["key"]] = True
    return out


def photos_for(client, t: dict) -> dict:
    keys = [f["key"] for f in t["form"] if f["type"] in ("photo", "file")] or ["photo"]
    out = {}
    for f in t["form"]:
        if f["key"] in keys:
            out[f["key"]] = [
                upload_photo(client, task_id=t["task_id"]) for _ in range(max(1, f.get("min_photos") or 1))
            ]
    return out or {"photo": [upload_photo(client, task_id=t["task_id"])]}


class TestNotApplicable:
    def test_request_goes_to_approvals_and_shows_as_waiting(self, login):
        pam = login(PAM, "field")
        t = task_named(login, "Extinguishers")
        assert t["can_request_na"] and not t["na_pending"]
        assert pam.post(f"/api/field/tasks/{t['task_id']}/na", json={"reason": "Other", "note": " "}).status_code == 422
        r = pam.post(
            f"/api/field/tasks/{t['task_id']}/na",
            json={"reason": "Equipment removed", "note": "Blankets moved to the new kitchen."},
        )
        assert r.status_code == 200, r.text
        # Asking twice is refused; the check says it's waiting, on the check and on Today.
        again = pam.post(f"/api/field/tasks/{t['task_id']}/na", json={"reason": "Other", "note": "again"})
        assert again.status_code == 409
        detail = pam.get(f"/api/field/tasks/{t['task_id']}").json()
        assert detail["na_pending"] and not detail["can_request_na"]
        card = next(c for c in cards(login) if c["task_id"] == t["task_id"])
        assert card["na_pending"] is True
        # The system owner sees it in Approvals › Not applicable.
        rows = login(SAM).get("/api/approvals", params={"kind": "na"}).json()["rows"]
        assert any(r["title"].startswith("N/A: Extinguishers") for r in rows)


class TestFailedCheck:
    def test_fail_raises_an_action_in_its_window_and_the_person_can_add_to_it(self, login):
        pam = login(PAM, "field")
        t = task_named(login, "Carbon monoxide")
        vals = answers(t["form"])
        failed_key = next(f["key"] for f in t["form"] if f["type"] in ("yes_no", "pass_fail", "pass_fail_items"))
        f = next(f for f in t["form"] if f["key"] == failed_key)
        vals[failed_key] = (
            "no"
            if f["type"] == "yes_no"
            else "fail"
            if f["type"] == "pass_fail"
            else {i: "fail" for i in (f.get("items") or f.get("options"))}
        )
        r = pam.post(f"/api/field/tasks/{t['task_id']}/submit", json={"values": vals, "photos": photos_for(pam, t)})
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["result"] == "failed" and out["result_screen"]["priority_label"] == "Urgent"
        ref = out["action"]["ref"]
        # In Actions to fix for the system owner, Urgent.
        rows = login(SAM).get("/api/actions", params={"q": ref}).json()["rows"]
        assert any(a["ref"] == ref for a in rows)
        with engine.connect() as c:
            a = c.execute(select(action).where(action.c.ref == ref)).mappings().one()
        assert a["priority"] == "high" and (a["due_on"] - a["raised_on"]).days in (0, 7)
        if a["call_due"]:
            # A Class A failure: the result screen names who the §7 alert went to, the assessor by role.
            assert "the assessor" in out["result_screen"]["alerted"] and "Samantha" in out["result_screen"]["alerted"]
        # Result › Add a note or photo: filed on the Action as part of the report, not as proof it's fixed.
        assert pam.post(f"/api/field/actions/{ref}/add", json={}).status_code == 422
        ev = upload_photo(pam)
        r = pam.post(f"/api/field/actions/{ref}/add", json={"note": "Alarm unit is 11 years old.", "photos": [ev]})
        assert r.status_code == 200, r.text
        with engine.connect() as c:
            assert c.execute(select(func.count()).where(action_comment.c.action_id == a["id"])).scalar() == 1
            assert (
                c.execute(
                    select(action_evidence.c.purpose).where(
                        action_evidence.c.action_id == a["id"], action_evidence.c.evidence_id == uuid.UUID(ev)
                    )
                ).scalar()
                == "raised"
            )
        # Someone else can't add to it.
        assert login(LYNNE, "field").post(f"/api/field/actions/{ref}/add", json={"note": "x"}).status_code == 403
        # History shows it as Failed.
        rows = [row for g in pam.get("/api/field/history").json()["groups"] for row in g["rows"]]
        assert any(row["status"] == "Failed" for row in rows)


class TestOffline:
    def test_class_a_captured_offline_goes_to_evidence_review_and_history_says_so(self, login):
        pam = login(PAM, "field")
        t = task_named(login, "Emergency lighting")
        assert t["class"] == "A"
        r = pam.post(
            f"/api/field/tasks/{t['task_id']}/submit",
            json={
                "values": answers(t["form"]),
                "photos": photos_for(pam, t),
                "captured_offline": True,
                "device_time": (clock.now() - timedelta(minutes=20)).isoformat(),
            },
        )
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "submitted" and "captured_offline" in r.json()["flags"]
        reviews = login(SAM).get("/api/reviews").json()["rows"]
        assert any(row["id"] == r.json()["submission_id"] for row in reviews)
        rows = [row for g in pam.get("/api/field/history").json()["groups"] for row in g["rows"]]
        row = next(row for row in rows if row["id"] == r.json()["submission_id"])
        assert row["status"] == "Sent" and "captured offline" in row["detail"]
        # The register row moved: last done is today.
        with engine.connect() as c:
            last = c.execute(
                select(register_item.c.last_done_on)
                .join(task, task.c.register_item_id == register_item.c.id)
                .where(task.c.id == uuid.UUID(t["task_id"]))
            ).scalar()
        assert last == clock.today()


class TestReport:
    def test_life_safety_hazard_raises_an_action_and_tells_the_system_owner(self, login):
        pam = login(PAM, "field")
        prop = pam.get("/api/field/today").json()["properties"][0]["id"]
        ev = upload_photo(pam, property_id=prop)
        r = pam.post(
            "/api/field/reports",
            json={
                "kind": "hazard",
                "property_id": prop,
                "location_text": "Fire door 104",
                "description": "Door doesn't close on its own. Closer looks loose.",
                "photos": [ev],
            },
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["life_safety"] and body["action"]
        assert "Samantha" in body["told"] and "told straight away" in body["message"]
        with engine.connect() as c:
            a = c.execute(select(action).where(action.c.ref == body["action"])).mappings().one()
            assert a["class"] == "A" and a["priority"] == "high" and a["source"] == "hazard"
            sam = c.execute(select(person.c.id).where(person.c.name == SAM)).scalar()
            n = c.execute(
                select(func.count()).where(notification.c.person_id == sam, notification.c.kind == "report.urgent")
            ).scalar()
        assert n >= 1


class TestContractorVisit:
    def test_visit_with_certificate_counts_the_linked_check_done_and_fails_become_actions(self, login):
        pam = login(PAM, "field")
        prop = pam.get("/api/field/today").json()["properties"][0]["id"]
        form = pam.get("/api/field/contractor-visit", params={"property": prop}).json()
        linked = next(p for p in form["purposes"] if p["register_item_id"])
        item_id = uuid.UUID(linked["register_item_id"])
        # Give the item an open occurrence to complete.
        with engine.begin() as c:
            tid = c.execute(
                select(task.c.id)
                .where(task.c.register_item_id == item_id, task.c.status.in_(("scheduled", "open", "overdue")))
                .order_by(task.c.due_at)
                .limit(1)
            ).scalar()
            if tid:
                c.execute(
                    update(task)
                    .where(task.c.id == tid)
                    .values(status="open", window_opens_at=clock.now() - timedelta(days=1))
                )
        cert = upload_photo(pam, property_id=prop)
        bad = pam.post(
            "/api/field/contractor-visits",
            json={"property_id": prop, "purpose": linked["label"], "new_contractor": "X", "fails": [{"text": ""}]},
        )
        assert bad.status_code == 422
        r = pam.post(
            "/api/field/contractor-visits",
            json={
                "new_contractor": "Nova Fire & Security (test)",
                "property_id": prop,
                "purpose": linked["label"],
                "register_item_id": str(item_id),
                "evidence_id": cert,
                "fails": [
                    {"text": "Detector in room 7 faulty. Replace.", "priority": "high"},
                    {"text": "Zone chart by the panel out of date.", "priority": "med"},
                ],
            },
        )
        assert r.status_code == 200, r.text
        out = r.json()
        assert len(out["actions"]) == 2
        with engine.connect() as c:
            acts = {
                a.priority: (a.due_on - a.raised_on).days
                for a in c.execute(select(action).where(action.c.ref.in_(out["actions"])))
            }
            assert acts["med"] == 30 and acts["high"] in (0, 7)
            assert c.execute(select(register_item.c.last_done_on).where(register_item.c.id == item_id)).scalar() == (
                clock.today()
            )
            if tid:
                assert out["task_done"] == str(tid)
                st = c.execute(select(task.c.status).where(task.c.id == tid)).scalar()
                assert st == "failed"
                assert c.execute(select(func.count()).where(submission.c.task_id == tid)).scalar() == 1


class TestMe:
    def test_preferences_persist_and_leave_with_cover_shows(self, login):
        pam = login(PAM, "field")
        assert pam.post("/api/me/preferences", json={"push": False, "quiet_days_off": True}).status_code == 200
        me = pam.get("/api/field/me").json()
        assert me["preferences"]["push"] is False and me["preferences"]["quiet_days_off"] is True
        assert 0 <= me["streak_days"] <= 366
        with engine.begin() as c:
            pid = c.execute(select(person.c.id).where(person.c.name == PAM)).scalar()
            lynne = c.execute(select(person.c.id).where(person.c.name == LYNNE)).scalar()
            lid = uuid.uuid4()
            c.execute(
                leave.insert().values(
                    id=lid,
                    person_id=pid,
                    starts_on=clock.today() + timedelta(days=5),
                    ends_on=clock.today() + timedelta(days=16),
                    cover_id=lynne,
                    approved_by=lynne,
                )
            )
        try:
            me = pam.get("/api/field/me").json()
            assert me["away"]["cover"] == LYNNE and me["away"]["approved"] is True
            assert PAM in login(LYNNE, "field").get("/api/field/me").json()["covering"]
        finally:
            with engine.begin() as c:
                c.execute(delete(leave).where(leave.c.id == lid))
            pam.post("/api/me/preferences", json={"push": True, "quiet_days_off": False})

    def test_push_key_and_subscription(self, login):
        pam = login(PAM, "field")
        assert pam.get("/api/push/key").json() == {"public_key": None}  # no VAPID keys in tests: handled by the app
        sub = {"endpoint": "https://push.example.invalid/abc", "keys": {"p256dh": "x", "auth": "y"}}
        assert pam.post("/api/push/subscribe", json={**sub, "endpoint": "http://x"}).status_code == 422
        assert pam.post("/api/push/subscribe", json=sub).status_code == 200
        assert pam.post("/api/push/unsubscribe", json=sub).status_code == 200


class TestNotifications:
    def test_muted_channels_follow_me_settings(self):
        from bide_comply.worker import muted_channels

        assert muted_channels({}, False) == set()
        assert muted_channels({"push": False}, False) == {"push"}
        assert muted_channels({"quiet_days_off": True}, False) == set()
        assert muted_channels({"quiet_days_off": True}, True) == {"push", "slack"}

    def test_reminder_an_hour_before_goes_once_and_respects_the_setting(self, login):
        t = task_named(login, "Showerheads")
        with engine.begin() as c:
            c.execute(
                update(task)
                .where(task.c.id == uuid.UUID(t["task_id"]))
                .values(status="open", due_at=clock.now() + timedelta(minutes=30))
            )
            first = checks.due_reminders(c)
            second = checks.due_reminders(c)
            n = c.execute(
                select(func.count()).where(
                    notification.c.kind == "task.reminder", notification.c.link == f"/task/{t['task_id']}"
                )
            ).scalar()
        assert first >= 1 and second == 0 and n == first


class TestDocuments:
    def test_upload_is_checked_by_the_register_keeper_and_comes_back(self, login):
        pam = login(PAM, "field")
        docs = pam.get("/api/field/documents").json()
        assert docs["checker"] == "Lynne"
        key = docs["types"][0]["key"]
        ev = upload_photo(pam)
        assert pam.post("/api/field/documents", json={"type_key": key, "evidence_id": ev}).status_code == 200
        row = next(r for r in pam.get("/api/field/documents").json()["rows"] if r["key"] == key)
        assert row["status"] == "pending"
        with engine.connect() as c:
            pid = c.execute(select(person.c.id).where(person.c.name == PAM)).scalar()
            rid = c.execute(
                select(staff_requirement.c.id)
                .join(staff_requirement_type, staff_requirement_type.c.id == staff_requirement.c.type_id)
                .where(staff_requirement.c.person_id == pid, staff_requirement_type.c.key == key)
            ).scalar()
        lynne = login(LYNNE)
        url = f"/api/people/{pid}/requirements/{rid}/check"
        assert lynne.post(url, json={"accept": False}).status_code == 422
        assert lynne.post(url, json={"accept": True}).status_code == 200
        row = next(r for r in pam.get("/api/field/documents").json()["rows"] if r["key"] == key)
        assert row["status"] in ("ok", "expiring")
        assert lynne.post(url, json={"accept": True}).status_code == 409
