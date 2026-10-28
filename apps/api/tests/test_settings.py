"""Settings take effect elsewhere: a published template reaches the staff app's form and every property's schedule,
property setup switches tasks on and off, people changes move work and access, alert rules drive the ladder, the
wording reaches the notifications, the audit log links to its records, and an import creates real rows.
"""

import io
import uuid
from datetime import timedelta

from sqlalchemy import select, update

from bide_comply import clock
from bide_comply.db import engine
from bide_comply.schema import (
    action,
    content_message,
    escalation,
    gate,
    gate_item,
    notification,
    person,
    property_,
    register_item,
    task,
    template,
    template_version,
)
from bide_comply.services import escalations

DAVID = "David Liddell"
SAM = "Samantha Kirkland"
PAM = "Pamela Mathers"
SL_VIEW = "[Site lead, The View]"

ACTIVE = ("scheduled", "open", "overdue")


def item(ref_prefix: str, name_part: str) -> dict:
    with engine.connect() as c:
        return dict(
            c.execute(
                select(register_item, template.c.name, template.c.id.label("tid"))
                .join(template, template.c.id == register_item.c.template_id)
                .join(property_, property_.c.id == register_item.c.property_id)
                .where(
                    property_.c.code == ref_prefix,
                    template.c.name.ilike(f"%{name_part}%"),
                    register_item.c.state == "on",
                )
            )
            .mappings()
            .first()
        )


def tasks_of(item_id) -> list[dict]:
    with engine.connect() as c:
        return [
            dict(r)
            for r in c.execute(
                select(task).where(task.c.register_item_id == item_id).order_by(task.c.due_at)
            ).mappings()
        ]


class TestLibrary:
    def test_publish_reaches_the_staff_app_form(self, login):
        it = item("TM", "Emergency lighting flick")
        sam = login(SAM)
        d = sam.get(f"/api/library/{it['tid']}").json()
        form = d["form"] + [{"key": "torch_ok", "type": "yes_no", "label": "Torch works", "required": True}]
        r = sam.put(f"/api/library/{it['tid']}/draft", json={"form": form})
        assert r.status_code == 200, r.text
        # Nothing reaches staff until it is published.
        unstarted = [t for t in tasks_of(it["id"]) if t["status"] in ACTIVE]
        assert unstarted
        r = sam.post(f"/api/library/{it['tid']}/publish", json={"note": "Torch check"})
        assert r.status_code == 200, r.text
        v = r.json()["version"]
        with engine.connect() as c:
            ver_id = c.execute(
                select(template_version.c.id).where(
                    template_version.c.template_id == it["tid"], template_version.c.version == v
                )
            ).scalar()
        after = [t for t in tasks_of(it["id"]) if t["status"] in ACTIVE]
        assert after and all(t["template_version_id"] == ver_id for t in after)
        # The staff app shows the new question on a task nobody has started.
        t = login(PAM, "field").get(f"/api/field/tasks/{after[0]['id']}")
        assert t.status_code == 200, t.text
        assert any(f["key"] == "torch_ok" for f in t.json()["form"])

    def test_publish_rule_change_replans_every_property(self, login):
        it = item("TM", "Carbon monoxide alarm test")
        sam = login(SAM)
        before = {t["period_key"] for t in tasks_of(it["id"]) if t["status"] in ACTIVE}
        assert any("-W" not in k for k in before)  # monthly periods ("2026-10")
        assert sam.put(f"/api/library/{it['tid']}/draft", json={"settings": {"default_frequency": "weekly"}}).is_success
        assert sam.post(f"/api/library/{it['tid']}/publish", json={}).is_success
        live = [t for t in tasks_of(it["id"]) if t["status"] in ACTIVE]
        assert any("-W" in t["period_key"] for t in live), "weekly tasks were not generated"
        with engine.connect() as c:
            assert c.execute(select(template.c.default_frequency).where(template.c.id == it["tid"])).scalar() == (
                "weekly"
            )
        # And back, so the rest of the suite sees the seeded plan.
        sam.put(f"/api/library/{it['tid']}/draft", json={"settings": {"default_frequency": "monthly"}})
        assert sam.post(f"/api/library/{it['tid']}/publish", json={}).is_success

    def test_bad_rule_values_get_plain_messages(self, login):
        it = item("TM", "Carbon monoxide alarm test")
        sam = login(SAM)
        for bad in ({"late_rule": "never"}, {"verification": "maybe"}, {"warning_days": -3}, {"name": "  "}):
            r = sam.put(f"/api/library/{it['tid']}/draft", json={"settings": bad})
            assert r.status_code == 422, bad
        sam.delete(f"/api/library/{it['tid']}/draft")

    def test_archive_check_needs_library_rights(self, login):
        it = item("TM", "Carbon monoxide alarm test")
        assert login(PAM).get(f"/api/library/{it['tid']}/archive-check").status_code == 403


