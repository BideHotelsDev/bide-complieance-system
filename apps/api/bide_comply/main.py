"""The API app. In production it also serves the two built web apps (one image, PRD §11)."""

import logging
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from bide_comply import auth
from bide_comply.api import (
    actions,
    approvals,
    assessor,
    certificates,
    field,
    files,
    gates,
    home,
    imports,
    library,
    people,
    register,
    reports,
    reviews,
    scorecard,
    settings as settings_api,
    setup,
)
from bide_comply.config import settings

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")

app = FastAPI(title="bide Comply API", version="0.1.0", docs_url="/api/docs" if not settings.is_production else None,
              openapi_url="/api/openapi.json")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.web_base_url, settings.field_base_url],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Content-Type", "X-Requested-With", "X-Bide-App"],
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    # §9.5: strict CSP (no inline scripts), HSTS, no framing, camera and geolocation for our own origin only.
    resp.headers.setdefault("Content-Security-Policy",
                            "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
                            "font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; "
                            "frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
    resp.headers.setdefault("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload")
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    resp.headers.setdefault("Permissions-Policy", "camera=(self), geolocation=(self), microphone=()")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    return resp


@app.exception_handler(HTTPException)
async def http_error(request: Request, exc: HTTPException):
    detail = exc.detail if isinstance(exc.detail, dict) else {"code": "error", "message": str(exc.detail)}
    return JSONResponse(detail, status_code=exc.status_code)


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    first = exc.errors()[0] if exc.errors() else {}
    field_ = ".".join(str(x) for x in first.get("loc", [])[1:])
    return JSONResponse({"code": "invalid", "message": f"Check {field_ or 'the form'}: {first.get('msg', 'invalid value')}.",
                         "errors": exc.errors()}, status_code=422)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


for r in (auth.router, home.router, register.router, actions.router, reviews.router, gates.router, approvals.router,
          certificates.router, scorecard.router, assessor.router, field.router, files.router, people.router,
          people.groups_router, library.router, setup.router, imports.router, settings_api.router, reports.router,
          reports.export_router):
    app.include_router(r)


def _spa(dist: Path, prefix: str) -> None:
    index = dist / "index.html"
    app.mount(f"{prefix}/assets", StaticFiles(directory=dist / "assets"), name=f"assets{prefix or '-web'}")

    @app.get(prefix + "/{path:path}", include_in_schema=False)
    def serve(path: str):
        if path.startswith("api/") or path == "api":
            raise HTTPException(404, detail={"code": "not_found", "message": "Not found."})
        f = (dist / path).resolve()
        if path and dist.resolve() in f.parents and f.is_file():
            return FileResponse(f)
        return FileResponse(index)


if settings.field_dist_dir and (settings.field_dist_dir / "index.html").exists():
    _spa(settings.field_dist_dir, "/app")
if settings.web_dist_dir and (settings.web_dist_dir / "index.html").exists():
    _spa(settings.web_dist_dir, "")
