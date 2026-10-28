"""The S3 backend hands out the API's own signed links unless direct bucket URLs are switched on."""

import pytest

from bide_comply.config import settings
from bide_comply.storage import S3Storage


class FakeBucket:
    def __init__(self):
        self.objects = {}

    def put_object(self, Bucket, Key, Body, ContentType):  # noqa: N803 - boto3's argument names
        self.objects[Key] = Body

    def head_object(self, Bucket, Key):  # noqa: N803
        if Key not in self.objects:
            raise KeyError(Key)

    def generate_presigned_url(self, *args, **kwargs):
        return "https://bucket.example/presigned"


@pytest.fixture
def s3():
    store = S3Storage()
    store.client = FakeBucket()
    return store


def test_s3_uploads_and_downloads_go_through_the_api(s3):
    assert s3.upload_url("k", "image/jpeg", 10)["url"].startswith("/api/files/upload/")
    assert s3.download_url("k", "photo.jpg").startswith("/api/files/download/")


def test_s3_direct_urls_when_switched_on(s3, monkeypatch):
    monkeypatch.setattr(settings, "s3_direct_urls", True)
    assert s3.download_url("k", "photo.jpg") == "https://bucket.example/presigned"


def test_s3_originals_are_write_once(s3):
    s3.put_once("k", b"x", "image/jpeg")
    with pytest.raises(FileExistsError):
        s3.put_once("k", b"y", "image/jpeg")