class TestPropertySetup:
    def test_switching_off_cancels_future_tasks_and_on_brings_them_back(self, login):
        it = item("TM", "Flush little-used outlets")
        live = [t for t in tasks_of(it["id"]) if t["status"] == "scheduled"]
        assert live
        sam = login(SAM)
        r = sam.post("/api/setup/TM/toggle", json={"template_id": str(it["tid"]), "applies": False, "reason": "Test"})
        assert r.status_code == 200, r.text
        future = [t for t in tasks_of(it["id"]) if t["window_opens_at"] > clock.now()]
        assert future and all(t["status"] == "cancelled" for t in future)
        r = sam.post("/api/setup/TM/toggle", json={"template_id": str(it["tid"]), "applies": True})
        assert r.status_code == 200, r.text
        back = [t for t in tasks_of(it["id"]) if t["status"] == "scheduled"]
        assert len(back) >= len(live)

    def test_changing_who_does_it_keeps_the_future_and_moves_unfinished_tasks(self, login, people):
        it = item("TM", "Fire door walk-check")
        before = [t for t in tasks_of(it["id"]) if t["status"] in ACTIVE]
        assert before
        sam = login(SAM)
        r = sam.patch(
            f"/api/register/{it['ref']}",
            json={"done_by_kind": "person", "done_by_id": people[PAM], "accountable_id": people[SAM]},
        )
        assert r.status_code == 200, r.text
        after = [t for t in tasks_of(it["id"]) if t["status"] in ACTIVE]
        # The plan change cancels and regenerates the future; no week is lost.
        assert {t["period_key"] for t in after} >= {t["period_key"] for t in before}
        assert all(str(t["doer_id"]) == people[PAM] and t["doer_kind"] == "person" for t in after)
        assert all(str(t["owner_id"]) == people[SAM] for t in after)


class TestPeople:
    def test_role_changes_change_what_someone_can_see(self, login, people):
        david = login(DAVID)
        pid = people[SL_VIEW]
        assert login(SL_VIEW).get("/api/properties/TV").status_code == 404
        r = david.post(f"/api/people/{pid}/roles", json={"role": "site_lead", "property_id": _prop("TV")})
        assert r.status_code == 200, r.text
        assert login(SL_VIEW).get("/api/properties/TV").status_code == 200
        # The same role twice is a plain conflict, not a server error.
        again = david.post(f"/api/people/{pid}/roles", json={"role": "site_lead", "property_id": _prop("TV")})
        assert again.status_code == 409
        role_id = next(
            r["id"]
            for r in david.get(f"/api/people/{pid}").json()["roles"]
            if r["role"] == "site_lead" and r.get("property") == "The Villa"
        )
        assert david.delete(f"/api/people/{pid}/roles/{role_id}").status_code == 200
        assert login(SL_VIEW).get("/api/properties/TV").status_code == 404

    def test_offboarding_moves_unfinished_tasks_to_the_cover(self, login):
        david = login(DAVID)
        r = david.post(
            "/api/people",
            json={"name": "Test Leaver", "email": f"leaver-{uuid.uuid4().hex[:6]}@example.com", "role": "staff"},
        )
        assert r.status_code == 200, r.text
        leaver = r.json()["id"]
        it = item("TM", "Emergency lighting flick")
        cover = it["cover_id"] or it["accountable_id"]
        with engine.begin() as c:
            c.execute(
                update(register_item)
                .where(register_item.c.id == it["id"])
                .values(accountable_id=leaver, cover_id=cover, done_by_kind="person", done_by_person_id=leaver)
            )
            c.execute(
                update(task)
                .where(task.c.register_item_id == it["id"], task.c.status.in_(ACTIVE))
                .values(owner_id=leaver, doer_kind="person", doer_id=leaver)
            )
        assert david.post(f"/api/people/{leaver}/offboard").status_code == 200
        left = [t for t in tasks_of(it["id"]) if t["status"] in ACTIVE]
        assert left and all(t["owner_id"] == cover and t["doer_id"] == cover for t in left)


