"""Reports and packs (DSH-07..09): inspection pack builder, scheduled reports, past exports, CSV/XLSX table export."""

import csv
import io
import uuid
from datetime import date

from fastapi import APIRouter, Request
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import select, update

from bide_comply import audit, clock
from bide_comply.auth import Current, actor_for
from bide_comply.authz import scope_filter
from bide_comply.db import ConnDep
from bide_comply.jobs.queue import enqueue
from bide_comply.schema import dutyholder, property_, report_export, scheduled_report
from bide_comply.services import packs
from bide_comply.services.common import names, problem
from bide_comply.storage import storage

router = APIRouter(prefix="/api/reports", tags=["reports"])


@router.get("/options")
def options(pr: Current, conn: ConnDep) -> dict:
    pr.require("export.pack")
    props = conn.execute(
        select(property_.c.id, property_.c.code, property_.c.name, property_.c.trading_since)
        .where(scope_filter(pr, property_.c.id))
        .order_by(property_.c.sort)
    ).all()
    return {
        "properties": [
            {"id": str(p.id), "code": p.code, "name": p.name, "trading_since": p.trading_since} for p in props
        ],
        "audiences": [{"key": k, "label": v, "sections": packs.PRESETS[k]} for k, v in packs.AUDIENCE.items()],
        "sections": [{"key": k, "label": v} for k, v in packs.SECTIONS.items()],
    }


class PackIn(BaseModel):
    property_id: uuid.UUID
    audience: str = "insurer"
    date_from: date
    date_to: date
    sections: list[str]
    format: str = "pdf_zip"  # pdf_zip | pdf


@router.post("/preview")
def preview(body: PackIn, pr: Current, conn: ConnDep) -> dict:
    pr.require_property(body.property_id)
    pr.require("export.pack", body.property_id)
    p = (
        conn.execute(
            select(property_, dutyholder.c.name.label("dh"))
            .outerjoin(dutyholder, dutyholder.c.id == property_.c.dutyholder_id)
            .where(property_.c.id == body.property_id)
        )
        .mappings()
        .one()
    )
    est = packs.estimate(conn, body.property_id, body.date_from, body.date_to, body.sections)
    return {
        "title": f"{p['name']}, {p['town'] or ''}",
        "period": f"{body.date_from.day} {body.date_from:%b}–{body.date_to.day} {body.date_to:%b %Y}",
        "audience": packs.AUDIENCE.get(body.audience, body.audience),
        "dutyholder": p["dh"],
        "contents": [packs.SECTIONS[s] for s in body.sections],
        "estimate": est,
    }


