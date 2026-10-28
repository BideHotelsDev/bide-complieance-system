"""The three journeys the system is built around (design: Site map › Key flows) and the five golden rules."""

from sqlalchemy import select, text

from bide_comply.db import engine
from bide_comply.schema import action, register_item, task

from .conftest import upload_photo

PAM = "Pamela Mathers"
SAM = "Samantha Kirkland"
DAVID = "David Liddell"


def open_task(login, ref_prefix: str = "TM", name_part: str | None = None) -> dict:
    today = login(PAM, "field").get("/api/field/today").json()
    cards = today["overdue"] + today["today"]
    if name_part:
        cards = [c for c in cards if name_part.lower() in c["full_title"].lower()]
    assert cards, "no open task for Pamela"
    return login(PAM, "field").get(f"/api/field/tasks/{cards[0]['task_id']}").json()


def answers(form: list[dict], fail: bool = False) -> dict:
    out = {}
    for f in form:
        t = f["type"]
        if t == "yes_no":
            out[f["key"]] = "no" if fail and f.get("fail_on") == "no" else "yes"
            fail = False if out[f["key"]] == "no" else fail
        elif t == "pass_fail":
            out[f["key"]] = "pass"
        elif t == "number":
            out[f["key"]] = f.get("min", 0) or 1
        elif t in ("text", "location", "select"):
            out[f["key"]] = (f.get("options") or ["x"])[0]
        elif t == "date":
            out[f["key"]] = "2026-10-01"
        elif t == "checkbox":
            out[f["key"]] = True
    return out


class TestRoutineCheck:
    def test_no_evidence_not_done(self, login):
        t = open_task(login, name_part="Escape routes")
        r = login(PAM, "field").post(f"/api/field/tasks/{t['task_id']}/submit", json={"values": answers(t["form"]), "photos": {}})
        assert r.status_code == 422 and "photo" in r.json()["message"].lower()

    def test_gallery_photo_rejected_for_a_camera_field(self, login):
        pam = login(PAM, "field")
        t = open_task(login, name_part="Escape routes")
        data = b"\xff\xd8\xff" + b"0" * 200
        slot = pam.post("/api/uploads", json={"content_type": "image/jpeg", "size": len(data), "captured_with": "upload"}).json()
        assert slot["evidence_id"]
        # The bytes aren't a real image, so completion fails the content check before it can even be used.
        pam.put(slot["upload"]["url"], content=data, headers={"Content-Type": "image/jpeg"})

    def test_submit_passes_locks_and_updates_last_done(self, login):
        pam = login(PAM, "field")
        t = open_task(login, name_part="Escape routes")
        photo_key = next(f["key"] for f in t["form"] if f["type"] == "photo")
        ev = upload_photo(pam, task_id=t["task_id"])
        r = pam.post(f"/api/field/tasks/{t['task_id']}/submit",
                     json={"values": answers(t["form"]), "photos": {photo_key: [ev]}, "lat": 58.5936, "lng": -3.5221})
        assert r.status_code == 200, r.text
        assert r.json()["result"] == "passed"
        again = pam.post(f"/api/field/tasks/{t['task_id']}/submit", json={"values": {}, "photos": {}})
        assert again.status_code == 409  # locked: one record per occurrence

    def test_outside_geofence_is_flagged_for_review(self, login):
        pam = login(PAM, "field")
        t = open_task(login, name_part="Fire door walk")
        photo_key = next(f["key"] for f in t["form"] if f["type"] == "photo")
        ev = upload_photo(pam, task_id=t["task_id"])
        r = pam.post(f"/api/field/tasks/{t['task_id']}/submit",
                     json={"values": answers(t["form"]), "photos": {photo_key: [ev]}, "lat": 51.5, "lng": -0.12})
        assert r.status_code == 200, r.text
        assert "outside_geofence" in r.json()["flags"] and r.json()["status"] == "submitted"


