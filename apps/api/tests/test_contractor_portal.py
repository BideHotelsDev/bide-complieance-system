"""Contractor portal (design: ContractorPortal; PRD §5.5): magic-link contacts see only their own contractor's visits
and Actions; their report and fix photos wait for a site manager's check in Evidence review before they count."""

import uuid

import pytest
from sqlalchemy import select

from bide_comply import emailer
from bide_comply.db import engine
from bide_comply.schema import action, action_evidence, audit_event, contractor, contractor_visit, evidence

from .conftest import As, upload_photo

NOVA = "Nova Fire & Security"
SAM = "Samantha Kirkland"
PAM = "Pamela Mathers"
SL_VIEW = "[Site lead, The View]"
SL_VILLA = "[Site lead, The Villa]"


def nova(login):
    return login(NOVA, "field")


def items(client) -> list[dict]:
    r = client.get("/api/contractor-portal")
    assert r.status_code == 200, r.text
    return r.json()["items"]


def visit(client, purpose: str) -> dict:
    return next(i for i in items(client) if i["kind"] == "visit" and i["title"] == purpose)


def card_in(rows: list[dict], title: str) -> bool:
    return any(r["title"] == title and r.get("kind") == "contractor" for r in rows)


def fix(client) -> dict:
    return next(i for i in items(client) if i["kind"] == "fix" and i["title"] == "Fix: detector in room 7")


@pytest.fixture(scope="module")
def north(app, login):
    """A second contractor with its own contact, invited by the system owner from Settings."""
    with engine.begin() as c:
        cid = c.execute(select(contractor.c.id).where(contractor.c.name == "North Group")).scalar()
        vid = uuid.uuid4()
        prop = c.execute(select(contractor_visit.c.property_id).limit(1)).scalar()
        c.execute(
            contractor_visit.insert().values(
                id=vid, contractor_id=cid, property_id=prop, visit_on="2026-11-20", purpose="Fire door survey"
            )
        )
    r = login(SAM).post(
        "/api/contractor-portal/invite", json={"contractor_id": str(cid), "email": "office@north.demo.invalid"}
    )
    assert r.status_code == 200, r.text
    return {"client": As(app, r.json()["person_id"], "field"), "visit_id": str(vid), "contractor_id": str(cid)}


class TestWhoSeesWhat:
    def test_hello_and_only_novas_work(self, login):
        r = nova(login).get("/api/contractor-portal").json()
        assert r["contractor"] == NOVA
        assert r["email_hint"] == "jobs@nova…"
        assert r["link_days"] == 7
        titles = {i["title"] for i in r["items"]}
        assert {"Bedhead sound test (TV-006)", "Emergency lighting test"} <= titles
        f = fix(nova(login))
        assert f["title"] == "Fix: detector in room 7"
        assert f["detail"] == "The View · Urgent priority"
        assert f["can_mark_fixed"]
        later = visit(nova(login), "Emergency lighting test")
        assert later["badge"] == "Booked" and not later["can_upload"]
        assert "Fire door survey" not in titles

    def test_a_contractor_cant_see_another_contractors_visits(self, login, north):
        mine = items(north["client"])
        assert [i["title"] for i in mine] == ["Fire door survey"]
        assert north["visit_id"] not in {i["id"] for i in items(nova(login))}
        # And can't act on Nova's work, even knowing the ids: it looks like it doesn't exist.
        ev = upload_photo(north["client"])
        nv = visit(nova(login), "Bedhead sound test (TV-006)")
        r = north["client"].post(f"/api/contractor-portal/visits/{nv['id']}/report", json={"evidence_ids": [ev]})
        assert r.status_code == 404
        r = north["client"].post(
            f"/api/contractor-portal/actions/{fix(nova(login))['id']}/fix", json={"evidence_ids": [ev]}
        )
        assert r.status_code == 404

    def test_contractors_get_nothing_from_the_staff_api(self, login):
        c = nova(login)
        assert c.get("/api/actions").json()["total"] == 0
        assert c.get("/api/reviews").status_code == 403
        assert c.get("/api/contractor-uploads").status_code == 403
        assert c.get("/api/me").json()["properties"] == []

    def test_staff_arent_contractors(self, login):
        assert login(PAM, "field").get("/api/contractor-portal").status_code == 403

    def test_only_admins_invite(self, login, north):
        r = login(PAM).post(
            "/api/contractor-portal/invite",
            json={"contractor_id": north["contractor_id"], "email": "someone@north.demo.invalid"},
        )
        assert r.status_code == 403

    def test_the_emailed_link_lands_on_the_staff_app(self, app, login, north):
        from fastapi.testclient import TestClient

        sent = [m for m in emailer.outbox if m["to"] == "office@north.demo.invalid"]
        assert sent and "7 days" in sent[-1]["text"]
        link = sent[-1]["text"].split()[-1]
        r = TestClient(app).get(link.split("8310", 1)[-1], follow_redirects=False)
        assert r.status_code == 302
        # A first sign-in on a device still asks for the emailed code (magic link plus OTP).
        assert r.headers["location"].endswith("/signin/code")


