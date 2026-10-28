"""Links between screens (design: Site map › Key flows): every row that opens something must find it, and badge
counts must match the lists they point to."""

from sqlalchemy import select

from bide_comply.db import engine
from bide_comply.schema import audit_event

DAVID = "David Liddell"
SAM = "Samantha Kirkland"
TDA = "[TDA director]"
SANDY = "Sandy Riach"
SITE_LEAD = "[Site lead, The View]"


class TestCertificates:
    def test_detail_links_to_file_register_item_and_fails(self, login):
        d = login(DAVID)
        rows = d.get("/api/certificates", params={"view": "fails"}).json()["rows"]
        assert rows, "the demo PAT certificate has an open fail"
        c = d.get(f"/api/certificates/{rows[0]['id']}").json()
        assert c["register_ref"] == "TM-016"
        assert c["evidence_id"] and c["file_name"]
        assert [f["ref"] for f in c["fails"]] == ["TM-041"]
        assert d.get(f"/api/evidence/{c['evidence_id']}").status_code == 200

    def test_unknown_or_out_of_scope_is_not_found(self, login):
        d = login(DAVID)
        assert d.get("/api/certificates/00000000-0000-0000-0000-000000000000").status_code == 404
        villa = next(r for r in d.get("/api/certificates").json()["rows"] if r["property_code"] == "TV")
        # The View's site lead can't open a certificate at The Villa.
        assert login(SITE_LEAD).get(f"/api/certificates/{villa['id']}").status_code == 404

    def test_people_route_still_wins_over_the_detail_route(self, login):
        assert login(DAVID).get("/api/certificates/people").status_code == 200


class TestActions:
    def test_owner_filter_for_the_scorecard(self, login, people):
        d = login(DAVID)
        lead = people[SITE_LEAD]
        r = d.get("/api/actions", params={"owner": lead}).json()
        assert r["owner"] == {"id": lead, "name": SITE_LEAD}
        assert r["rows"] and all(x["owner_id"] == lead for x in r["rows"])
        assert f"owned by {SITE_LEAD}" in r["summary"]

    def test_detail_links_back_to_the_failed_check(self, login):
        d = login(DAVID)
        a = d.get("/api/actions/TM-044").json()
        assert a["submission_id"] and a["item_ref"] == "TM-002" and a["property_code"] == "TM"
        review = d.get(f"/api/reviews/{a['submission_id']}").json()
        assert "TM-044" in [x["ref"] for x in review["actions"]]
        assert review["property_code"] == "TM"

    def test_opens_by_database_id_too(self, login):
        d = login(DAVID)
        a = d.get("/api/actions/TV-022").json()
        assert d.get(f"/api/actions/{a['id']}").json()["ref"] == "TV-022"

    def test_undo_close_only_by_the_closer(self, login):
        d = login(DAVID)
        r = d.post(
            "/api/actions/TV-028/close",
            json={"decision": "File the current CF535 version", "decision_reason": "Recorded in FRA section 7"},
        )
        assert r.status_code == 200, r.text
        assert d.get("/api/actions/TV-028").json()["can_reopen"] is True
        assert login(SAM).post("/api/actions/TV-028/reopen").status_code == 403
        assert d.post("/api/actions/TV-028/reopen").status_code == 200
        a = d.get("/api/actions/TV-028").json()
        assert a["status"] == "open" and a["can_reopen"] is False
        assert d.post("/api/actions/TV-028/reopen").status_code == 409


class TestSignoffBadge:
    def test_badge_matches_what_the_page_says_is_awaiting(self, login):
        for who in (DAVID, TDA, SANDY):
            c = login(who)
            page = sum(p["awaiting"] for p in c.get("/api/signoffs").json()["properties"])
            assert c.get("/api/nav").json()["signoffs"] == page, who

    def test_only_signers_get_the_sign_form(self, login):
        tda = login(TDA).get("/api/signoffs").json()["properties"][0]["requests"]
        fra = next(r for r in tda if r["type"] == "fra")
        assert fra["can_sign"] is True
        sandy = login(SANDY).get("/api/signoffs").json()["properties"]
        assert all(not r["can_sign"] for p in sandy for r in p["requests"] if r["type"] != "fra_countersign")

    def test_locked_gate_signoff_is_not_on_the_to_do(self, login):
        sigs = login(TDA).get("/api/todo").json()["signatures"]
        assert sigs and all("H08" not in s["title"] for s in sigs)


class TestAssessorAndApprovals:
    def test_also_waiting_items_link_somewhere(self, login):
        walk = login(SANDY).get("/api/audit-walks/TV").json()
        assert walk["also_waiting"] and all(x["link"].startswith("/") for x in walk["also_waiting"])

    def test_approval_detail_carries_the_property_code(self, login):
        s = login(SAM)
        rows = s.get("/api/approvals", params={"kind": "switch_off"}).json()["rows"]
        d = s.get(f"/api/approvals/{rows[0]['id']}").json()
        assert d["ref"].startswith(d["property_code"])


class TestAssignToContractor:
    def test_options_list_contractors_working_here_first(self, login):
        d = login(DAVID)
        villa = d.get("/api/actions/TV-022").json()["property_id"]
        opts = d.get("/api/actions/owner-options", params={"property": villa}).json()
        assert opts["people"] and opts["contractors"]
        here = [c["here"] for c in opts["contractors"]]
        assert here == sorted(here, reverse=True)

    def test_reassign_to_a_contractor_and_back(self, login, people):
        d = login(DAVID)
        a = d.get("/api/actions/TV-021").json()
        firm = d.get("/api/actions/owner-options", params={"property": a["property_id"]}).json()["contractors"][0]
        r = d.patch("/api/actions/TV-021", json={"owner_contractor_id": firm["id"]})
        assert r.status_code == 200, r.text
        a = d.get("/api/actions/TV-021").json()
        assert a["owner_contractor_id"] == firm["id"] and a["owner"] == firm["name"] and a["owner_id"] is None
        with engine.connect() as c:
            summaries = c.execute(
                select(audit_event.c.summary).where(audit_event.c.action == "action.assign_contractor")
            ).scalars()
            assert f"Assigned TV-021 to {firm['name']}" in list(summaries)
        # Back to a named person clears the contractor.
        d.patch("/api/actions/TV-021", json={"owner_id": people[SAM]})
        a = d.get("/api/actions/TV-021").json()
        assert a["owner_contractor_id"] is None and a["owner"] == SAM

    def test_rejects_both_or_an_unknown_firm(self, login, people):
        d = login(DAVID)
        assert (
            d.patch(
                "/api/actions/TV-021",
                json={"owner_id": people[SAM], "owner_contractor_id": "00000000-0000-0000-0000-000000000000"},
            ).status_code
            == 422
        )
        bad = d.patch("/api/actions/TV-021", json={"owner_contractor_id": "00000000-0000-0000-0000-000000000000"})
        assert bad.status_code == 422

    def test_raise_straight_to_a_contractor(self, login):
        d = login(DAVID)
        villa = d.get("/api/actions/TV-022").json()["property_id"]
        firm = d.get("/api/actions/owner-options", params={"property": villa}).json()["contractors"][0]
        r = d.post(
            "/api/actions",
            json={
                "property_id": villa,
                "description": "Replace the cracked call point glass, stair 2",
                "owner_contractor_id": firm["id"],
            },
        )
        assert r.status_code == 200, r.text
        a = d.get(f"/api/actions/{r.json()['ref']}").json()
        assert a["owner_contractor_id"] == firm["id"] and a["owner"] == firm["name"]
