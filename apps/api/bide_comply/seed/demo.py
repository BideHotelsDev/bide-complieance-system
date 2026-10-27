"""Demo data for development, the staging demo and screenshots.

Properties, SPVs, Actions (TV-, TM-, AR-, TH- rows), gate notes and certificates come from BH-CMP-001 and
BH-CMP-002 as shown in the product design (24 Oct 2026). People whose names David's documents leave to confirm keep
the design's placeholders ("[Site lead, The View]"). Every demo address is @demo.invalid, so nothing can email a real
person. Photos are generated placeholders labelled with what the real photo shows.
"""

import io
import uuid
from datetime import UTC, date, datetime, time, timedelta

from PIL import Image, ImageDraw, ImageFont
from sqlalchemy import Connection, select, update

from bide_comply import audit, clock
from bide_comply.authz import load_principal
from bide_comply.schema import (
    action,
    alarm_event,
    approval_request,
    audit_walk,
    audit_walk_line,
    certificate,
    contractor,
    contractor_visit,
    device,
    dutyholder,
    dutyholder_director,
    evidence,
    gate,
    gate_item,
    gate_template_item,
    leave,
    location,
    person,
    pool,
    pool_member,
    property_,
    register_item,
    role_assignment,
    signature_request,
    staff_requirement,
    staff_requirement_type,
    submission,
    submission_evidence,
    task,
    template,
    template_version,
    verification,
)
from bide_comply.seed import library as lib
from bide_comply.services import checks
from bide_comply.services.common import file_name
from bide_comply.services.evidence import store_bytes
from bide_comply.services.register import recompute_item, refresh_item

D = date.fromisoformat


def placeholder_image(label: str, w: int = 1200, h: int = 900) -> bytes:
    img = Image.new("RGB", (w, h), (241, 241, 243))
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.load_default(size=34)
    except TypeError:
        font = ImageFont.load_default()
    words, lines, line = label.split(), [], ""
    for wd in words:
        if len(line) + len(wd) > 38:
            lines.append(line)
            line = wd
        else:
            line = f"{line} {wd}".strip()
    lines.append(line)
    y = h // 2 - len(lines) * 24
    for ln in lines:
        tw = draw.textlength(ln, font=font)
        draw.text(((w - tw) / 2, y), ln, fill=(94, 94, 105), font=font)
        y += 48
    out = io.BytesIO()
    img.save(out, "JPEG", quality=80)
    return out.getvalue()


def placeholder_pdf(title: str, body: str) -> bytes:
    import weasyprint

    html = f"""<html><body style="font-family: Inter, sans-serif; padding: 48px; color:#111113">
    <p style="color:#6B6B76;font-size:12px">bide Comply · demo document</p><h1 style="font-size:22px">{title}</h1>
    <p style="background:#F1F1F3;padding:32px;color:#5E5E69">{body}</p></body></html>"""
    return weasyprint.HTML(string=html).write_pdf()


