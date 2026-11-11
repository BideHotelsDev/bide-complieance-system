"""Is this vendored copy exactly what was synced from bide-hub? An app's test suite calls check():

    from myapp._vendor.bide_hub_client import integrity

    def test_vendored_bide_hub_client_is_unmodified():
        assert integrity.check() == []

A change belongs in bide-hub's packages/bide-hub-client, then `vendor.py` copies it into every app.
"""

import hashlib
import json
from pathlib import Path

MANIFEST = "VENDORED.json"


def digest(path: Path) -> str:
    # Line endings normalised, so a Windows checkout (core.autocrlf) doesn't count as a change.
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def check(directory: Path | None = None) -> list[str]:
    """Problems with the vendored copy in `directory` (default: this package); empty when it matches its manifest."""
    here = directory or Path(__file__).parent
    manifest_path = here / MANIFEST
    if not manifest_path.exists():
        return [f"no {MANIFEST}: not a vendored copy"]
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected: dict[str, str] = manifest.get("files", {})
    problems = []
    for name, sha in sorted(expected.items()):
        path = here / name
        if not path.exists():
            problems.append(f"{name} is missing")
        elif digest(path) != sha:
            problems.append(f"{name} was edited after vendoring (change it in bide-hub and sync instead)")
    for path in sorted(here.glob("*.py")):
        if path.name not in expected:
            problems.append(f"{path.name} isn't part of bide-hub-client {manifest.get('version')}")
    return problems
