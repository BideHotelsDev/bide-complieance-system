"""Inspection packs (DSH-07): a PDF summary plus a ZIP of the evidence for a property, period and categories.

Every page is stamped with the export time and a fingerprint (SHA-256 of the pack's content list), so a changed
copy can be detected. Built by the worker; the request returns as soon as the job is queued.
"""

import hashlib
import html
import io
import json
import uuid
import zipfile
from datetime import date

from sqlalchemy import Connection, func, select, update

from bide_comply import audit, clock
from bide_comply.schema import (
    action,
    alarm_event,
    audit_event,
    certificate,
    domain,
    dutyholder,
    evidence,
    person,
    property_,
    register_item,
    report_export,
    signoff,
    staff_requirement,
    staff_requirement_type,
    submission,
    submission_evidence,
    task,
    template,
)
from bide_comply.services.common import fmt_date
from bide_comply.storage import storage

SECTIONS = {
    "fire_checks": "Fire safety checks and log",
    "certificates": "Certificates on file",
    "actions": "Open Actions and Advisories",
    "alarm_events": "Alarm events and false alarms",
    "water": "Water and legionella records",
    "training": "Staff training records",
    "signoffs": "Signed FRA and sign-offs",
    "audit": "Audit trail (who did what, when)",
}
PRESETS = {
    "insurer": ["fire_checks", "certificates", "actions", "alarm_events", "signoffs"],
    "sfrs": ["fire_checks", "certificates", "actions", "alarm_events", "signoffs", "training"],
    "licensing": ["fire_checks", "certificates", "signoffs", "actions"],
    "dutyholder": list(SECTIONS),
    "assessor": ["fire_checks", "certificates", "actions", "alarm_events", "water", "signoffs"],
}
AUDIENCE = {
    "insurer": "Insurer (Gallagher)",
    "sfrs": "Scottish Fire and Rescue Service",
    "licensing": "Licensing Board",
    "dutyholder": "Dutyholder",
    "assessor": "Competent assessor",
}


def _subs(conn: Connection, pid: uuid.UUID, start: date, end: date, domain_keys: tuple[str, ...]) -> list[dict]:
    return [
        dict(r)
        for r in conn.execute(
            select(
                submission.c.id,
                submission.c.work_done_on,
                submission.c.result,
                submission.c.server_time,
                submission.c.file_name,
                register_item.c.ref,
                template.c.name,
                person.c.name.label("by"),
                task.c.status,
            )
            .join(task, task.c.id == submission.c.task_id)
            .join(register_item, register_item.c.id == task.c.register_item_id)
            .join(template, template.c.id == register_item.c.template_id)
            .join(domain, domain.c.id == template.c.domain_id)
            .join(person, person.c.id == submission.c.submitter_id)
            .where(
                register_item.c.property_id == pid,
                submission.c.work_done_on >= start,
                submission.c.work_done_on <= end,
                domain.c.key.in_(domain_keys),
            )
            .order_by(submission.c.work_done_on)
        ).mappings()
    ]


def estimate(conn: Connection, pid: uuid.UUID, start: date, end: date, sections: list[str]) -> dict:
    photos = 0
    subs = []
    if "fire_checks" in sections:
        subs += _subs(conn, pid, start, end, ("fire", "gas", "electrical"))
    if "water" in sections:
        subs += _subs(conn, pid, start, end, ("water", "hot_tub"))
    if subs:
        photos = conn.execute(
            select(func.count()).where(submission_evidence.c.submission_id.in_([s["id"] for s in subs]))
        ).scalar()
    certs = (
        conn.execute(
            select(certificate.c.id).where(
                certificate.c.property_id == pid, certificate.c.filing == "filed", certificate.c.evidence_id.isnot(None)
            )
        ).all()
        if "certificates" in sections
        else []
    )
    pages = 2 + len(sections) * 2 + len(subs) // 10
    return {"pages": pages, "photos": photos, "certificates": len(certs), "checks": len(subs)}


