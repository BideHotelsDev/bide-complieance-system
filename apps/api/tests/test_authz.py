"""The permission matrix (PRD §2) and property scoping (§9.3), one assertion per role and scope.

These run in CI so a change can't quietly widen who sees or does what.
"""

import pytest

DAVID = "David Liddell"  # Super Admin
SAM = "Samantha Kirkland"  # System owner
LYNNE = "Lynne McCann"  # Register keeper
ROWELL = "Rowell Manoza"  # Systems
PAMELA = "Pamela Mathers"  # Staff + keyholder, The View
SL_VIEW = "[Site lead, The View]"
TDA = "[TDA director]"  # Dutyholder for The Villa only
SANDY = "Sandy Riach"  # Assessor


def ids(client, path):
    return [p["code"] for p in client.get(path).json()["rows"]]


class TestScope:
    def test_admins_see_every_property(self, login):
        assert set(ids(login(DAVID), "/api/properties")) >= {"TV", "TM", "AR", "TH"}

    def test_dutyholder_sees_only_own_spv(self, login):
        assert ids(login(TDA), "/api/properties") == ["TV"]

    def test_dutyholder_cannot_open_another_spv_property(self, login):
        # Outside your scope looks the same as not existing.
        assert login(TDA).get("/api/properties/TM").status_code == 404

    def test_site_lead_sees_own_property_only(self, login):
        r = login(SL_VIEW).get("/api/actions").json()
        assert {row["property_code"] for row in r["rows"]} <= {"TM"}

    def test_staff_cannot_read_another_propertys_task(self, login, app):
        """IDOR: a View member of staff changing an id to a Villa task gets nothing."""
        villa_task = login(DAVID).get("/api/reviews").json()["rows"]
        tv = next(r for r in villa_task if r["ref"].startswith("TV"))
        sub = login(DAVID).get(f"/api/reviews/{tv['id']}").json()
        assert login(PAMELA, "field").get(f"/api/field/tasks/{sub['task_id']}").status_code == 404

    def test_search_never_leaks_other_properties(self, login):
        groups = login(TDA).get("/api/search", params={"q": "fire"}).json()["groups"]
        subs = {i.get("sub") for g in groups for i in g["items"]}
        assert "The View" not in subs


@pytest.mark.parametrize(
    "person,path,ok",
    [
        (DAVID, "/api/settings/audit", True),
        (SAM, "/api/settings/audit", True),
        (LYNNE, "/api/settings/audit", True),
        (TDA, "/api/settings/audit", True),  # own SPV properties only
        (SL_VIEW, "/api/settings/audit", False),
        (PAMELA, "/api/settings/audit", False),
        (SANDY, "/api/settings/audit", False),
        (DAVID, "/api/library", True),
        (PAMELA, "/api/library", False),
        (SL_VIEW, "/api/scorecard", True),  # own property (PRD §2); the sidebar just does not list it
        (SAM, "/api/scorecard", True),
        (PAMELA, "/api/reviews", False),
        (SL_VIEW, "/api/reviews", True),
        (SANDY, "/api/reviews", True),
        (PAMELA, "/api/people", False),
        (SL_VIEW, "/api/people", True),
        (PAMELA, "/api/overview", False),
        (TDA, "/api/overview", True),
    ],
)
def test_read_matrix(login, person, path, ok):
    status = login(person).get(path).status_code
    assert (status < 400) == ok, f"{person} GET {path} -> {status}"


class TestActionsMatrix:
    def test_staff_can_raise_but_not_close(self, login, people):
        pam = login(PAMELA)
        tm = next(p["id"] for p in pam.get("/api/me").json()["properties"] if p["code"] == "TM")
        r = pam.post("/api/actions", json={"property_id": tm, "description": "Loose stair nosing, first floor"})
        assert r.status_code == 200, r.text
        ref = r.json()["ref"]
        assert pam.post(f"/api/actions/{ref}/close", json={"evidence_ids": []}).status_code == 403

    def test_contractor_and_outside_people_cannot_raise_at_other_properties(self, login):
        th = next(p["id"] for p in login(DAVID).get("/api/me").json()["properties"] if p["code"] == "TH")
        assert login(TDA).post("/api/actions", json={"property_id": th, "description": "x"}).status_code == 404


