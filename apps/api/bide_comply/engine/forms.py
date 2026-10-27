"""Form schemas built in the CMS form builder, and how a submission is checked against one (CMS-02, EXE-02, EXE-05).

A field is a dict:

    {"key": "arc_confirmed", "type": "yes_no", "label": "ARC confirmed signal received",
     "help": "Phone the ARC…", "required": true, "fail_on": "no"}

Types: checkbox, yes_no, pass_fail, pass_fail_items, number, text, select, location, photo, signature, file, date.
A number may carry unit, min and max: a reading outside the range fails the check but never blocks submission (§4.5).
"""

from dataclasses import dataclass, field
from typing import Any

FIELD_TYPES = {
    "checkbox",
    "yes_no",
    "pass_fail",
    "pass_fail_items",
    "number",
    "text",
    "select",
    "location",
    "photo",
    "signature",
    "file",
    "date",
}
EVIDENCE_TYPES = {"photo", "file"}


class FormError(ValueError):
    pass


def validate_schema(form: list[dict]) -> list[dict]:
    """Check a form from the builder before it's saved. Returns the cleaned form."""
    seen: set[str] = set()
    out = []
    for i, f in enumerate(form):
        key = str(f.get("key") or "").strip()
        ftype = f.get("type")
        if not key or not key.replace("_", "").isalnum():
            raise FormError(f"Field {i + 1} needs a key of letters, digits and underscores.")
        if key in seen:
            raise FormError(f"Two fields share the key {key!r}.")
        seen.add(key)
        if ftype not in FIELD_TYPES:
            raise FormError(f"Field {key!r} has an unknown type {ftype!r}.")
        if not str(f.get("label") or "").strip():
            raise FormError(f"Field {key!r} needs a label.")
        if ftype == "number":
            lo, hi = f.get("min"), f.get("max")
            if lo is not None and hi is not None and float(lo) > float(hi):
                raise FormError(f"Field {key!r}: the minimum is above the maximum.")
        if ftype == "select" and not f.get("options"):
            raise FormError(f"Field {key!r} is a select with no options.")
        if ftype == "photo":
            mn = int(f.get("min_photos") or 1)
            mx = f.get("max_photos")
            if mx is not None and int(mx) < mn:
                raise FormError(f"Field {key!r}: max photos is below min photos.")
        out.append({k: v for k, v in f.items() if v is not None})
    return out


@dataclass
class Evaluation:
    result: str  # passed | failed
    failed_fields: list[dict] = field(default_factory=list)  # [{key, label, value, why}]
    missing: list[str] = field(default_factory=list)  # labels of required fields left empty


def _empty(v: Any) -> bool:
    return v is None or v == "" or v == [] or v == {}


def evaluate(form: list[dict], values: dict[str, Any], evidence_counts: dict[str, int]) -> Evaluation:
    """Evidence counts are per photo/file field key, from the files actually stored with the submission."""
    failed: list[dict] = []
    missing: list[str] = []
    for f in form:
        key, ftype, label = f["key"], f["type"], f["label"]
        v = values.get(key)
        if ftype in EVIDENCE_TYPES:
            need = int(f.get("min_photos") or 1) if f.get("required", True) else 0
            if evidence_counts.get(key, 0) < need:
                missing.append(label)
            continue
        if _empty(v):
            if f.get("required", False):
                missing.append(label)
            continue
        if ftype == "yes_no" and f.get("fail_on") in ("yes", "no") and str(v).lower() == f["fail_on"]:
            failed.append({"key": key, "label": label, "value": v, "why": f"answered {str(v).capitalize()}"})
        elif ftype == "pass_fail" and str(v).lower() == "fail":
            failed.append({"key": key, "label": label, "value": v, "why": "marked Fail"})
        elif ftype == "pass_fail_items" and isinstance(v, dict):
            bad = [k for k, r in v.items() if str(r).lower() == "fail"]
            if bad:
                failed.append({"key": key, "label": label, "value": v, "why": "failed: " + ", ".join(bad)})
        elif ftype == "checkbox" and f.get("fail_on") == "unchecked" and not v:
            failed.append({"key": key, "label": label, "value": v, "why": "not ticked"})
        elif ftype == "number":
            try:
                n = float(v)
            except (TypeError, ValueError):
                raise FormError(f"{label}: {v!r} is not a number.") from None
            unit = f.get("unit") or ""
            if f.get("min") is not None and n < float(f["min"]):
                failed.append({"key": key, "label": label, "value": n, "why": f"below {f['min']}{unit}"})
            elif f.get("max") is not None and n > float(f["max"]):
                failed.append({"key": key, "label": label, "value": n, "why": f"above {f['max']}{unit}"})
        elif ftype == "select" and v in (f.get("fail_options") or []):
            failed.append({"key": key, "label": label, "value": v, "why": f"answered {v}"})
    for item in failed:
        f = next(x for x in form if x["key"] == item["key"])
        # The builder can say in plain words what a fail means: "Alarm company did not get the weekly test signal".
        item["text"] = f.get("fail_text") or f"{item['label'].rstrip('?')}: {item['why']}"
    # Every submission carries at least one photo (golden rule 1, EXE-02). Certificate templates may use a file.
    if not any(f["type"] in EVIDENCE_TYPES for f in form) and sum(evidence_counts.values()) < 1:
        missing.append("A photo")
    return Evaluation("failed" if failed else "passed", failed, missing)


def photo_slots(form: list[dict]) -> list[dict]:
    return [f for f in form if f["type"] == "photo"]