def _prop(code: str) -> str:
    with engine.connect() as c:
        return str(c.execute(select(property_.c.id).where(property_.c.code == code)).scalar())


class TestAlertsAndWording:
    def test_after_n_days_is_saved_and_drives_the_ladder(self, login):
        david = login(DAVID)
        rules = david.get("/api/settings/alerts").json()["rules"]
        r7 = next(r for r in rules if r["trigger"] == "red_7days")
        assert r7["days"] == 7
        body = {
            "rules": [
                {
                    "trigger": "red_7days",
                    "recipients": [{k: v for k, v in x.items() if k != "label"} for x in r7["recipients"]],
                    "channels": [c["key"] for c in r7["channels"] if c["on"]],
                    "days": 3,
                }
            ]
        }
        assert david.put("/api/settings/alerts", json=body).status_code == 200
        assert (
            next(r for r in david.get("/api/settings/alerts").json()["rules"] if r["trigger"] == "red_7days")["days"]
            == 3
        )
        # A Class B item four days overdue now reaches step 3.
        it = _class_b_item("TM")
        with engine.begin() as c:
            c.execute(
                update(register_item)
                .where(register_item.c.id == it)
                .values(status="red", status_reason="overdue", next_due_on=clock.today() - timedelta(days=4))
            )
            escalations.run(c)
            fired = c.execute(
                select(escalation.c.summary).where(
                    escalation.c.trigger == "red_7days", escalation.c.register_item_id == it
                )
            ).scalar()
        assert fired and "overdue for 3 days" in fired
        body["rules"][0]["days"] = 7
        assert david.put("/api/settings/alerts", json=body).status_code == 200
        bad = {**body, "rules": [{**body["rules"][0], "days": 0}]}
        assert david.put("/api/settings/alerts", json=bad).status_code == 422

    def test_published_wording_is_what_people_receive(self, login):
        sam = login(SAM)
        old = sam.get("/api/settings/content/check_overdue").json()["body"]
        new = "{check} at {property} is {days_overdue} overdue. Open it to do it now, or tell {site_lead}."
        assert sam.put("/api/settings/content/check_overdue", json={"body": new}).status_code == 200
        # A draft isn't used.
        it = _class_b_item("AR") or _class_b_item("TH") or _class_b_item("TV")
        assert sam.post("/api/settings/content/publish").status_code == 200
        with engine.begin() as c:
            c.execute(
                update(register_item)
                .where(register_item.c.id == it)
                .values(status="red", status_reason="overdue", next_due_on=clock.today() - timedelta(days=2))
            )
            escalations.run(c)
            bodies = c.execute(
                select(notification.c.body, notification.c.title)
                .join(escalation, escalation.c.id == notification.c.escalation_id)
                .where(escalation.c.register_item_id == it, escalation.c.trigger == "red_day1")
            ).all()
        assert bodies
        assert all(b.body.endswith(".") and "Open it to do it now, or tell" in b.body for b in bodies)
        assert all("2 days overdue" in b.body and "usually takes" not in b.body for b in bodies)
        assert all("is overdue" in b.title for b in bodies)  # the short version
        with engine.begin() as c:
            c.execute(update(content_message).where(content_message.c.key == "check_overdue").values(body=old))

    def test_screen_wording_is_served_to_everyone_signed_in(self, login):
        r = login(PAM, "field").get("/api/settings/wording")
        assert r.status_code == 200
        assert "never tracks where you are" in r.json()["privacy_notice"]


def _class_b_item(code: str):
    with engine.connect() as c:
        return c.execute(
            select(register_item.c.id)
            .join(template, template.c.id == register_item.c.template_id)
            .join(property_, property_.c.id == register_item.c.property_id)
            .where(
                property_.c.code == code,
                template.c["class"] == "B",
                register_item.c.state == "on",
                template.c.kind == "check",
            )
            .limit(1)
        ).scalar()


