"""Read immutable synthetic diagnostic artifacts; do not run or relabel their tests."""

import hashlib
import io
import json
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
RUN = 38200296921
DRIVER = "d6bb7f39cbd5b1632755f714722f9bd58012eec5"
SOURCE = {
    "commit": "a1b087d984a39cf9df936d5da9465db9e7679600",
    "tree": "6011b0c1b9d93e2dcbf9b78b79c981d587cf4a4b",
    "fixture": "be5409007be3f448000f9d7aa714a0c32bb50d73",
}
ARTIFACTS = [
    (11725770165, "gitcore-fixture-windows-latest-candidate", "win32", 7015,
     "33bbd250f019378e9a1551b3a0259b43aca11b18bc1f05eeea4a54b953f927b0"),
    (11724079989, "gitcore-fixture-ubuntu-latest-candidate", "linux", 7423,
     "38ef2f4cfc1106c3182c7947b541c7d826b11310c4b96330f78a91385bb91bd4"),
]
CASE_NAMES = [
    "literal LF checkout bytes", "ignored rename retains 100755",
    "literal numeric-colon index path", "exact trailing-space untracked filename",
    "short-directory explicit native-path argument", "filesystem monitor command starts",
]
assert os.environ["GITHUB_REPOSITORY"] == REPOSITORY
root = Path(os.environ["RUNNER_TEMP"]) / "pr1847-artifact-reader"
root.mkdir(exist_ok=False)
token = os.environ.pop("GH_TOKEN")
api = "https://api.github.com/repos/" + REPOSITORY
headers = {"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
           "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "synara-retained-artifact-reader"}
sha256 = lambda data: hashlib.sha256(data).hexdigest()


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
                assert declared is None or int(declared) <= limit, "download exceeds bound"
                data = response.read(limit + 1)
                assert len(data) <= limit, "download exceeds bound"
                return data
        except urllib.error.HTTPError as error:
            if error.code not in (301, 302, 303, 307, 308):
                raise
            location = error.headers.get("Location")
            error.close()
            assert location, "redirect without location"
            url = urllib.parse.urljoin(url, location)
            # Credentials apply only to the first GitHub API request.
            authenticated = False
    raise AssertionError("redirect bound exceeded")


def source_guard():
    def git(*args):
        return subprocess.run(["git", *args], check=True, capture_output=True,
                              timeout=10).stdout
    assert git("rev-parse", "HEAD").decode().strip() == os.environ["GITHUB_SHA"]
    assert git("status", "--porcelain=v1", "--untracked-files=all") == b""
    files = {}
    for path in ("scripts/gitcore-artifact-reader.py",
                 ".github/workflows/gitcore-artifact-reader.yml"):
        data = Path(path).read_bytes()
        assert data == git("show", "HEAD:" + path), "reader source bytes changed"
        files[path] = {"bytes": len(data), "sha256": sha256(data)}
    return files


receipts = []
try:
    reader_files = source_guard()
    for artifact_id, name, platform, length, expected in ARTIFACTS:
        metadata = json.loads(download(api + "/actions/artifacts/" + str(artifact_id), 65536, True))
        assert metadata["id"] == artifact_id and metadata["name"] == name
        assert metadata["size_in_bytes"] == length and metadata["digest"] == "sha256:" + expected
        assert not metadata["expired"]
        assert metadata["workflow_run"]["id"] == RUN
        assert metadata["workflow_run"]["head_sha"] == DRIVER
        data = download(api + "/actions/artifacts/" + str(artifact_id) + "/zip", length, True)
        assert len(data) == length and sha256(data) == expected, "archive identity mismatch"
        (root / (platform + ".zip")).write_bytes(data)
        contents = {}
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            members = archive.infolist()
            assert 1 <= len(members) <= 32
            assert sum(item.file_size for item in members) <= 4 * 1024 * 1024
            for item in members:
                name = item.filename
                assert name.endswith(".json") and "/" not in name and "\\" not in name
                assert not name.startswith(".") and name not in contents
                mode = item.external_attr >> 16
                assert not stat.S_ISLNK(mode) and not item.is_dir()
                assert 0 < item.file_size <= 1024 * 1024
                value = archive.read(item)
                assert len(value) == item.file_size
                contents[name] = value
        manifest = json.loads(contents["manifest.json"])["files"]
        assert len({entry["path"] for entry in manifest}) == len(manifest)
        assert set(contents) == {"manifest.json"} | {entry["path"] for entry in manifest}
        for entry in manifest:
            value = contents[entry["path"]]
            assert len(value) == entry["bytes"] and sha256(value) == entry["sha256"]
        provenance = json.loads(contents["provenance.json"])
        results = json.loads(contents["results.json"])
        commands = json.loads(contents["commands.json"])
        assert provenance["source"] == SOURCE == results["source"]
        assert provenance["driver"] == DRIVER and str(provenance["run"]) == str(RUN)
        assert provenance["platform"] == platform and provenance["phase"] == results["phase"] == "candidate"
        assert [case["name"] for case in results["cases"]] == CASE_NAMES
        assert all(case["status"] in ("passed", "failed") for case in results["cases"])
        assert isinstance(commands, list) and len(commands) < 1000
        failures = []
        for case in results["cases"]:
            start, end = case["commands"]
            assert 0 <= start <= end <= len(commands)
            if case["status"] == "failed":
                failures.append({"case": case, "commands": commands[start:end]})
        receipt = {"artifact": metadata, "archiveSha256": sha256(data), "source": SOURCE,
                   "driver": DRIVER, "run": RUN, "platform": platform,
                   "provenance": provenance, "results": results, "failures": failures,
                   "files": [{"path": path, "bytes": len(value), "sha256": sha256(value)}
                             for path, value in sorted(contents.items())]}
        receipts.append(receipt)
        (root / (platform + "-receipt.json")).write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps({"platform": platform, "originalResults": results, "failureCommands": failures}))
    assert source_guard() == reader_files
    final = {"reader": os.environ["GITHUB_SHA"], "readerFiles": reader_files,
             "retrievedAtUnix": time.time(), "artifactsVerified": len(receipts),
             "qualification": "Reader success verifies retained bytes only. Original Windows failures remain failures; no tests were rerun."}
    (root / "reader.json").write_text(json.dumps(final, indent=2) + "\n")
    print(json.dumps(final))
except Exception as error:
    (root / "reader-error.json").write_text(json.dumps({"type": type(error).__name__, "message": str(error)}) + "\n")
    raise