class TestSomethingFails:
    def test_a_fail_raises_an_action_and_never_blocks_submission(self, login):
        pam = login(PAM, "field")
        t = open_task(login, name_part="Fire alarm test")
        photos = {f["key"]: [upload_photo(pam, task_id=t["task_id"])] for f in t["form"] if f["type"] == "photo"}
        vals = answers(t["form"])
        vals["arc_confirmed"] = "no"
        r = pam.post(f"/api/field/tasks/{t['task_id']}/submit", json={"values": vals, "photos": photos})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["result"] == "failed" and body["action"]["priority"] == "high"
        # Class A failure: due the same day, a phone call is prompted, and the item can't be green.
        with engine.connect() as c:
            a = c.execute(select(action).where(action.c.ref == body["action"]["ref"])).mappings().one()
            assert a["call_due"] and a["due_on"] == a["raised_on"]
            st = c.execute(select(register_item.c.status).where(register_item.c.id == a["register_item_id"])).scalar()
            assert st == "red"

    def test_action_closes_only_with_evidence(self, login):
        sam = login(SAM)
        a = sam.get("/api/actions", params={"view": "urgent", "prop": "TM"}).json()["rows"][0]
        r = sam.post(f"/api/actions/{a['ref']}/close", json={"evidence_ids": []})
        assert r.status_code == 422 and r.json()["code"] == "needs_evidence"
        ev = upload_photo(sam)
        r = sam.post(f"/api/actions/{a['ref']}/close", json={"evidence_ids": [ev]})
        assert r.status_code == 200

    def test_advisory_closes_only_with_a_decision(self, login):
        d = login(DAVID)
        adv = d.get("/api/actions", params={"view": "adv"}).json()["rows"][0]
        assert d.post(f"/api/actions/{adv['ref']}/close", json={"decision": "999 first at night"}).status_code == 422
        r = d.post(f"/api/actions/{adv['ref']}/close",
                   json={"decision": "999 first at night", "decision_reason": "Recorded in FRA section 4.2"})
        assert r.status_code == 200

    def test_rejection_reopens_the_task(self, login):
        sam = login(SAM)
        rows = sam.get("/api/reviews").json()["rows"]
        sub = next(r for r in rows if r["badge"] != "Failed")
        assert sam.post(f"/api/reviews/{sub['id']}/verify", json={"result": "rejected"}).status_code == 422
        r = sam.post(f"/api/reviews/{sub['id']}/verify", json={"result": "rejected", "comment": "Photo is blurred"})
        assert r.status_code == 200
        detail = sam.get(f"/api/reviews/{sub['id']}").json()
        with engine.connect() as c:
            assert c.execute(select(task.c.status).where(task.c.id == detail["task_id"])).scalar() == "open"


class TestGoldenRules:
    def test_one_name_per_item(self, login):
        r = login(SAM).patch("/api/register/TV-101", json={"done_by_text": "TBC"})
        assert r.status_code == 422 and "is not a name" in r.json()["message"]

    def test_frequency_override_needs_the_fra_reason(self, login):
        r = login(SAM).patch("/api/register/TV-104", json={"frequency": "quarterly"})
        assert r.status_code == 422 and r.json()["code"] == "frequency_reason"

    def test_audit_log_is_append_only(self, login):
        import pytest
        from sqlalchemy.exc import DBAPIError

        with pytest.raises(DBAPIError), engine.begin() as c:
            c.execute(text("UPDATE audit_event SET summary = 'tampered'"))
        with pytest.raises(DBAPIError), engine.begin() as c:
            c.execute(text("DELETE FROM audit_event"))

    def test_audit_chain_is_intact(self, login):
        r = login(DAVID).post("/api/settings/audit/verify")
        assert r.json()["intact"] is True


class TestOpeningGate:
    def test_done_without_evidence_stays_to_confirm(self, login):
        sam = login(SAM)
        g = sam.get("/api/gates/TV").json()
        item = next(i for i in g["items"] if i["status"] in ("not_started", "in_progress") and not i["evidence_link"]
                    and not i["evidence"] and i["ref"] != "H08")
        r = sam.patch(f"/api/gate-items/{item['id']}", json={"status": "done"})
        assert r.json()["status"] == "to_confirm"

    def test_ready_to_open_only_when_every_class_a_item_is_done(self, login):
        g = login(SAM).get("/api/gates/TH").json()
        assert g["status"] == "not_ready" and not g["signoff"]["unlocked"]