class TestAuditAndImport:
    def test_audit_events_link_to_their_record(self, login):
        rows = login(DAVID).get("/api/settings/audit", params={"when": "all", "page_size": 200}).json()["rows"]
        pub = next(r for r in rows if r["action"] == "template.publish")
        assert pub["link"].startswith("/settings/library/")
        sub = next((r for r in rows if r["action"] == "submission.create"), None)
        if sub:
            assert sub["link"] == f"/properties/{sub['record'][:2]}?item={sub['record']}"
        act = next(r for r in rows if r["action"] == "action.raise")
        assert act["link"] == f"/actions?sel={act['record']}"

    def test_import_creates_real_rows(self, login):
        from openpyxl import Workbook

        wb = Workbook()
        ws = wb.active
        ws.title = "The Hearth"
        ws.append(["Ref", "Section", "Item", "Class", "Status", "Owner", "Evidence filed", "Notes"])
        ws.append(["A01", "A. Approvals", "Building warrant completion certificate", "A", "Done", "David", None, None])
        ws.append(["B02", "B. Fire", "Fire risk assessment", "A", "In progress", "Site lead", "fra.pdf", None])
        acts = wb.create_sheet("Actions & Advisories")
        acts.append(["ID", "Type", "Description", "Priority", "Owner", "Raised", "Due", "Status"])
        ref = f"TH-9{uuid.uuid4().int % 90 + 10}"
        acts.append([ref, "Action", "Fit a keybox at the side door", "High", "Keyholder", "20 Oct 2026", None, "Open"])
        buf = io.BytesIO()
        wb.save(buf)
        data = buf.getvalue()

        david = login(DAVID)
        ct = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        slot = david.post(
            "/api/uploads",
            json={"content_type": ct, "size": len(data), "captured_with": "upload", "file_name": "g.xlsx"},
        )
        assert slot.status_code == 200, slot.text
        slot = slot.json()
        assert david.put(slot["upload"]["url"], content=data, headers={"Content-Type": ct}).status_code == 200
        assert david.post(f"/api/uploads/{slot['evidence_id']}/complete", json={}).status_code == 200
        r = david.post("/api/imports", json={"evidence_id": slot["evidence_id"]})
        assert r.status_code == 200, r.text
        jid = r.json()["id"]
        job = david.get(f"/api/imports/{jid}").json()
        assert job["plan"]["gate_items"] == 2 and job["plan"]["actions"] == 1
        assert "Site lead" in job["plan"]["role_owners"] and "Keyholder" in job["plan"]["role_owners"]
        assert david.put(f"/api/imports/{jid}", json={"owner_map": {"Keyholder": login_id(SAM)}}).status_code == 200
        res = david.post(f"/api/imports/{jid}/run").json()
        assert res["actions"] == 1
        with engine.connect() as c:
            a = c.execute(select(action).where(action.c.ref == ref)).mappings().one()
            assert str(a["owner_id"]) == login_id(SAM) and a["priority"] == "high"
            gi = (
                c.execute(
                    select(gate_item.c.ref, gate_item.c.status)
                    .join(gate, gate.c.id == gate_item.c.gate_id)
                    .join(property_, property_.c.id == gate.c.property_id)
                    .where(property_.c.code == "TH", gate_item.c.ref.in_(("A01", "B02")))
                )
                .mappings()
                .all()
            )
        st = {g["ref"]: g["status"] for g in gi}
        assert st["A01"] == "to_confirm"  # done with no evidence is not done
        assert st["B02"] == "in_progress"
        # Running it again never duplicates an Action.
        again = david.get(f"/api/imports/{jid}").json()["plan"]
        assert again["actions"] == 0 and again["actions_already_here"] == 1


def login_id(name: str) -> str:
    with engine.connect() as c:
        return str(c.execute(select(person.c.id).where(person.c.name == name)).scalar())


class TestContractorPortal:
    def test_send_portal_link_and_see_who_has_access(self, login):
        david = login(DAVID)
        rows = david.get("/api/contractors").json()["rows"]
        c = rows[0]
        email = f"portal-{uuid.uuid4().hex[:6]}@example.com"
        r = david.post("/api/contractor-portal/invite", json={"contractor_id": c["id"], "email": email, "name": "Jo"})
        assert r.status_code == 200, r.text
        after = next(x for x in david.get("/api/contractors").json()["rows"] if x["id"] == c["id"])
        assert any(p["email"] == email and p["active"] for p in after["portal"])
        # Only people managers can send one.
        assert (
            login(PAM)
            .post("/api/contractor-portal/invite", json={"contractor_id": c["id"], "email": email})
            .status_code
            == 403
        )