class TestReport:
    def test_report_waits_for_the_site_manager_then_counts(self, login):
        c = nova(login)
        v = visit(c, "Bedhead sound test (TV-006)")
        assert v["can_upload"]
        r = c.post(f"/api/contractor-portal/visits/{v['id']}/report", json={"evidence_ids": [], "note": None})
        assert r.status_code == 422
        # Someone else's file can't be passed off as the report.
        other = upload_photo(login(PAM, "field"))
        r = c.post(f"/api/contractor-portal/visits/{v['id']}/report", json={"evidence_ids": [other]})
        assert r.status_code == 422

        ev = upload_photo(c)
        r = c.post(
            f"/api/contractor-portal/visits/{v['id']}/report",
            json={"evidence_ids": [ev], "note": "All bedheads read above 75 dB"},
        )
        assert r.status_code == 200, r.text
        assert "checks it before it counts" in r.json()["message"]
        again = c.post(f"/api/contractor-portal/visits/{v['id']}/report", json={"evidence_ids": [upload_photo(c)]})
        assert again.status_code == 409

        v = visit(c, "Bedhead sound test (TV-006)")
        assert v["pending"] and not v["can_upload"] and v["badge"] == "Being checked"
        with engine.connect() as conn:
            assert conn.execute(select(contractor_visit.c.status).where(contractor_visit.c.id == v["id"])).scalar() == (
                "booked"
            )
            e = conn.execute(select(evidence.c.property_id, evidence.c.file_name).where(evidence.c.id == ev)).one()
            assert e.property_id is not None and NOVA in e.file_name

        # Staff see it in Evidence review, From contractors.
        sl = login(SL_VILLA)
        q = sl.get("/api/reviews", params={"queue": "contractor"}).json()
        assert any(t["key"] == "needs_review" and t["count"] >= 1 for t in q["queues"])
        assert card_in(sl.get("/api/reviews").json()["rows"], "Report: Bedhead sound test (TV-006)")
        card = next(x for x in q["rows"] if x["title"] == "Report: Bedhead sound test (TV-006)")
        assert NOVA in card["detail"]
        # The View's site lead doesn't see The Villa's upload.
        assert card["id"] not in {x["id"] for x in login(SL_VIEW).get("/api/contractor-uploads").json()["rows"]}
        d = sl.get(f"/api/contractor-uploads/{card['id']}").json()
        assert d["kind"] == "report" and d["note"] == "All bedheads read above 75 dB" and d["can_decide"]
        assert len(d["files"]) == 1 and d["files"][0]["url"]

        r = sl.post(f"/api/contractor-uploads/{card['id']}/decide", json={"result": "approved"})
        assert r.status_code == 200, r.text
        assert sl.post(f"/api/contractor-uploads/{card['id']}/decide", json={"result": "approved"}).status_code == 409
        v = visit(c, "Bedhead sound test (TV-006)")
        assert v["badge"] == "Done" and not v["can_upload"]
        with engine.connect() as conn:
            row = conn.execute(select(contractor_visit).where(contractor_visit.c.id == v["id"])).mappings().one()
            assert row["status"] == "done" and str(row["evidence_id"]) == ev
            assert conn.execute(
                select(audit_event.c.id).where(audit_event.c.action == "contractor.report_approved")
            ).first()