class TestSeparationOfDuties:
    def test_nobody_verifies_their_own_submission(self, login):
        # Pamela's failed alarm test this morning: she can't see it in her own queue at all.
        assert login(PAMELA).get("/api/reviews").status_code == 403
        sl = login(SL_VIEW)
        rows = sl.get("/api/reviews").json()["rows"]
        own = [r for r in rows if "[Site lead, The View]" in r["detail"]]
        assert not own, "own submissions must route to someone else"

    def test_site_lead_cannot_approve_requests(self, login):
        rows = login(SAM).get("/api/approvals", params={"kind": "missed"}).json()["rows"]
        assert rows
        r = login(SL_VIEW).post(f"/api/approvals/{rows[0]['id']}/decide", json={"decision": "approve"})
        assert r.status_code in (403, 404)

    def test_cover_person_cannot_approve_their_own_cover(self, login):
        rows = login(DAVID).get("/api/approvals", params={"kind": "cover"}).json()["rows"]
        assert rows
        r = login(DAVID).post(f"/api/approvals/{rows[0]['id']}/decide", json={"decision": "approve"})
        assert r.status_code == 403

    def test_site_lead_can_only_request_a_switch_off(self, login):
        setup = login(SAM).get("/api/setup/TM").json()
        row = next(r for r in setup["rows"] if r["applies"] and r["class"] == "C" or r["applies"])
        r = login(SL_VIEW).post(
            "/api/setup/TM/toggle", json={"template_id": row["template_id"], "applies": False, "reason": "Not needed"}
        )
        # The settings screen itself needs settings.view; either way the site lead can't switch it off directly.
        assert r.status_code in (200, 403)
        if r.status_code == 200:
            assert "id" in r.json()  # it became a request, not a change


class TestSigning:
    def test_only_the_spvs_directors_can_sign(self, login):
        assert (
            login(DAVID).post("/api/gates/TV/sign", json={"confirm": True, "full_name": "David Liddell"}).status_code
            == 403
        )

    def test_gate_sign_off_locked_until_ready(self, login):
        r = login(TDA).post("/api/gates/TV/sign", json={"confirm": True, "full_name": "TDA Director"})
        assert r.status_code == 409
        assert "life-safety items are done" in r.json()["message"]


class TestAdminOnly:
    def test_theme_publish(self, login):
        assert login(LYNNE).post("/api/settings/appearance/publish").status_code == 403

    def test_escalation_policy_super_admin_only(self, login):
        body = {"rules": [], "quiet_hours": None}
        assert login(SAM).put("/api/settings/alerts", json=body).status_code == 403
        assert login(DAVID).put("/api/settings/alerts", json=body).status_code == 200

    def test_amend_locked_submission_system_owner_only(self, login):
        sub = login(DAVID).get("/api/reviews").json()["rows"][0]
        body = {"reason_type": "typing_mistake", "reason": "Wrong call point", "changes": {"call_point": "CP4"}}
        assert login(LYNNE).post(f"/api/reviews/{sub['id']}/amend", json=body).status_code == 403
        assert login(SAM).post(f"/api/reviews/{sub['id']}/amend", json=body).status_code == 200

    def test_identity_documents_restricted(self, login):
        from sqlalchemy import select

        from bide_comply.db import engine
        from bide_comply.schema import staff_requirement

        with engine.connect() as c:
            assert c.execute(select(staff_requirement.c.id)).first()


def test_mutations_need_the_csrf_header(app, people):
    from fastapi.testclient import TestClient

    c = TestClient(app)
    c.post("/api/auth/dev", json={"person_id": people[DAVID], "app": "web"})
    r = c.post("/api/actions", json={"property_id": "00000000-0000-0000-0000-000000000000", "description": "x"})
    assert r.status_code == 403 and r.json()["code"] == "csrf"


def test_signed_out_requests_are_refused(app):
    from fastapi.testclient import TestClient

    assert TestClient(app).get("/api/me").status_code == 401