def run(conn: Connection) -> None:
    if conn.execute(select(property_.c.id).limit(1)).first():
        print("Demo data already loaded; skipping.")
        return
    today = clock.today()
    now = clock.now()

    # --- SPVs ---------------------------------------------------------------------------------------------------
    spv = {}
    for key, name in [
        ("TDA", "TDA Properties Scotland Ltd"),
        ("MARINE", "The Marine Apartments Ltd"),
        ("NETHERLY", "Netherly Apartments Ltd"),
    ]:
        spv[key] = uuid.uuid4()
        conn.execute(dutyholder.insert().values(id=spv[key], name=name))

    # --- Properties ---------------------------------------------------------------------------------------------
    props = {}
    rows = [
        (
            "TM",
            "The View",
            "Thurso",
            "MARINE",
            "trading",
            None,
            D("2026-08-06"),
            "Highland",
            {"has_fire_alarm": True, "has_sauna": True, "has_salto": True, "has_gas": True, "unmanned": True},
            (58.5936, -3.5221),
            1,
        ),
        (
            "TV",
            "The Villa",
            "Montrose",
            "TDA",
            "trading",
            None,
            D("2026-10-21"),
            "Angus",
            {
                "has_fire_alarm": True,
                "has_sauna": True,
                "has_hot_tub": True,
                "has_salto": True,
                "has_gas": True,
                "unmanned": True,
            },
            (56.7086, -2.4670),
            0,
        ),
        (
            "AR",
            "Ardentorrie",
            "Inverness",
            None,
            "trading",
            "interim",
            None,
            "Highland",
            {"has_fire_alarm": True},
            (57.4778, -4.2247),
            2,
        ),
        (
            "TH",
            "The Hearth",
            "Ballater",
            "NETHERLY",
            "pre_opening",
            None,
            None,
            "Aberdeenshire",
            {"has_fire_alarm": True, "has_oil": True, "unmanned": True},
            (57.0497, -3.0389),
            3,
        ),
        ("EH", "Elderberry Hall", "Fishburn", None, "setup", "Loads in December", None, "Durham", {}, None, 4),
        ("BS", "bide Stays", None, None, "setup", "Loads in December", None, None, {}, None, 5),
    ]
    for code, name, town, s, stage, note, since, la, features, geo, sort in rows:
        pid = uuid.uuid4()
        props[code] = pid
        conn.execute(
            property_.insert().values(
                id=pid,
                code=code,
                name=name,
                town=town,
                dutyholder_id=spv.get(s) if s else None,
                jurisdiction="england" if code == "EH" else "scotland",
                local_authority=la,
                licence_regime="stl" if code == "BS" else "class7_hotel",
                stage=stage,
                stage_note=note,
                trading_since=since,
                opening_date=D("2027-04-01") if code == "TH" else since,
                features=features,
                geofence_lat=geo[0] if geo else None,
                geofence_lng=geo[1] if geo else None,
                geofence_radius_m=150 if geo else None,
                sort=sort,
            )
        )

    # --- People -------------------------------------------------------------------------------------------------
    people: dict[str, uuid.UUID] = {}

    def add_person(key, name, title, kind="staff", roles=()):
        pid = uuid.uuid4()
        people[key] = pid
        email = f"{key}@demo.invalid"
        conn.execute(
            person.insert().values(
                id=pid, name=name, email=email, title=title, kind=kind, onboarded_at=now, privacy_notice_seen_at=now
            )
        )
        for role, prop in roles:
            conn.execute(
                role_assignment.insert().values(
                    id=uuid.uuid4(), person_id=pid, role=role, property_id=props[prop] if prop else None
                )
            )
        return pid

    add_person("david", "David Liddell", "Director", roles=[("super_admin", None), ("keyholder", "TV")])
    add_person("kyle", "Kyle Mendoza", "Technical admin", roles=[("super_admin", None)])
    add_person("samantha", "Samantha Kirkland", "System owner", roles=[("system_owner", None), ("keyholder", "TV")])
    add_person("lynne", "Lynne McCann", "Register keeper", roles=[("register_keeper", None)])
    add_person("rowell", "Rowell Manoza", "Systems", roles=[("systems", None)])
    add_person("pamela", "Pamela Mathers", "Housekeeping · The View", roles=[("staff", "TM"), ("keyholder", "TM")])
    add_person(
        "sl_view", "[Site lead, The View]", "Site lead · The View", roles=[("site_lead", "TM"), ("keyholder", "TM")]
    )
    add_person("sl_villa", "[Site lead, The Villa]", "Site lead · The Villa", roles=[("site_lead", "TV")])
    add_person("kh_villa", "[Keyholder, The Villa]", "Keyholder · The Villa", roles=[("keyholder", "TV")])
    add_person("hk_villa", "[Housekeeper, The Villa]", "Housekeeping · The Villa", roles=[("staff", "TV")])
    add_person(
        "sandy",
        "Sandy Riach",
        "Competent assessor · AJR FM",
        kind="external",
        roles=[("assessor", "TV"), ("assessor", "TM"), ("assessor", "AR"), ("assessor", "TH")],
    )
    add_person("tda", "[TDA director]", "Director · TDA Properties Scotland Ltd", kind="external")
    add_person("marine", "[Marine Apartments director]", "Director · The Marine Apartments Ltd", kind="external")
    add_person("netherly", "[Netherly director]", "Director · Netherly Apartments Ltd", kind="external")
    for key, s in [("tda", "TDA"), ("marine", "MARINE"), ("netherly", "NETHERLY")]:
        conn.execute(dutyholder_director.insert().values(dutyholder_id=spv[s], person_id=people[key]))
    conn.execute(
        device.insert().values(
            id=uuid.uuid4(),
            person_id=people["pamela"],
            label="iPhone · staff app",
            app="field",
            fingerprint_hash="0" * 64,
            trusted_at=datetime(2026, 10, 12, 9, 0, tzinfo=UTC),
            trusted_until=datetime(2027, 1, 10, 9, 0, tzinfo=UTC),
            last_seen_at=now,
        )
    )

    # --- Pools, contractors, locations --------------------------------------------------------------------------
    pools = {}
    for key, prop, name, members in [
        ("kh_tm", "TM", "Keyholders – The View", ["pamela", "sl_view"]),
        ("hk_tm", "TM", "Housekeeping – The View", ["pamela"]),
        ("kh_tv", "TV", "Keyholders – The Villa", ["david", "samantha"]),
        ("hk_tv", "TV", "Housekeeping – The Villa", ["hk_villa"]),
    ]:
        pools[key] = uuid.uuid4()
        conn.execute(pool.insert().values(id=pools[key], property_id=props[prop], name=name))
        for m in members:
            conn.execute(pool_member.insert().values(pool_id=pools[key], person_id=people[m]))

    nova = uuid.uuid4()
    conn.execute(
        contractor.insert().values(
            id=nova,
            name="Nova Fire & Security",
            trade="Fire alarm and emergency lighting",
            email="jobs@nova.demo.invalid",
        )
    )
    north = uuid.uuid4()
    conn.execute(contractor.insert().values(id=north, name="North Group", trade="Fire doors"))

    locs = {}
    for prop, items in {
        "TM": [
            ("Fire panel", "panel"),
            ("CP1 · Front entrance", "call_point"),
            ("CP2 · Ground floor corridor", "call_point"),
            ("CP3 · Ground floor rear", "call_point"),
            ("CP4 · First floor landing", "call_point"),
            ("CP5 · Second floor landing", "call_point"),
            ("Room 4 hot tap", "outlet"),
            ("Sauna", "sauna"),
        ],
        "TV": [
            ("Fire panel", "panel"),
            ("CP1 · Main entrance", "call_point"),
            ("CP2 · North stair", "call_point"),
            ("CP3 · Ground floor rear", "call_point"),
            ("Fire door 104 · first floor", "fire_door"),
            ("Fire door 106 · first floor", "fire_door"),
            ("Room 7", "room"),
            ("Hot tub", "hot_tub"),
            ("Sauna", "sauna"),
            ("Plant room", "plant"),
        ],
    }.items():
        for i, (name, typ) in enumerate(items):
            lid = uuid.uuid4()
            locs[(prop, name)] = lid
            conn.execute(location.insert().values(id=lid, property_id=props[prop], name=name, type=typ, sort=i))

    # --- Register: The View (TM-0xx) and The Villa (TV-1xx) -----------------------------------------------------
    tpls = {
        r.name: (r.id, r.kind, r[3])
        for r in conn.execute(
            select(template.c.name, template.c.id, template.c.kind, template.c["class"]).where(
                template.c.source_status == "CONFIRMED"
            )
        )
    }
    master_names = [row[1] for row in lib.MASTER]
    # The View's numbers follow the master list, stepping round the Actions numbered 030 and 040–044.
    tm_numbers = list(range(1, 30)) + list(range(31, 37))
    items: dict[str, uuid.UUID] = {}

    def done_by(prop: str, hint: str):
        h = hint.lower()
        if "keyholder" in h:
            return ("pool", None, pools[f"kh_{prop.lower()}"], None)
        if "housekeeping" in h:
            return ("pool", None, pools[f"hk_{prop.lower()}"], None)
        if "nova" in h:
            return ("contractor", None, None, nova)
        if "samantha" in h:
            return ("person", people["samantha"], None, None)
        if "rowell" in h:
            return ("person", people["rowell"], None, None)
        if "lynne" in h:
            return ("person", people["lynne"], None, None)
        if "david" in h:
            return ("person", people["david"], None, None)
        if "site lead" in h:
            return ("person", people["sl_view" if prop == "TM" else "sl_villa"], None, None)
        if "assessor" in h:
            return ("person", people["sandy"], None, None)
        return (None, None, None, None)  # a contractor still to be chosen

    def add_item(
        prop,
        ref,
        name,
        *,
        accountable,
        cover=None,
        state="on",
        state_reason=None,
        created=None,
        last_done=None,
        anchor=None,
        doer=None,
        needs_owner=False,
    ):
        tid, kind, klass = tpls[name]
        hint = next(r[5] for r in lib.MASTER if r[1] == name)
        k, p, pl, c = doer if doer is not None else done_by(prop, hint)
        iid = uuid.uuid4()
        items[ref] = iid
        conn.execute(
            register_item.insert().values(
                id=iid,
                ref=ref,
                property_id=props[prop],
                template_id=tid,
                done_by_kind=k,
                done_by_person_id=p,
                done_by_pool_id=pl,
                done_by_contractor_id=c,
                accountable_id=accountable,
                cover_id=cover,
                state=state,
                state_reason=state_reason,
                last_done_on=last_done,
                anchor_date=anchor,
                needs_owner=needs_owner,
                import_label="CONFIRMED",
                created_at=clock.at_london(created, time(8, 0)) if created else now,
            )
        )
        return iid

    view_open = D("2026-08-06")
    view_cert_done = {
        "Fire alarm service and certificate (BS 5839-1)": D("2026-08-06"),
        "Emergency lighting 3-hour test certificate (BS 5266-1)": D("2026-08-19"),
        "Extinguisher service certificate": D("2026-09-01"),
        "PAT of guest, kitchenette, laundry and wellness appliances": D("2026-08-20"),
        "EICR (BS 7671)": D("2026-07-30"),
    }
    off_view = {
        "Hot tub chemical readings logged (HSG282)": "No hot tub here",
        "Microbiological sample / Legionella sample": "No hot tub here",
        "Premises licence if alcohol is sold": "No alcohol sold (to confirm)",
        "STL licence conditions and renewals": "Class 7 hotel, outside STL licensing",
        "CCTV policy, signage and retention (UK GDPR)": "No CCTV fitted (to confirm)",
        "Gas Safe CP12 and boiler service (OFTEC service where oil-fired)": None,
    }
    monday = clock.monday_of(today)
    for n, name in zip(tm_numbers, master_names, strict=True):
        ref = f"TM-{n:03d}"
        reason = off_view.get(name)
        created = monday if "Sauna" in name else view_open
        add_item(
            "TM",
            ref,
            name,
            accountable=people["lynne"] if tpls[name][1] == "certificate" else people["sl_view"],
            cover=people["samantha"],
            state="off" if reason else "on",
            state_reason=reason,
            created=created,
            last_done=view_cert_done.get(name),
        )
    conn.execute(update(property_).where(property_.c.id == props["TM"]).values(next_number=44))

    villa_open = D("2026-10-21")
    tbc = {
        "Escape routes, final exits and assembly point clear",
        "Fire door walk-check (closing, seals, no wedges)",
        "Hot tub chemical readings logged (HSG282)",
    }
    off_villa = {
        "Premises licence if alcohol is sold": "No alcohol sold (to confirm)",
        "STL licence conditions and renewals": "Class 7 hotel, outside STL licensing",
    }
    for i, name in enumerate(master_names, start=1):
        ref = f"TV-{100 + i}"
        accountable = (
            None
            if name in tbc
            else (
                people["lynne"]
                if tpls[name][1] == "certificate"
                else people["rowell"]
                if "Salto" in name
                else people["samantha"]
            )
        )
        doer = (None, None, None, None) if "Hot tub chemical" in name else None
        reason = off_villa.get(name)
        add_item(
            "TV",
            ref,
            name,
            accountable=accountable,
            cover=people["david"],
            created=villa_open,
            state="off" if reason else "on",
            state_reason=reason,
            doer=doer,
            needs_owner=name in tbc,
        )
    conn.execute(update(property_).where(property_.c.id == props["TV"]).values(next_number=136))
    for code, n in (("AR", 45), ("TH", 46), ("EH", 1), ("BS", 1)):
        conn.execute(update(property_).where(property_.c.id == props[code]).values(next_number=n))

    # --- Certificates on file -----------------------------------------------------------------------------------
    def filed_cert(prop, ref, typ, title, issued, expires, issuer, provider=None, fails=0, why=None):
        pdf = placeholder_pdf(title, f"[Certificate: {title}, {issuer}, issued {issued:%-d %b %Y}]")
        ev = store_bytes(
            conn,
            data=pdf,
            content_type="application/pdf",
            file_name=file_name(title, issuer, issued, "pdf"),
            uploader=people["lynne"],
            property_id=props[prop],
        )
        cid = uuid.uuid4()
        conn.execute(
            certificate.insert().values(
                id=cid,
                property_id=props[prop],
                register_item_id=items.get(ref),
                type=typ,
                title=title,
                issuer=issuer,
                provider_text=provider or issuer,
                issued_on=issued,
                expires_on=expires,
                evidence_id=ev,
                filing="filed",
                fail_count=fails,
                why_needed=why,
                contractor_id=nova if "Nova" in issuer else None,
            )
        )
        return cid

    filed_cert(
        "TM",
        "TM-008",
        "fire_alarm_service",
        "Fire alarm service",
        D("2026-08-06"),
        D("2027-02-06"),
        "Nova Fire & Security",
        why="BS 5839-1 · life safety",
    )
    filed_cert(
        "TM",
        "TM-011",
        "el",
        "Emergency lighting 3-hour test",
        D("2026-08-19"),
        D("2027-08-19"),
        "Electrician",
        why="BS 5266-1 · life safety",
    )
    filed_cert(
        "TM",
        "TM-012",
        "extinguisher",
        "Extinguisher service",
        D("2026-09-01"),
        D("2027-09-01"),
        "BAFE contractor",
        why="BS 5306-3",
    )
    pat = filed_cert(
        "TM",
        "TM-016",
        "pat",
        "PAT",
        D("2026-08-20"),
        D("2027-08-20"),
        "Contractor",
        fails=1,
        why="IET Code of Practice",
    )
    filed_cert("TM", "TM-017", "eicr", "EICR", D("2026-07-30"), D("2031-07-30"), "Electrician", why="BS 7671")
    filed_cert(
        "TV",
        None,
        "fire_door",
        "Certifire CF535 (FD60) fire door certificate",
        D("2025-12-16"),
        D("2026-12-16"),
        "North Group",
        why="BS 8214 · life safety",
    )

    # --- Actions & Advisories (BH-CMP-001 / BH-CMP-002 log, 24 Oct 2026) ----------------------------------------
    prio = {"Urgent": "high", "Soon": "med", "Later": "low"}
    typ = {"Action": "action", "Work required": "work_required", "Advisory": "advisory"}
    owner_map = {
        "David": people["david"],
        "Lynne": people["lynne"],
        "Samantha": people["samantha"],
        "Sandy Riach": people["sandy"],
        "TDA director": people["tda"],
        "Site lead": people["sl_view"],
    }

    def src(source_ref: str) -> str:
        s = source_ref.lower()
        if "gallagher" in s:
            return "insurer"
        if "sandy" in s:
            return "assessor"
        if "folder review" in s:
            return "folder_review"
        if "snag" in s or "north group" in s or "nova" in s:
            return "snag"
        return "manual"

    def year(s: str) -> date:
        parts = s.split()
        return datetime.strptime(s if len(parts) == 3 else f"{s} 2026", "%d %b %Y").date()

    actions_rows = [
        (
            "TV-022",
            "TV",
            "Action",
            "A05",
            "TV-EML-11 #2 (Gallagher)",
            "Insurance condition NBS542: send Nova L1 certificate and ARC confirmation to Allan Rainey; get written confirmation. Policy cancelled if not met within 45 days",
            "Urgent",
            "David",
            "22 Oct",
            "9 Nov",
            "Open",
        ),
        (
            "TV-023",
            "TV",
            "Advisory",
            "B04",
            "TV-EML-11 #1 (Nova/ARC)",
            "ARC set on 22 Oct to call keyholders before the fire service. Decide deliberately, record decision and reason in FRA; ask Sandy’s view",
            "Urgent",
            "David + TDA directors",
            "22 Oct",
            "31 Oct",
            "Open",
        ),
        (
            "TV-001",
            "TV",
            "Action",
            "B02",
            "TV-ACT-07 A1",
            "Sign the FRA (TV-FRA-01) after a site walk: complete assembly point, ARC, keyholders, panel, extinguisher schedule",
            "Urgent",
            "TDA director",
            "22 Oct",
            "31 Oct",
            "Open",
        ),
        (
            "TV-002",
            "TV",
            "Action",
            "B04",
            "TV-ACT-07 A2",
            "Instruct Nova in writing on the call sequence (999 first at night recommended); test the signal end to end",
            "Urgent",
            "David",
            "22 Oct",
            "31 Oct",
            "Open",
        ),
        (
            "TV-006",
            "TV",
            "Work required",
            "C02",
            "TV-ACT-07 A6",
            "Nova: bedhead sound test every bedroom with written readings; commissioning certificate and set-up chart",
            "Urgent",
            "Nova",
            "22 Oct",
            "31 Oct",
            "Open",
        ),
        (
            "TV-009",
            "TV",
            "Action",
            "H01",
            "TV-ACT-07 A9",
            "Start the weekly alarm test and log it at the panel",
            "Urgent",
            "Keyholder",
            "22 Oct",
            "31 Oct",
            "Open",
        ),
        (
            "TV-024",
            "TV",
            "Action",
            "C01",
            "TV-EML-11 #3 (Nova)",
            "Three false alarms in a week: log each (date, zone, cause); get cause from Nova; fix north-stair call point with no test-key slot",
            "Urgent",
            "Lynne / Nova",
            "22 Oct",
            "31 Oct",
            "Open",
        ),
        (
            "TV-026",
            "TV",
            "Advisory",
            "C13",
            "TV-EML-11 #6 (Sandy Riach)",
            "Accessible toilet pull cord must alert someone off site at an unmanned property. Confirm done",
            "Urgent",
            "Rowell / Nova",
            "22 Oct",
            "31 Oct",
            "Open",
        ),
        (
            "TM-030",
            "TM",
            "Work required",
            "C10",
            "Marine snag list A1",
            "Verify top-of-stair 1-hr division board; Envirograf if plasterboard; confirm to Colin",
            "Urgent",
            "Gavin / David",
            "26 Aug",
            "31 Oct",
            "To confirm",
        ),
        (
            "TM-040",
            "TM",
            "Action",
            "H03",
            "Folder review 24 Oct",
            "No folder 07 and no signed weekly/monthly logs filed since opening in Aug. Create 07, back-file paper logs, start monthly scanning",
            "Urgent",
            "Site lead / Lynne",
            "24 Oct",
            "31 Oct",
            "Open",
        ),
        (
            "TM-041",
            "TM",
            "Action",
            "D02",
            "Folder review 24 Oct",
            "PAT 20 Aug includes a fail report: confirm each failed item removed or repaired and record it",
            "Urgent",
            "Site lead",
            "24 Oct",
            "31 Oct",
            "Open",
        ),
        (
            "AR-044",
            "AR",
            "Action",
            "B02",
            "Folder review 24 Oct",
            "No compliance pack found. Confirm dutyholder during interim trading and where fire records are; build pack from the BH-FS template",
            "Urgent",
            "David / Samantha",
            "24 Oct",
            "31 Oct",
            "Open",
        ),
        (
            "TV-011",
            "TV",
            "Action",
            "B03",
            "TV-ACT-07 B1",
            "Competent assessor countersigns the FRA",
            "Soon",
            "Sandy Riach",
            "22 Oct",
            "21 Nov",
            "Open",
        ),
        (
            "TV-012",
            "TV",
            "Work required",
            "C07",
            "TV-ACT-07 B2",
            "Emergency lighting 3-hour test certificate on file",
            "Soon",
            "Lynne to book",
            "22 Oct",
            "21 Nov",
            "Open",
        ),
        (
            "TV-013",
            "TV",
            "Work required",
            "D01",
            "TV-ACT-07 B3",
            "EICR, PAT, Gas Safe CP12 and legionella risk assessment on file",
            "Soon",
            "Lynne to book",
            "22 Oct",
            "21 Nov",
            "Open",
        ),
        (
            "TV-018",
            "TV",
            "Action",
            "E01",
            "TV-ACT-07 B8",
            "Furniture fire certificates (Elite) for every item on file",
            "Soon",
            "Lynne",
            "22 Oct",
            "21 Nov",
            "Open",
        ),
        (
            "TV-028",
            "TV",
            "Advisory",
            "C09",
            "TV-EML-11 #8 (North Group)",
            "Certifire CF535 (FD60) copy on file expires 16 Dec 2026: file current version; get per-door install records and labels",
            "Soon",
            "Lynne",
            "22 Oct",
            "21 Nov",
            "Open",
        ),
        (
            "TM-042",
            "TM",
            "Action",
            "D05",
            "Folder review 24 Oct",
            "No legionella risk assessment found: commission or file existing",
            "Soon",
            "Lynne",
            "24 Oct",
            "21 Nov",
            "Open",
        ),
        (
            "TM-043",
            "TM",
            "Action",
            "B03",
            "Folder review 24 Oct",
            "No assessor sign-off of the FRA found: ask Sandy to countersign",
            "Soon",
            "Sandy Riach",
            "24 Oct",
            "21 Nov",
            "Open",
        ),
        (
            "TV-021",
            "TV",
            "Action",
            "B06",
            "TV-ACT-07 B11",
            "Invite SFRS Montrose for a familiarisation visit",
            "Later",
            "Lynne",
            "22 Oct",
            "20 Jan 2027",
            "Open",
        ),
        (
            "TH-045",
            "TH",
            "Action",
            "H02",
            "BH-CMP-001",
            "Run this gate through the register from Jan 2027; book witnessed alarm test 7 days ahead of completion",
            "Later",
            "Samantha",
            "24 Oct",
            "31 Jan 2027",
            "Open",
        ),
    ]
    action_ids = {}
    for ref, prop, t, gref, sref, desc, p, owner, raised, due, status in actions_rows:
        aid = uuid.uuid4()
        action_ids[ref] = aid
        oid = owner_map.get(owner)
        conn.execute(
            action.insert().values(
                id=aid,
                ref=ref,
                property_id=props[prop],
                type=typ[t],
                source=src(sref),
                source_ref=sref,
                gate_ref=gref,
                description=desc,
                priority=prio[p],
                owner_id=oid,
                owner_text=None if oid else owner,
                owner_contractor_id=nova if owner == "Nova" else None,
                raised_on=year(raised),
                due_on=year(due),
                status="to_confirm" if status == "To confirm" else "open",
                register_item_id=items.get("TM-016") if ref == "TM-041" else None,
                certificate_id=pat if ref == "TM-041" else None,
            )
        )
    conn.execute(update(certificate).where(certificate.c.id == pat).values(linked_action_id=action_ids["TM-041"]))

    # Required certificates that aren't on file yet (Certificates › Missing).
    for prop, title, why, provider, ref, filing, due in [
        (
            "TV",
            "Monitored alarm evidence (Nova L1 + ARC)",
            "Insurer condition NBS542",
            "Nova / David",
            "TV-022",
            "required",
            D("2026-11-09"),
        ),
        (
            "TV",
            "Emergency lighting 3-hour certificate",
            "BS 5266-1 · life safety",
            "Electrician",
            "TV-012",
            "required",
            None,
        ),
        (
            "TV",
            "Gas Safe CP12 and boiler certificate",
            "Gas Safety Regs 1998 · life safety",
            "Heating engineer",
            "TV-013",
            "required",
            None,
        ),
        ("TV", "EICR or EIC", "BS 7671", "Electrician", "TV-013", "required", None),
        ("TM", "Legionella risk assessment", "HSE L8", "Assessor", "TM-042", "required", None),
        ("TM", "Assessor sign-off of the FRA", "Fire (Scotland) Act 2005", "Sandy Riach", "TM-043", "required", None),
        ("TV", "Furniture fire certificates (Elite)", "Furniture Regs 1988", "Procurement", "TV-018", "partial", None),
    ]:
        conn.execute(
            certificate.insert().values(
                id=uuid.uuid4(),
                property_id=props[prop],
                type="other",
                title=title,
                why_needed=why,
                provider_text=provider,
                filing=filing,
                linked_action_id=action_ids[ref],
                expires_on=due,
            )
        )

    # --- Opening gates --------------------------------------------------------------------------------------------
    tmpl = [dict(r) for r in conn.execute(select(gate_template_item).order_by(gate_template_item.c.sort)).mappings()]
    villa_c = {
        "C01": ("in_progress", "Nova L1 upgrade late Sep 2026. Commissioning certificate not yet seen."),
        "C02": ("not_started", "No dB reading sheet exists (Nova, 22 Oct)."),
        "C03": ("in_progress", "Zone chart framed on site. TV-ZON-09 to complete."),
        "C04": ("in_progress", "Keyholders David and Samantha added 22 Oct. End-to-end test to log."),
        "C05": ("to_confirm", None),
        "C06": ("to_confirm", None),
        "C07": ("to_confirm", None),
        "C08": ("to_confirm", None),
        "C09": ("in_progress", "Sandy: doors need adjusting, no ID marks. Per-door records outstanding."),
        "C10": ("not_started", "Plant room compartmentation incomplete per Sandy, 17 Oct."),
        "C11": ("to_confirm", None),
        "C12": ("in_progress", "TV-REV-10: Cockerill = 008, Room 001 sheet missing."),
        "C13": ("to_confirm", "Sandy asked in July for a remote alarm. Status unknown."),
        "A01": ("done", "Completion certificate 2400948 accepted."),
        "A05": ("in_progress", "Gallagher condition NBS542 due 9 Nov (TV-022)."),
        "B02": ("in_progress", "FRA drafted 22 Oct; awaiting TDA signature (TV-001)."),
        "B03": ("not_started", None),
        "B04": ("in_progress", "ARC calls keyholders before 999 (TV-023)."),
        "B06": ("not_started", None),
        "D01": ("not_started", None),
        "E01": ("in_progress", "Partly filed."),
        "G04": ("not_started", "Assembly point sign not yet fitted."),
        "H01": ("not_started", None),
        "H02": ("in_progress", "Register loaded 21 Oct; 3 items still need a name."),
        "H08": ("not_started", None),
    }
    view_done = {"A01", "A06", "A07", "C01", "C07", "C11"}

    def make_gate(code, target, statuses, na, default_status):
        gid = uuid.uuid4()
        conn.execute(gate.insert().values(id=gid, property_id=props[code], target_opening=target))
        for it in tmpl:
            ref = it["ref"]
            st, note = statuses.get(ref, (default_status, None))
            applies = ref not in na
            conn.execute(
                gate_item.insert().values(
                    id=uuid.uuid4(),
                    gate_id=gid,
                    ref=ref,
                    section=it["section"],
                    item=it["item"],
                    **{"class": it["class"]},
                    legal_basis=it["legal_basis"],
                    evidence_required=it["evidence_required"],
                    applies=applies,
                    na_reason=na.get(ref),
                    status="na" if not applies else st,
                    owner_text=it["typical_owner"],
                    notes=note,
                    sort=it["sort"],
                    evidence_link="05 Certificates & Evidence/" + ref if st == "done" else None,
                )
            )
        return gid

    make_gate("TV", None, villa_c, {}, "to_confirm")
    make_gate(
        "TM",
        None,
        {r: ("done", None) for r in view_done},
        {"A08": "No food prepared or served (to confirm)", "H07": "No CCTV fitted (to confirm)"},
        "to_confirm",
    )
    make_gate("TH", D("2027-04-01"), {}, {"A08": "No food prepared or served (to confirm)"}, "not_started")
    make_gate("AR", None, {}, {}, "not_started")

    # --- Sign-offs waiting for the TDA director -----------------------------------------------------------------
    fra_pdf = placeholder_pdf(
        "The Villa Fire Risk Assessment & Fire Plan, TV-FRA-01",
        "[Document preview: The Villa Fire Risk Assessment &amp; Fire Plan, version 22 Oct 2026]",
    )
    fra_ev = store_bytes(
        conn,
        data=fra_pdf,
        content_type="application/pdf",
        file_name="TV-FRA-01 - bide - 2026-10-22.pdf",
        uploader=people["samantha"],
        property_id=props["TV"],
    )
    conn.execute(
        signature_request.insert().values(
            id=uuid.uuid4(),
            type="fra",
            property_id=props["TV"],
            title="Sign the Fire Risk Assessment & Fire Plan (TV-FRA-01)",
            subject="TV-FRA-01 · version 22 Oct 2026",
            evidence_id=fra_ev,
            action_id=action_ids["TV-001"],
            gate_ref="B02",
            register_item_id=items["TV-113"],
            due_on=D("2026-10-31"),
            preconditions=[
                {
                    "text": "Assembly point, ARC, keyholders, panel and extinguisher schedule must be completed in the document (TV-001).",
                    "done": False,
                },
                {
                    "text": "Competent assessor countersignature follows separately (TV-011, Sandy Riach).",
                    "done": False,
                },
            ],
        )
    )
    conn.execute(
        signature_request.insert().values(
            id=uuid.uuid4(),
            type="gate",
            property_id=props["TV"],
            title="Opening checklist sign-off (H08)",
            gate_ref="H08",
            status="open",
        )
    )
    conn.execute(
        signature_request.insert().values(
            id=uuid.uuid4(),
            type="quarterly",
            property_id=props["TV"],
            title="Quarterly register sign-off · Q1 2027",
            subject="Q1 2027",
            opens_on=D("2027-01-04"),
            due_on=D("2027-01-15"),
            status="scheduled",
        )
    )

    # --- Tasks for the live registers ---------------------------------------------------------------------------
    for iid in items.values():
        refresh_item(conn, iid)

    # --- Submissions: history, the review queue and today's failed alarm test -----------------------------------
    def task_for(ref: str, on: date) -> dict:
        row = (
            conn.execute(
                select(task)
                .where(task.c.register_item_id == items[ref], task.c.window_opens_at <= clock.end_of_day(on))
                .order_by(task.c.due_at.desc())
                .limit(1)
            )
            .mappings()
            .first()
        )
        if row and clock.london(row["due_at"]).date() >= on - timedelta(days=6):
            return dict(row)
        # Before the register went live: an extra task for the paper-era record.
        tid = uuid.uuid4()
        tv = conn.execute(
            select(template_version.c.id)
            .join(template, template.c.id == template_version.c.template_id)
            .join(register_item, register_item.c.template_id == template.c.id)
            .where(register_item.c.id == items[ref])
        ).scalar()
        conn.execute(
            task.insert().values(
                id=tid,
                register_item_id=items[ref],
                template_version_id=tv,
                period_key=f"demo-{on.isoformat()}",
                due_at=clock.end_of_day(on),
                window_opens_at=clock.start_of_day(on),
                status="open",
            )
        )
        return dict(conn.execute(select(task).where(task.c.id == tid)).mappings().one())

    def seed_sub(
        ref,
        who,
        on: date,
        at: time,
        values,
        photos: dict[str, list[str]],
        *,
        result="passed",
        status=None,
        flags=(),
        offline=False,
        inside=True,
        prop="TM",
        failed=(),
    ):
        t = task_for(ref, on)
        when = clock.at_london(on, at)
        sid = uuid.uuid4()
        tname = conn.execute(
            select(template.c.name)
            .join(register_item, register_item.c.template_id == template.c.id)
            .where(register_item.c.id == items[ref])
        ).scalar()
        pname = conn.execute(select(person.c.name).where(person.c.id == people[who])).scalar()
        conn.execute(
            submission.insert().values(
                id=sid,
                task_id=t["id"],
                submitter_id=people[who],
                work_done_on=on,
                server_time=when,
                device_time=when - timedelta(seconds=3),
                captured_offline=offline,
                inside_geofence=inside,
                lat=None,
                lng=None,
                values=values,
                result=result,
                failed_fields=list(failed),
                flags=list(flags),
                file_name=file_name(tname, pname, on),
                locked=True,
            )
        )
        for key, labels in photos.items():
            for i, label in enumerate(labels):
                ev = store_bytes(
                    conn,
                    data=placeholder_image(label),
                    content_type="image/jpeg",
                    file_name=file_name(f"{ref} {key}", pname, on, "jpg"),
                    uploader=people[who],
                    property_id=props[prop],
                    captured_with="camera",
                )
                conn.execute(update(evidence).where(evidence.c.id == ev).values(captured_at=when, kind="photo"))
                conn.execute(
                    submission_evidence.insert().values(submission_id=sid, evidence_id=ev, field_key=key, sort=i)
                )
        st = status or ("failed" if result == "failed" else "passed")
        conn.execute(
            update(task)
            .where(task.c.id == t["id"])
            .values(status=st, completed_by=people[who], completed_at=when, needs_verification=st == "submitted")
        )
        return sid, t["id"]

    d = today
    seed_sub(
        "TM-001",
        "pamela",
        d,
        time(8, 20),
        {"routes_clear": "yes", "exits_open": "yes", "assembly_clear": "yes"},
        {"route_photo": ["[Photo: main escape route, ground floor, clear]"]},
    )
    s, _ = seed_sub(
        "TM-026",
        "pamela",
        d - timedelta(days=5),
        time(11, 5),
        {"heater_clear": "yes", "guard": "yes", "timer": "pass", "sign": "yes"},
        {"sauna_photo": ["[Photo: sauna heater and guard]"]},
    )
    conn.execute(
        verification.insert().values(
            id=uuid.uuid4(), submission_id=s, verifier_id=people["samantha"], type="planned", result="approved"
        )
    )
    conn.execute(update(task).where(task.c.id == _).values(status="verified"))
    seed_sub(
        "TM-021",
        "pamela",
        d - timedelta(days=6),
        time(15, 30),
        {"flushed": "yes", "rooms": "Rooms 2, 5 and 8"},
        {"tap_photo": ["[Photo: running outlet, room 5]"]},
        flags=["captured_offline"],
        offline=True,
    )
    s, t_el = seed_sub(
        "TM-004",
        "pamela",
        d - timedelta(days=9),
        time(10, 15),
        {"all_lit": "pass", "restored": "yes"},
        {"light_photo": ["[Photo: emergency light lit during test]"]},
    )
    conn.execute(
        verification.insert().values(
            id=uuid.uuid4(), submission_id=s, verifier_id=people["samantha"], type="planned", result="approved"
        )
    )
    conn.execute(update(task).where(task.c.id == t_el).values(status="verified"))
    s, t_door = seed_sub(
        "TM-003",
        "pamela",
        d - timedelta(days=1),
        time(14, 0),
        {"closing": "yes", "seals": "yes", "no_wedges": "yes"},
        {"door_photo": ["[Photo: fire door 106 closing, blurred]"]},
    )
    conn.execute(
        verification.insert().values(
            id=uuid.uuid4(),
            submission_id=s,
            verifier_id=people["samantha"],
            type="planned",
            result="rejected",
            comment="Door 106 photo is blurred. Please retake it.",
        )
    )
    conn.execute(update(task).where(task.c.id == t_door).values(status="open", completed_by=None, completed_at=None))

    # Review queue
    seed_sub(
        "TM-020",
        "sl_view",
        d,
        time(8, 55),
        {"outlet": "Room 4 hot tap", "hot": 46.5, "cold": 14.0},
        {"thermo_photo": ["[Photo: thermometer reading 46.5 °C at room 4 hot tap]"]},
        result="failed",
        failed=[{"key": "hot", "label": "Hot water at outlet after 1 minute", "value": 46.5, "why": "below 50°C"}],
    )
    seed_sub(
        "TV-102",
        "kh_villa",
        D("2026-10-24"),
        time(10, 30),
        {"call_point": "CP1 · Main entrance", "panel_normal": "yes", "arc_confirmed": "yes", "sounders": "pass"},
        {
            "panel_photo": ["[Photo: Villa fire panel showing normal]"],
            "logbook_photo": ["[Photo: Villa log book entry]"],
        },
        status="submitted",
        flags=["captured_offline"],
        offline=True,
        prop="TV",
    )
    seed_sub(
        "TV-103",
        "hk_villa",
        D("2026-10-23"),
        time(16, 10),
        {"closing": "yes", "seals": "yes", "no_wedges": "yes"},
        {"door_photo": ["[Photo: fire door 104 closing]"]},
        status="submitted",
        flags=["outside_geofence"],
        inside=False,
        prop="TV",
    )

    # Pamela's weekly alarm test this morning, through the real submission flow: the ARC didn't get the signal.
    pam = dict(conn.execute(select(person).where(person.c.id == people["pamela"])).mappings().one())
    pr = load_principal(conn, pam)
    actor = audit.Actor(pr.person_id, pr.name, None, "Staff app · trusted iPhone")
    t = (
        conn.execute(
            select(task)
            .where(task.c.register_item_id == items["TM-002"], task.c.status.in_(("open", "overdue")))
            .order_by(task.c.due_at.desc())
            .limit(1)
        )
        .mappings()
        .first()
    )
    if t:
        ev_ids = {}
        for key, label in [
            ("panel_photo", "[Photo 1: fire panel after reset, showing normal]"),
            ("logbook_photo", "[Photo 2: log book entry, signed]"),
        ]:
            ev = store_bytes(
                conn,
                data=placeholder_image(label),
                content_type="image/jpeg",
                file_name=label,
                uploader=people["pamela"],
                property_id=props["TM"],
                captured_with="camera",
            )
            conn.execute(update(evidence).where(evidence.c.id == ev).values(kind="photo", captured_with="camera"))
            ev_ids[key] = [ev]
        checks.submit(
            conn,
            pr,
            actor,
            t["id"],
            values={
                "call_point": "CP3 · Ground floor rear",
                "panel_normal": "yes",
                "arc_confirmed": "no",
                "sounders": "pass",
            },
            photos=ev_ids,
            work_done_on=today,
            device_time=now - timedelta(seconds=3),
            captured_offline=False,
            lat=58.5937,
            lng=-3.5220,
            accuracy=12,
            notes=None,
            signature=None,
        )
    # The failed water temperature reading from earlier this morning gets its Action next (TM-045).
    from bide_comply.services.actions import raise_action

    temps_task = conn.execute(
        select(task.c.id).where(task.c.register_item_id == items["TM-020"], task.c.status == "failed")
    ).scalar()
    raise_action(
        conn,
        audit.Actor(people["sl_view"], "[Site lead, The View]"),
        property_id=props["TM"],
        description="Hot and cold outlet temperatures logged: Hot water at outlet after 1 minute: below 50°C (46.5 °C, room 4)",
        source="out_of_range",
        source_ref="Check TM-020",
        klass="B",
        register_item_id=items["TM-020"],
        task_id=temps_task,
    )

    # --- Approvals waiting --------------------------------------------------------------------------------------
    conn.execute(
        approval_request.insert().values(
            id=uuid.uuid4(),
            kind="switch_off",
            property_id=props["TV"],
            register_item_id=items["TV-135"],
            requested_by=people["rowell"],
            reason="No CCTV fitted at The Villa.",
            created_at=now - timedelta(days=2),
        )
    )
    sept_temps = conn.execute(
        select(task.c.id).where(task.c.register_item_id == items["TM-020"]).order_by(task.c.due_at).limit(1)
    ).scalar()
    conn.execute(
        approval_request.insert().values(
            id=uuid.uuid4(),
            kind="missed",
            property_id=props["TM"],
            register_item_id=items["TM-020"],
            task_id=sept_temps,
            requested_by=people["sl_view"],
            reason="Thermometer broken, new one arrives Tue",
        )
    )
    cover_id = uuid.uuid4()
    conn.execute(
        approval_request.insert().values(
            id=cover_id,
            kind="cover",
            property_id=props["TV"],
            requested_by=None,
            source="holiday_tracker",
            reason="On leave",
            payload={
                "person_id": str(people["kh_villa"]),
                "cover_id": str(people["david"]),
                "starts_on": "2026-11-02",
                "ends_on": "2026-11-06",
                "what": "keyholder checks",
            },
        )
    )
    conn.execute(
        leave.insert().values(
            id=uuid.uuid4(),
            person_id=people["kh_villa"],
            starts_on=D("2026-11-02"),
            ends_on=D("2026-11-06"),
            source="holiday_tracker",
            cover_id=people["david"],
            approval_id=cover_id,
        )
    )

    # --- Staff requirements -------------------------------------------------------------------------------------
    req = {r.key: r.id for r in conn.execute(select(staff_requirement_type.c.key, staff_requirement_type.c.id))}

    def need(who, key, status, detail=None, expires=None, prop=None):
        conn.execute(
            staff_requirement.insert().values(
                id=uuid.uuid4(),
                person_id=people[who],
                type_id=req[key],
                status=status,
                detail=detail,
                expires_on=expires,
                property_id=props[prop] if prop else None,
            )
        )

    need("pamela", "fire_suite", "done", "High Speed Training · Feb–Jun 2026", D("2027-06-30"))
    need("pamela", "manual_signed", "done", "The View")
    need("pamela", "right_to_work", "done", "Checked by Lynne · copy held securely")
    need("pamela", "keyholder_drill", "done", "Next one due in the spring")
    need("kh_villa", "fire_suite", "missing")
    need("kh_villa", "manual_signed", "done")
    need("kh_villa", "keyholder_drill", "missing")
    need("hk_villa", "fire_suite", "done", "High Speed Training · Oct 2026", D("2027-10-15"))
    need("hk_villa", "manual_signed", "missing")
    need("sl_view", "fire_suite", "done", None, D("2027-05-01"))
    need("sl_view", "manual_signed", "done")
    need("sl_view", "first_aid", "done", None, today + timedelta(days=41))

    # --- Alarm events: three false alarms in a week at The Villa (TV-024) ---------------------------------------
    for day, zone in [
        ("2026-10-19", "Zone 3 · North stair"),
        ("2026-10-20", "Zone 2 · First floor"),
        ("2026-10-21", "Zone 3 · North stair"),
    ]:
        conn.execute(
            alarm_event.insert().values(
                id=uuid.uuid4(),
                property_id=props["TV"],
                occurred_at=clock.at_london(D(day), time(7, 40)),
                zone=zone,
                cause="Unknown",
                false_alarm=True,
                arc_response="Keyholders called",
                keyholder_attended_minutes=None,
                logged_by=people["samantha"],
                action_id=action_ids["TV-024"],
            )
        )

    # --- Contractor visits --------------------------------------------------------------------------------------
    conn.execute(
        contractor_visit.insert().values(
            id=uuid.uuid4(),
            contractor_id=nova,
            property_id=props["TV"],
            visit_on=D("2026-10-27"),
            purpose="Bedhead sound test (TV-006)",
        )
    )
    conn.execute(
        contractor_visit.insert().values(
            id=uuid.uuid4(),
            contractor_id=nova,
            property_id=props["TM"],
            visit_on=D("2026-11-12"),
            purpose="Emergency lighting test",
        )
    )

    # --- Assessor's quarterly walk at The Villa, in progress -----------------------------------------------------
    wid = uuid.uuid4()
    conn.execute(
        audit_walk.insert().values(id=wid, property_id=props["TV"], assessor_id=people["sandy"], quarter="2026-Q4")
    )
    for ref, verdict, finding, p in [
        ("TV-102", "matches", None, None),
        ("TV-103", "doesnt", "Doors 104 and 106 do not latch from 45°. Closers need adjusting.", "high"),
        ("TV-101", "matches", None, None),
    ]:
        conn.execute(
            audit_walk_line.insert().values(
                id=uuid.uuid4(), walk_id=wid, register_item_id=items[ref], verdict=verdict, finding=finding, priority=p
            )
        )

    for iid in items.values():
        recompute_item(conn, iid)
    audit.record(
        conn,
        audit.SYSTEM,
        category="record",
        action="import.register",
        summary="Imported from BH-CMP-001 register (day one load)",
        entity_type="property",
    )
    print(f"Demo data loaded: {len(items)} register items, {len(actions_rows)} Actions, 4 opening checklists.")
