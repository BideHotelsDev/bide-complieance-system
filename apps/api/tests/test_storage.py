"""The S3 backend hands out the API's own signed links unless direct bucket URLs are switched on."""

import io

import pytest
from botocore.exceptions import ResponseStreamingError

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

    def get_object(self, Bucket, Key):  # noqa: N803
        return {"Body": io.BytesIO(self.objects[Key])}


class DroppyBucket(FakeBucket):
    """Loses the connection part-way through the first `drops` reads."""

    def __init__(self, drops):
        super().__init__()
        self.drops = drops

    def get_object(self, Bucket, Key):  # noqa: N803
        if self.drops:
            self.drops -= 1
            raise ResponseStreamingError(error="IncompleteRead(0 bytes read, 5428 more expected)")
        return super().get_object(Bucket, Key)


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


def test_s3_reads_start_again_when_the_connection_drops(s3):
    s3.client = DroppyBucket(drops=2)
    s3.put("k", b"photo", "image/jpeg")
    assert s3.get("k") == b"photo"
    s3.client.drops = S3Storage.READ_ATTEMPTS
    with pytest.raises(ResponseStreamingError):
        s3.get("k")
