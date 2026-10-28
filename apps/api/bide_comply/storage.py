"""Evidence storage: originals are kept unaltered with a SHA-256; display copies are re-encoded, stripped of metadata
and stamped (EXE-03, §9.4).

Uploads use short-lived signed URLs. With the S3 backend the browser PUTs straight to the private bucket; with the
local backend (development) it PUTs to the API, which writes under storage_dir.
"""

import hashlib
import io
import time
from pathlib import Path

from itsdangerous import BadSignature, URLSafeTimedSerializer
from PIL import Image, ImageDraw, ImageFont, ImageOps

from bide_comply.config import settings

IMAGE_TYPES = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic"}
DOC_TYPES = {"application/pdf": "pdf"}
# Spreadsheets are accepted for Settings › Import only (CMS-06), never as evidence of a check.
SHEET_TYPES = {"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx", "text/csv": "csv"}
LOGO_TYPES = {"image/png": "png", "image/webp": "webp", "image/svg+xml": "svg"}


def sniff(data: bytes) -> str | None:
    """File type from its content (magic bytes), never from the extension (§9.4)."""
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[4:12] in (b"ftypheic", b"ftypheix", b"ftypmif1"):
        return "image/heic"
    if data[:5] == b"%PDF-":
        return "application/pdf"
    head = data[:512].lstrip().lower()
    if head.startswith(b"<svg") or (head.startswith(b"<?xml") and b"<svg" in head):
        return "image/svg+xml"
    if data[:4] == b"PK\x03\x04":
        if b"xl/workbook" in data:
            return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        return "application/zip"  # other office files
    return None


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class _Signer:
    def __init__(self) -> None:
        self.s = URLSafeTimedSerializer(settings.session_secret or "dev-insecure", salt="storage")

    def sign(self, payload: dict) -> str:
        return self.s.dumps(payload)

    def load(self, token: str, max_age: int) -> dict:
        try:
            return self.s.loads(token, max_age=max_age)
        except BadSignature as e:
            raise PermissionError("Link expired or invalid") from e


signer = _Signer()


class LocalStorage:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        p = (self.root / key).resolve()
        if self.root not in p.parents:
            raise PermissionError("bad key")
        return p

    def put(self, key: str, data: bytes, content_type: str) -> None:
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        if p.exists():
            raise FileExistsError(key)  # originals are write-once
        p.write_bytes(data)

    def get(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    def exists(self, key: str) -> bool:
        return self._path(key).exists()

    def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)

    def upload_url(self, key: str, content_type: str, max_bytes: int) -> dict:
        token = signer.sign({"k": key, "t": content_type, "m": max_bytes, "op": "put"})
        return {
            "method": "PUT",
            "url": f"/api/files/upload/{token}",
            "headers": {"Content-Type": content_type},
        }

    def download_url(self, key: str, file_name: str, inline: bool = True) -> str:
        token = signer.sign({"k": key, "n": file_name, "i": inline, "op": "get", "at": int(time.time())})
        # Relative: the SPA and the API share an origin (Vite proxy in development, one image in production).
        return f"/api/files/download/{token}"


class S3Storage:
    def __init__(self) -> None:
        import boto3

        self.bucket = settings.s3_bucket
        self.client = boto3.client(
            "s3",
            region_name=settings.s3_region,
            endpoint_url=settings.s3_endpoint_url or None,
            aws_access_key_id=settings.s3_access_key_id or None,
            aws_secret_access_key=settings.s3_secret_access_key or None,
        )

    def put(self, key: str, data: bytes, content_type: str) -> None:
        self.client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type)

    def get(self, key: str) -> bytes:
        return self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()

    def exists(self, key: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=key)
            return True
        except Exception:  # noqa: BLE001 - botocore raises ClientError for a missing key
            return False

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=key)

    def upload_url(self, key: str, content_type: str, max_bytes: int) -> dict:
        # Size and type are locked into the presigned POST policy; it expires in 5 minutes.
        post = self.client.generate_presigned_post(
            self.bucket,
            key,
            Fields={"Content-Type": content_type},
            Conditions=[{"Content-Type": content_type}, ["content-length-range", 1, max_bytes]],
            ExpiresIn=settings.signed_url_seconds,
        )
        return {"method": "POST", "url": post["url"], "fields": post["fields"]}

    def download_url(self, key: str, file_name: str, inline: bool = True) -> str:
        disposition = f'{"inline" if inline else "attachment"}; filename="{file_name}"'
        return self.client.generate_presigned_url(
            "get_object",
            Params={"Bucket": self.bucket, "Key": key, "ResponseContentDisposition": disposition},
            ExpiresIn=settings.signed_url_seconds,
        )


def make_storage():
    if settings.storage_backend == "s3":
        return S3Storage()
    return LocalStorage(settings.storage_dir)


storage = make_storage()


def display_copy(data: bytes, stamp: str) -> tuple[bytes, bytes]:
    """A re-encoded JPEG without metadata, stamped along the bottom, plus a small thumbnail."""
    img = Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img).convert("RGB")  # applies rotation, then drops EXIF (incl. GPS)
    img.thumbnail((2000, 2000))
    draw = ImageDraw.Draw(img)
    h = max(28, img.height // 28)
    try:
        font = ImageFont.load_default(size=int(h * 0.55))
    except TypeError:  # older Pillow
        font = ImageFont.load_default()
    draw.rectangle([0, img.height - h, img.width, img.height], fill=(17, 17, 19))
    draw.text((h // 3, img.height - h + h // 5), stamp, fill=(255, 255, 255), font=font)
    out = io.BytesIO()
    img.save(out, "JPEG", quality=85)
    thumb = img.copy()
    thumb.thumbnail((480, 480))
    tout = io.BytesIO()
    thumb.save(tout, "JPEG", quality=80)
    return out.getvalue(), tout.getvalue()


def sanitise_svg(data: bytes) -> bytes:
    """Logos may be SVG; scripts, event handlers, foreign objects and external references are removed (§9.5)."""
    import re

    text = data.decode("utf-8", "replace")
    text = re.sub(r"<script\b.*?</script\s*>", "", text, flags=re.S | re.I)
    text = re.sub(r"<foreignObject\b.*?</foreignObject\s*>", "", text, flags=re.S | re.I)
    text = re.sub(r"\son\w+\s*=\s*(\"[^\"]*\"|'[^']*')", "", text, flags=re.I)
    text = re.sub(r"(href|xlink:href)\s*=\s*(\"(?!#)[^\"]*\"|'(?!#)[^']*')", "", text, flags=re.I)
    return text.encode()