class TestFix:
    def test_mark_as_fixed_goes_to_awaiting_verification_never_closed(self, login):
        c = nova(login)
        f = fix(c)
        ev = upload_photo(c)
        r = c.post(f"/api/contractor-portal/actions/{f['id']}/fix", json={"evidence_ids": [ev], "note": "New head"})
        assert r.status_code == 200, r.text
        with engine.connect() as conn:
            a = conn.execute(select(action).where(action.c.id == f["id"])).mappings().one()
            assert a["status"] == "open"
            assert not conn.execute(select(action_evidence).where(action_evidence.c.action_id == f["id"])).first()
            assert conn.execute(
                select(audit_event.c.id).where(
                    audit_event.c.action == "contractor.fix", audit_event.c.entity_ref == a["ref"]
                )
            ).first()
        ref = a["ref"]
        assert fix(c)["badge"] == "Being checked" and not fix(c)["can_mark_fixed"]

        # The site manager sees the fix awaiting verification on the Action.
        sl = login(SL_VIEW)
        d = sl.get(f"/api/actions/{ref}").json()
        assert d["status"] == "open"
        assert d["contractor_fix"]["status"] == "pending" and d["contractor_fix"]["contractor"] == NOVA
        row = next(x for x in sl.get("/api/actions", params={"q": ref}).json()["rows"] if x["ref"] == ref)
        assert row["awaiting_verification"]

        uid = d["contractor_fix"]["upload_id"]
        # Sending back needs a comment; the contractor sees it and can try again.
        assert sl.post(f"/api/contractor-uploads/{uid}/decide", json={"result": "rejected"}).status_code == 422
        r = sl.post(
            f"/api/contractor-uploads/{uid}/decide",
            json={"result": "rejected", "comment": "The photo doesn't show the detector head."},
        )
        assert r.status_code == 200, r.text
        f = fix(c)
        assert f["badge"] == "Sent back" and f["sent_back"] == "The photo doesn't show the detector head."
        assert f["can_mark_fixed"]

        ev2 = upload_photo(c)
        r = c.post(f"/api/contractor-portal/actions/{f['id']}/fix", json={"evidence_ids": [ev2]})
        assert r.status_code == 200, r.text
        uid2 = sl.get(f"/api/actions/{ref}").json()["contractor_fix"]["upload_id"]
        assert uid2 != uid
        r = sl.post(f"/api/contractor-uploads/{uid2}/decide", json={"result": "approved"})
        assert r.status_code == 200, r.text
        d = sl.get(f"/api/actions/{ref}").json()
        assert d["status"] == "closed"
        assert [e["id"] for e in d["evidence"] if e["purpose"] == "closing"] == [ev2]
        assert fix(c)["badge"] == "Fixed"

    def test_a_pdf_isnt_a_fix_photo(self, login):
        import io

        c = nova(login)
        # Reuse the upload helper's flow with a tiny PDF.
        data = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
        slot = c.post(
            "/api/uploads", json={"content_type": "application/pdf", "size": len(data), "captured_with": "upload"}
        ).json()
        c.put(slot["upload"]["url"], content=io.BytesIO(data).getvalue(), headers={"Content-Type": "application/pdf"})
        assert c.post(f"/api/uploads/{slot['evidence_id']}/complete", json={}).status_code == 200
        with engine.connect() as conn:
            aid = conn.execute(select(action.c.id).where(action.c.owner_contractor_id.isnot(None))).scalar()
        r = c.post(f"/api/contractor-portal/actions/{aid}/fix", json={"evidence_ids": [slot["evidence_id"]]})
        assert r.status_code in (409, 422)