def build(conn: Connection, export_id: uuid.UUID) -> None:
    ex = conn.execute(select(report_export).where(report_export.c.id == export_id)).mappings().one()
    conn.execute(update(report_export).where(report_export.c.id == export_id).values(status="building"))
    params = ex["params"]
    pid = ex["property_id"]
    start, end = date.fromisoformat(params["from"]), date.fromisoformat(params["to"])
    sections = params["sections"]
    p = (
        conn.execute(
            select(property_, dutyholder.c.name.label("dh"))
            .outerjoin(dutyholder, dutyholder.c.id == property_.c.dutyholder_id)
            .where(property_.c.id == pid)
        )
        .mappings()
        .one()
    )
    files: list[tuple[str, bytes]] = []
    body: list[str] = []
    contents: list[str] = []

    def table(headers, rows):
        h = "".join(f"<th>{html.escape(x)}</th>" for x in headers)
        b = "".join(
            "<tr>" + "".join(f"<td>{html.escape(str(c) if c is not None else '—')}</td>" for c in r) + "</tr>"
            for r in rows
        )
        return f"<table><thead><tr>{h}</tr></thead><tbody>{b or '<tr><td colspan=9>Nothing in this period.</td></tr>'}</tbody></table>"

    def add_section(key, inner):
        body.append(f"<section><h2>{SECTIONS[key]}</h2>{inner}</section>")

    photo_count = 0
    for key in sections:
        if key in ("fire_checks", "water"):
            doms = ("fire", "gas", "electrical") if key == "fire_checks" else ("water", "hot_tub")
            subs = _subs(conn, pid, start, end, doms)
            rows = []
            for s in subs:
                evs = (
                    conn.execute(
                        select(evidence)
                        .join(submission_evidence, submission_evidence.c.evidence_id == evidence.c.id)
                        .where(submission_evidence.c.submission_id == s["id"])
                    )
                    .mappings()
                    .all()
                )
                for e in evs:
                    files.append((f"evidence/{s['ref']}/{e['file_name']}", storage.get(e["storage_key"])))
                    contents.append(f"{e['file_name']}:{e['sha256']}")
                    photo_count += 1
                rows.append(
                    [
                        fmt_date(s["work_done_on"], True),
                        s["ref"],
                        s["name"],
                        s["by"],
                        s["result"].capitalize(),
                        "Verified" if s["status"] == "verified" else "",
                        len(evs),
                    ]
                )
            add_section(key, table(["Date", "ID", "Check", "By", "Result", "Review", "Photos"], rows))
        elif key == "certificates":
            certs = (
                conn.execute(
                    select(certificate, evidence.c.storage_key, evidence.c.file_name, evidence.c.sha256)
                    .outerjoin(evidence, evidence.c.id == certificate.c.evidence_id)
                    .where(certificate.c.property_id == pid, certificate.c.superseded_by.is_(None))
                )
                .mappings()
                .all()
            )
            rows = []
            for c in certs:
                if c["storage_key"]:
                    files.append((f"certificates/{c['file_name']}", storage.get(c["storage_key"])))
                    contents.append(f"{c['file_name']}:{c['sha256']}")
                rows.append(
                    [
                        c["title"],
                        c["issuer"] or c["provider_text"],
                        fmt_date(c["issued_on"], True),
                        fmt_date(c["expires_on"], True),
                        "On file" if c["filing"] == "filed" else "Not on file yet",
                        f"{c['fail_count']} open" if c["fail_count"] else "",
                    ]
                )
            add_section(key, table(["Certificate", "Issuer", "Issued", "Expires", "Status", "Fails"], rows))
        elif key == "actions":
            acts = (
                conn.execute(
                    select(action)
                    .where(action.c.property_id == pid, action.c.status != "closed")
                    .order_by(action.c.priority, action.c.due_on)
                )
                .mappings()
                .all()
            )
            add_section(
                key,
                table(
                    ["ID", "Type", "Description", "Priority", "Due", "Status"],
                    [
                        [
                            a["ref"],
                            a["type"].replace("_", " ").capitalize(),
                            a["description"],
                            {"high": "Urgent", "med": "Soon", "low": "Later"}[a["priority"]],
                            fmt_date(a["due_on"], True),
                            a["status"].replace("_", " ").capitalize(),
                        ]
                        for a in acts
                    ],
                ),
            )
        elif key == "alarm_events":
            ev = (
                conn.execute(
                    select(alarm_event).where(
                        alarm_event.c.property_id == pid,
                        alarm_event.c.occurred_at >= clock.start_of_day(start),
                        alarm_event.c.occurred_at <= clock.end_of_day(end),
                    )
                )
                .mappings()
                .all()
            )
            add_section(
                key,
                table(
                    ["When", "Zone", "Cause", "False alarm", "ARC", "Keyholder (min)"],
                    [
                        [
                            clock.london(e["occurred_at"]).strftime("%-d %b %Y %H:%M"),
                            e["zone"],
                            e["cause"],
                            "Yes" if e["false_alarm"] else "No",
                            e["arc_response"],
                            e["keyholder_attended_minutes"],
                        ]
                        for e in ev
                    ],
                ),
            )
        elif key == "training":
            rows = conn.execute(
                select(
                    person.c.name,
                    staff_requirement_type.c.name.label("req"),
                    staff_requirement.c.status,
                    staff_requirement.c.expires_on,
                )
                .join(staff_requirement, staff_requirement.c.person_id == person.c.id)
                .join(staff_requirement_type, staff_requirement_type.c.id == staff_requirement.c.type_id)
                .where(
                    staff_requirement.c.property_id.is_(None) | (staff_requirement.c.property_id == pid),
                    staff_requirement_type.c.restricted.is_(False),
                )
            ).all()
            add_section(
                key,
                table(
                    ["Person", "Requirement", "Status", "Expires"],
                    [[r.name, r.req, r.status.capitalize(), fmt_date(r.expires_on, True)] for r in rows],
                ),
            )
        elif key == "signoffs":
            so = (
                conn.execute(
                    select(signoff, person.c.name)
                    .join(person, person.c.id == signoff.c.signer_id)
                    .where(signoff.c.property_id == pid)
                )
                .mappings()
                .all()
            )
            add_section(
                key,
                table(
                    ["Type", "Signed by", "Name typed", "When", "Fingerprint"],
                    [
                        [
                            s["type"].upper() if s["type"] == "fra" else s["type"].capitalize(),
                            s["name"],
                            s["signed_name"],
                            clock.london(s["signed_at"]).strftime("%-d %b %Y %H:%M"),
                            s["content_hash"][:16],
                        ]
                        for s in so
                    ],
                ),
            )
        elif key == "audit":
            ae = (
                conn.execute(
                    select(audit_event)
                    .where(
                        audit_event.c.property_id == pid,
                        audit_event.c.at >= clock.start_of_day(start),
                        audit_event.c.at <= clock.end_of_day(end),
                    )
                    .order_by(audit_event.c.seq)
                )
                .mappings()
                .all()
            )
            add_section(
                key,
                table(
                    ["When", "Who", "What", "Record"],
                    [
                        [
                            clock.london(a["at"]).strftime("%-d %b %H:%M"),
                            a["actor_label"],
                            a["summary"],
                            a["entity_ref"],
                        ]
                        for a in ae
                    ],
                ),
            )
    fingerprint = hashlib.sha256(
        json.dumps(
            {
                "p": str(pid),
                "from": params["from"],
                "to": params["to"],
                "files": sorted(contents),
                "body": "".join(body),
            }
        ).encode()
    ).hexdigest()
    stamp = f"Exported {clock.london(clock.now()):%-d %b %Y %H:%M %Z} · fingerprint {fingerprint[:16]}"
    doc = f"""<html><head><meta charset="utf-8"><style>
    @page {{ size: A4; margin: 18mm 16mm 20mm; @bottom-center {{ content: "{stamp} · page " counter(page); font: 8pt Inter, sans-serif; color: #6B6B76; }} }}
    body {{ font: 10pt Inter, sans-serif; color: #111113; }}
    .cover {{ page-break-after: always; padding-top: 40mm; }} .mark {{ display:inline-block; width: 22px; height: 22px; border-radius: 6px;
    background:#111113; color:#fff; text-align:center; font-weight:700; line-height:22px; }}
    h1 {{ font-size: 22pt; margin: 18mm 0 4mm; }} h2 {{ font-size: 13pt; margin: 8mm 0 3mm; }} .mut {{ color: #6B6B76; }}
    table {{ width: 100%; border-collapse: collapse; }} th, td {{ text-align: left; border-bottom: 1px solid #EBEBEF; padding: 4px 6px;
    vertical-align: top; font-size: 9pt; }} th {{ color: #6B6B76; font-weight: 500; }}
    </style></head><body>
    <div class="cover"><span class="mark">b</span> <b>bide Comply</b>
    <h1>{html.escape(p["name"])}, {html.escape(p["town"] or "")}<br>Compliance record</h1>
    <p>{start.day} {start:%b}–{end.day} {end:%b %Y} · prepared for {html.escape(AUDIENCE.get(params.get("audience", ""), params.get("audience", "")))}</p>
    <p>Dutyholder: {html.escape(p["dh"] or "to confirm")}</p>
    <p class="mut">Contents: {", ".join(SECTIONS[s].lower() for s in sections)}.</p>
    <p class="mut">This record is kept by bide as operator. Legal duties sit with the dutyholder. {stamp}.</p></div>
    {"".join(body)}</body></html>"""
    import weasyprint

    pdf_doc = weasyprint.HTML(string=doc).render()
    pdf = pdf_doc.write_pdf()
    pdf_key = f"exports/{export_id}/pack.pdf"
    storage.put(pdf_key, pdf, "application/pdf")
    zip_key = None
    if params.get("format") == "pdf_zip":
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("summary.pdf", pdf)
            for name, data in files:
                z.writestr(name, data)
            z.writestr("FINGERPRINT.txt", f"{fingerprint}\n{stamp}\n")
        zip_key = f"exports/{export_id}/evidence.zip"
        storage.put(zip_key, buf.getvalue(), "application/zip")
    conn.execute(
        update(report_export)
        .where(report_export.c.id == export_id)
        .values(
            status="ready",
            pdf_key=pdf_key,
            zip_key=zip_key,
            fingerprint=fingerprint,
            pages=len(pdf_doc.pages),
            photo_count=photo_count,
            finished_at=clock.now(),
        )
    )
    name = conn.execute(select(person.c.name).where(person.c.id == ex["requested_by"])).scalar()
    audit.record(
        conn,
        audit.Actor(ex["requested_by"], name or "Someone", None, "Web"),
        category="export",
        action="export.pack",
        summary=f"Exported an inspection pack ({'PDF + ZIP' if zip_key else 'PDF'}, {len(pdf_doc.pages)} pages)",
        entity_type="report_export",
        entity_id=export_id,
        entity_ref=p["name"],
        property_id=pid,
        after={"fingerprint": fingerprint[:16], "sections": sections},
    )
