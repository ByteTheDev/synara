"""Verify and expose the immutable PR 1065 lock artifact; never install or publish it."""
import base64
import hashlib
import io
import json
import math
import os
from pathlib import Path
import stat
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPOSITORY = "Emanuele-web04/synara"
RUN = 38201985580
DRIVER = "4a72cebe3e3184b4f499b3c683bf6026903746aa"
SOURCE = {"commit": "d4509644c8b7c2ba419680f7da8c2441f230d67e",
          "tree": "877444c1badcb38871bd6ac38ebe401e81022212"}
ARTIFACT_ID = 11725353875
ARTIFACT_NAME = "pr1065-lock-resolution-1"
ZIP_BYTES = 489656
ZIP_SHA256 = "a4d8aff8acebb24d511cf46a19bb7fb5beaa5ddc1c7bf8ed00b5185803cbd877"
LOCK_BYTES = 804789
LOCK_SHA256 = "54440f02f58224a6534fb2e4958a38844f61563d75a26f3d0c4e7fe2ffe0ae60"
LOCK_BLOB = "6b9c93b8b7ec3fc8366a7209c9935cd20d37346c"
INPUT_PATH = "scripts/pr1065-lock-resolution/inputs.json"
INPUT_SHA256 = "f26e66846dd442376ae7df14f9a4a99272a6760e73171ec99a502323f1f1addb"
DRIVER_FILES = {".github/workflows/pr1065-lock-resolution.yml":{"bytes":2987,"sha256":"04695226355beff3de286665e99668845603bd8c425382abc86d573572dac4db","gitBlob":"24f214f4feb75af01beef5bb66f73426516eb450"},"scripts/pr1065-lock-resolution/runner.mjs":{"bytes":12451,"sha256":"dd4b178da7660126ec087fc9d92847c86d03b188252d857126c17323332a729d","gitBlob":"03ea7bf83c458c26a7c38d3adef8bd23ae19ef54"},"scripts/pr1065-lock-resolution/snapshots.mjs":{"bytes":5005,"sha256":"2cfdaf6967e76ec1dabef6a63370c37dcc065ac0cfada74c0201fe790ce964b1","gitBlob":"3f6c01bbc83d6741767253fe75392b178caaee6e"},"scripts/pr1065-lock-resolution/inputs.json":{"bytes":37919,"sha256":"f26e66846dd442376ae7df14f9a4a99272a6760e73171ec99a502323f1f1addb","gitBlob":"c10f7682d07cf7315b4a1bdd9df4b24095feb793"},"scripts/pr1065-lock-resolution/README.md":{"bytes":3943,"sha256":"047dd09fd7482bd6c3f186f46626dcf6378978aa8218236e6682c043bdb2c3f5","gitBlob":"287a1d04741fa7b94289c373bca3f47bae6c8338"}}
NAMES = {
    "state.json", "prepare.json", "resolve.log", "resolve-exit.json",
    "resolution.json", "resolved.lock", "frozen.log", "frozen-exit.json",
    "frozen.json", "final.lock", "snapshots.json", "outcome.json", "manifest.json",
}
sha256 = lambda data: hashlib.sha256(data).hexdigest()
git_blob = lambda data: hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
assert os.environ["GITHUB_REPOSITORY"] == REPOSITORY
root = Path(os.environ["RUNNER_TEMP"]) / "pr1065-lock-artifact-reader"
root.mkdir(exist_ok=False)
token = os.environ.pop("GH_TOKEN")
api = "https://api.github.com/repos/" + REPOSITORY
headers = {"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
           "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "synara-lock-artifact-reader"}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, hdrs, newurl):
        return None

opener = urllib.request.build_opener(NoRedirect())

def download(url, limit, authenticated):
    for _ in range(5):
        parsed = urllib.parse.urlsplit(url)
        assert parsed.scheme == "https" and parsed.hostname and not parsed.username
        if authenticated:
            assert url.startswith(api + "/")
        request = urllib.request.Request(url, headers=headers if authenticated else {})
        try:
            with opener.open(request, timeout=20) as response:
                declared = response.headers.get("Content-Length")
                assert declared is None or int(declared) <= limit
                data = response.read(limit + 1)
                assert len(data) <= limit
                return data
        except urllib.error.HTTPError as error:
            if error.code not in (301, 302, 303, 307, 308):
                raise
            location = error.headers.get("Location")
            error.close()
            assert location
            url = urllib.parse.urljoin(url, location)
            authenticated = False
    raise AssertionError("redirect bound exceeded")

def source_guard():
    def git(*args):
        return subprocess.run(["git", *args], check=True, capture_output=True,
                              timeout=10).stdout
    assert git("rev-parse", "HEAD").decode().strip() == os.environ["GITHUB_SHA"]
    assert git("status", "--porcelain=v1", "--untracked-files=all") == b""
    git("merge-base", "--is-ancestor", DRIVER, "HEAD")
    files = {}
    for path in [".github/workflows/pr1065-lock-artifact-reader.yml",
                 "scripts/pr1065-lock-artifact-reader.py"] + sorted(DRIVER_FILES):
        data = Path(path).read_bytes()
        assert data == git("show", "HEAD:" + path), "reader/source bytes changed"
        if path in DRIVER_FILES:
            assert len(data) == DRIVER_FILES[path]["bytes"]
            assert sha256(data) == DRIVER_FILES[path]["sha256"]
            assert git_blob(data) == DRIVER_FILES[path]["gitBlob"]
        files[path] = {"bytes": len(data), "sha256": sha256(data), "gitBlob": git_blob(data)}
    return files

def observed_files(rows):
    assert isinstance(rows, list)
    assert len({row["path"] for row in rows}) == len(rows)
    return {row["path"]: {key: row[key] for key in ("bytes", "sha256", "gitBlob")} for row in rows}

try:
    reader_files = source_guard()
    input_bytes = Path(INPUT_PATH).read_bytes()
    assert sha256(input_bytes) == INPUT_SHA256
    inputs = json.loads(input_bytes)
    assert inputs["source"] == SOURCE and inputs["bunVersion"] == "1.4.2"
    seed_files = observed_files(inputs["baseFiles"])
    assert len(seed_files) == 14 and len(inputs["allManifestPaths"]) == 14
    run = json.loads(download(api + "/actions/runs/" + str(RUN), 128 * 1024, True))
    assert run["id"] == RUN and run["head_sha"] == DRIVER
    assert run["status"] == "completed" and run["conclusion"] == "success"
    metadata = json.loads(download(api + "/actions/artifacts/" + str(ARTIFACT_ID), 65536, True))
    assert metadata["id"] == ARTIFACT_ID and metadata["name"] == ARTIFACT_NAME
    assert metadata["size_in_bytes"] == ZIP_BYTES and metadata["digest"] == "sha256:" + ZIP_SHA256
    assert not metadata["expired"]
    assert metadata["workflow_run"]["id"] == RUN and metadata["workflow_run"]["head_sha"] == DRIVER
    data = download(api + "/actions/artifacts/" + str(ARTIFACT_ID) + "/zip", ZIP_BYTES, True)
    assert len(data) == ZIP_BYTES and sha256(data) == ZIP_SHA256
    (root / "original.zip").write_bytes(data)
    contents = {}
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        members = archive.infolist()
        assert len(members) == len(NAMES)
        assert sum(item.file_size for item in members) <= 8 * 1024 * 1024
        for item in members:
            name = item.filename
            assert name in NAMES and name not in contents
            assert not stat.S_ISLNK(item.external_attr >> 16) and not item.is_dir()
            assert 0 < item.file_size <= 2 * 1024 * 1024
            value = archive.read(item)
            assert len(value) == item.file_size
            contents[name] = value
    assert set(contents) == NAMES
    manifest = json.loads(contents["manifest.json"])["files"]
    assert len({row["path"] for row in manifest}) == len(manifest) == 12
    assert {row["path"] for row in manifest} == NAMES - {"manifest.json"}
    for row in manifest:
        value = contents[row["path"]]
        assert len(value) == row["bytes"] and sha256(value) == row["sha256"]
    outcome = json.loads(contents["outcome.json"])
    assert outcome["source"] == SOURCE and outcome["driver"] == DRIVER
    assert outcome["success"] is True and outcome["failures"] == []
    assert outcome["outcomes"] == {name: "success" for name in ("prepare", "resolve", "inspect", "frozen", "verify")}
    snapshots = json.loads(contents["snapshots.json"])
    assert snapshots["failures"] == [] and len(snapshots["records"]) == 10
    assert len({row["path"] for row in snapshots["records"]}) == 10
    assert {row["path"] for row in snapshots["records"]} == NAMES - {"manifest.json", "snapshots.json", "outcome.json"}
    for row in snapshots["records"]:
        value = contents[row["path"]]
        assert row["immutableCopy"] is True and row["sourceBefore"] == row["sourceAfter"]
        assert row["sourceBefore"]["size"] == row["bytes"] == len(value)
        assert row["sha256"] == sha256(value) and isinstance(row["cutoffUtc"], str)
    for name in ("resolve-exit.json", "frozen-exit.json"):
        assert json.loads(contents[name]) == {"bunExit": 0, "teeExit": 0}
    lock = contents["final.lock"]
    assert lock == contents["resolved.lock"]
    assert len(lock) == LOCK_BYTES and sha256(lock) == LOCK_SHA256 and git_blob(lock) == LOCK_BLOB
    resolution = json.loads(contents["resolution.json"])
    frozen = json.loads(contents["frozen.json"])
    for report in (resolution, frozen):
        assert report["bytes"] == LOCK_BYTES and report["sha256"] == LOCK_SHA256
        assert report["gitBlob"] == LOCK_BLOB and report["workspaceCount"] == 14
        assert report["packageCount"] == 2947 and report["unchangedRootLockFields"] is True
    assert frozen["lockUnchanged"] is True
    changes = resolution["packageChanges"]
    assert changes == frozen["packageChanges"] and isinstance(changes, list) and len(changes) <= 1000
    assert len({row["name"] for row in changes}) == len(changes)
    for guard in (json.loads(contents["prepare.json"]), resolution["guard"], frozen["guard"], outcome["finalGuard"]):
        assert guard["source"] == SOURCE and guard["driver"] == DRIVER
        assert guard["bunVersion"] == "1.4.2" and str(guard["run"]) == str(RUN) and str(guard["attempt"]) == "1"
        assert observed_files(guard["sourceFiles"]) == seed_files
        assert observed_files(guard["driverFiles"]) == DRIVER_FILES
    assert source_guard() == reader_files
    receipt = {"reader": os.environ["GITHUB_SHA"], "readerFiles": reader_files,
               "artifact": metadata, "run": RUN, "driver": DRIVER, "source": SOURCE,
               "zipSha256": sha256(data), "lock": {"bytes": len(lock), "sha256": sha256(lock), "gitBlob": git_blob(lock)},
               "files": [{"path": name, "bytes": len(value), "sha256": sha256(value)} for name, value in sorted(contents.items())],
               "packageChanges": changes, "snapshotsVerified": 10, "guardsVerified": 4,
               "retrievedAtUnix": time.time(),
               "qualification": "Verifies and exposes the prior scripts-disabled dependency artifact only. No install rerun, full application/lifecycle qualification, source compatibility or feature publication."}
    (root / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    chunk_bytes = 4096
    count = math.ceil(len(lock) / chunk_bytes)
    print("SYNARA_PR1065_LOCK_BEGIN " + json.dumps({"bytes": len(lock), "sha256": sha256(lock), "gitBlob": git_blob(lock), "chunks": count}))
    for index in range(count):
        chunk = lock[index * chunk_bytes:(index + 1) * chunk_bytes]
        print("SYNARA_PR1065_LOCK_CHUNK " + json.dumps({"index": index, "count": count, "bytes": len(chunk), "sha256": sha256(chunk), "base64": base64.b64encode(chunk).decode()}))
    for change in changes:
        rendered = json.dumps(change, separators=(",", ":"))
        assert len(rendered.encode()) <= 65536
        print("SYNARA_PR1065_PACKAGE_CHANGE " + rendered)
    print("SYNARA_PR1065_LOCK_END " + json.dumps({"chunks": count, "sha256": sha256(lock), "packageChanges": len(changes), "snapshotsVerified": 10, "guardsVerified": 4}))
except Exception as error:
    (root / "reader-error.json").write_text(json.dumps({"type": type(error).__name__, "message": str(error)}) + "\n")
    raise