@router.post("/packs")
def build_pack(body: PackIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    pr.require_property(body.property_id)
    pr.require("export.pack", body.property_id)
    if body.date_to < body.date_from:
        raise problem(422, "dates", "The end date is before the start date.")
    bad = [s for s in body.sections if s not in packs.SECTIONS]
    if bad or not body.sections:
        raise problem(422, "sections", "Choose what to include.")
    eid = uuid.uuid4()
    conn.execute(
        report_export.insert().values(
            id=eid,
            kind="inspection_pack",
            property_id=body.property_id,
            params={
                "audience": body.audience,
                "from": body.date_from.isoformat(),
                "to": body.date_to.isoformat(),
                "sections": body.sections,
                "format": body.format,
            },
            requested_by=pr.person_id,
        )
    )
    conn.commit()
    if not enqueue("build_pack", str(eid)):
        # No worker queue (development without Redis): build it now.
        packs.build(conn, eid)
    return {"id": str(eid)}


@router.get("/exports")
def exports(pr: Current, conn: ConnDep) -> dict:
    rows = (
        conn.execute(
            select(report_export, property_.c.name.label("property"))
            .outerjoin(property_, property_.c.id == report_export.c.property_id)
            .where(scope_filter(pr, report_export.c.property_id) | report_export.c.property_id.is_(None))
            .order_by(report_export.c.created_at.desc())
            .limit(50)
        )
        .mappings()
        .all()
    )
    who = names(conn, {r["requested_by"] for r in rows})
    return {
        "rows": [
            {
                "id": str(r["id"]),
                "kind": r["kind"],
                "property": r["property"],
                "status": r["status"],
                "params": r["params"],
                "pages": r["pages"],
                "photos": r["photo_count"],
                "by": who.get(r["requested_by"]),
                "at": r["created_at"],
                "fingerprint": (r["fingerprint"] or "")[:16],
                "pdf_url": storage.download_url(r["pdf_key"], "inspection-pack.pdf", inline=False)
                if r["pdf_key"]
                else None,
                "zip_url": storage.download_url(r["zip_key"], "evidence.zip", inline=False) if r["zip_key"] else None,
                "error": r["error"],
            }
            for r in rows
        ]
    }


@router.get("/exports/{export_id}")
def export_status(export_id: uuid.UUID, pr: Current, conn: ConnDep) -> dict:
    r = conn.execute(select(report_export).where(report_export.c.id == export_id)).mappings().first()
    if not r or (r["requested_by"] != pr.person_id and not pr.is_admin):
        raise problem(404, "not_found", "Not found.")
    return {
        "status": r["status"],
        "pages": r["pages"],
        "photos": r["photo_count"],
        "pdf_url": storage.download_url(r["pdf_key"], "inspection-pack.pdf", inline=False) if r["pdf_key"] else None,
        "zip_url": storage.download_url(r["zip_key"], "evidence.zip", inline=False) if r["zip_key"] else None,
        "fingerprint": (r["fingerprint"] or "")[:16],
        "error": r["error"],
    }


@router.get("/scheduled")
def scheduled(pr: Current, conn: ConnDep) -> dict:
    return {
        "rows": [
            {
                "id": str(r["id"]),
                "name": r["name"],
                "schedule": r["schedule"],
                "target": r["target"],
                "enabled": r["enabled"],
                "kind": r["kind"],
                "last_run_at": r["last_run_at"],
            }
            for r in conn.execute(select(scheduled_report).order_by(scheduled_report.c.name)).mappings()
        ]
    }


class ScheduleToggle(BaseModel):
    enabled: bool


@router.patch("/scheduled/{report_id}")
def toggle_scheduled(report_id: uuid.UUID, body: ScheduleToggle, request: Request, pr: Current, conn: ConnDep) -> dict:
    pr.require("settings.view")
    conn.execute(update(scheduled_report).where(scheduled_report.c.id == report_id).values(enabled=body.enabled))
    audit.record(
        conn,
        actor_for(request, pr),
        category="settings",
        action="report.schedule",
        summary=f"{'Turned on' if body.enabled else 'Turned off'} a scheduled report",
        entity_type="scheduled_report",
        entity_id=report_id,
    )
    return {"ok": True}


# --- Table export (DSH-09): the current filtered view, to CSV or XLSX -------------------------------------------------

export_router = APIRouter(prefix="/api/export", tags=["reports"])


class TableIn(BaseModel):
    name: str
    columns: list[dict]  # [{key, label}]
    rows: list[dict]
    format: str = "csv"


@export_router.post("")
def export_table(body: TableIn, request: Request, pr: Current, conn: ConnDep) -> Response:
    """The client sends the rows it is showing (already filtered and scoped by the server); this formats them and logs
    the export. Bulk exports are throttled by the rate limiter and appear in the audit log."""
    if len(body.rows) > 10000:
        raise problem(413, "too_many", "That's too many rows to export at once. Narrow the filters.")
    audit.record(
        conn,
        actor_for(request, pr),
        category="export",
        action="export.table",
        summary=f"Exported {len(body.rows)} rows from {body.name} ({body.format.upper()})",
        entity_type="export",
    )
    stamp = clock.london(clock.now()).strftime("%Y-%m-%d %H%M")
    fname = f"{body.name} - {stamp}"
    if body.format == "xlsx":
        from openpyxl import Workbook

        wb = Workbook()
        ws = wb.active
        ws.title = body.name[:31]
        ws.append([c["label"] for c in body.columns])
        for r in body.rows:
            ws.append([_cell(r.get(c["key"])) for c in body.columns])
        buf = io.BytesIO()
        wb.save(buf)
        return Response(
            buf.getvalue(),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f'attachment; filename="{fname}.xlsx"'},
        )
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([c["label"] for c in body.columns])
    for r in body.rows:
        w.writerow([_cell(r.get(c["key"])) for c in body.columns])
    return Response(
        buf.getvalue().encode("utf-8-sig"),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{fname}.csv"'},
    )


def _cell(v):
    # Spreadsheet formula injection: text starting with = + - @ is prefixed so it stays text.
    if isinstance(v, str) and v[:1] in ("=", "+", "-", "@"):
        return "'" + v
    return v
