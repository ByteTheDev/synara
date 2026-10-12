"""Verify retained #1847 artifacts only; do not rerun or relabel their tests."""

import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

PINS_PATH = "scripts/gitcore-final-artifact-reader/pins.json"
READER_PATHS = [
    ".github/workflows/gitcore-final-artifact-reader.yml",
    "scripts/gitcore-final-artifact-reader/reader.py",
    PINS_PATH,
]
pins = json.loads(Path(PINS_PATH).read_text())
REPOSITORY = pins["repository"]
assert os.environ["GITHUB_REPOSITORY"] == REPOSITORY
root = Path(os.environ["RUNNER_TEMP"]) / "pr1847-final-artifact-reader"
root.mkdir(exist_ok=False)
token = os.environ.pop("GH_TOKEN")
api = "https://api.github.com/repos/" + REPOSITORY
headers = {"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
           "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "synara-retained-artifact-reader"}
sha256 = lambda data: hashlib.sha256(data).hexdigest()
git_blob = lambda data: hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()

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
        return subprocess.run(["git", *args], check=True, capture_output=True, timeout=10).stdout
    assert git("rev-parse", "HEAD").decode().strip() == os.environ["GITHUB_SHA"]
    assert git("status", "--porcelain=v1", "--untracked-files=all") == b""
    files = []
    for name in READER_PATHS:
        data = Path(name).read_bytes()
        assert data == git("show", "HEAD:" + name), "reader source changed"
        files.append({"path": name, "bytes": len(data), "sha256": sha256(data),
                      "gitBlob": git_blob(data)})
    return files


def read_archive(data):
    contents = {}
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        members = archive.infolist()
        assert 1 <= len(members) <= 32
        assert sum(item.file_size for item in members) <= 4 * 1024 * 1024
        for item in members:
            name = item.filename
            assert re.fullmatch(r"[A-Za-z0-9_-]+\.(json|log)", name), "unexpected member path"
            assert name not in contents and not item.is_dir()
            mode = item.external_attr >> 16
            assert not stat.S_ISLNK(mode)
            assert stat.S_IFMT(mode) in (0, stat.S_IFREG)
            assert 0 < item.file_size <= 2 * 1024 * 1024
            value = archive.read(item)  # Includes actual CRC verification.
            assert len(value) == item.file_size
            contents[name] = value
    return contents


def actual_exit(observed, code):
    assert observed["rootExit"]["code"] == code and observed["rootExit"]["signal"] is None
    assert observed["close"]["code"] == code and observed["close"]["signal"] is None
    assert observed["processErrors"] == [] and observed["deadlineReachedAt"] is None
    assert observed["outputCutoff"] is None and observed["signalAttempts"] == []


def verify_format(contents, source):
    assert set(contents) == {"proposal.json"}
    proposal = json.loads(contents["proposal.json"])
    assert proposal["source"] == source["head"] and proposal["tree"] == source["tree"]
    assert proposal["driver"] == pins["driver"] and proposal["complete"] is True
    assert "error" not in proposal
    actual_exit(proposal["formatter"], 0)
    assert 1 <= len(proposal["commands"]) <= 50
    for command in proposal["commands"]:
        actual_exit(command, 0)
    expected = {
        "apps/server/src/git/Layers/GitCore.ts": source["production"],
        "apps/server/src/git/Layers/GitCore.test.ts": pins["sourceBlobs"]["apps/server/src/git/Layers/GitCore.test.ts"],
    }
    assert {row["path"] for row in proposal["files"]} == set(expected)
    assert len(proposal["files"]) == 2
    for row in proposal["files"]:
        assert row["diffExit"] == 0 and row["patch"] == ""
        for field in ("bytes", "sha256", "gitBlob"):
            assert row["before"][field] == row["after"][field]
        assert row["before"]["gitBlob"] == expected[row["path"]]
    return {"formatProposal": proposal, "qualification": "Actual canonical formatter produced no byte changes; server typecheck result remains the separately recorded workflow step."}


def verify_tests(contents, spec, source):
    assert set(contents) == {"command.json", "exit.json", "provenance.json", "results.json", "verified.json", "vitest.log"}
    verified = json.loads(contents["verified.json"])
    provenance = json.loads(contents["provenance.json"])
    report = json.loads(contents["results.json"])
    observed = json.loads(contents["exit.json"])
    command = json.loads(contents["command.json"])
    assert verified["source"] == provenance["source"] == source["head"]
    assert verified["tree"] == provenance["tree"] == source["tree"]
    assert verified["driver"] == pins["driver"] == provenance["driver"]["head"]
    assert provenance["platform"] == spec["platform"]
    assert provenance["exit"] == observed
    entries = verified["artifacts"]
    assert len(entries) == 5 and len({row["name"] for row in entries}) == 5
    assert {row["name"] for row in entries} == set(contents) - {"verified.json"}
    for row in entries:
        value = contents[row["name"]]
        assert len(value) == row["bytes"] and sha256(value) == row["sha256"]
    expected_files = dict(pins["sourceBlobs"])
    expected_files["apps/server/src/git/Layers/GitCore.ts"] = source["production"]
    for stage in ("before", "after"):
        guard = provenance[stage]
        assert guard["head"] == source["head"] and guard["tree"] == source["tree"]
        assert guard["trackedSourceClean"] is True
        assert len(guard["files"]) == 5
        assert {row["path"]: row["gitBlob"] for row in guard["files"]} == expected_files
        fixture = next(row for row in guard["files"] if row["path"].endswith("GitCore.test.ts"))
        assert fixture["sha256"] == pins["fixtureSha256"] and fixture["bytes"] == 192927
    assert provenance["before"] == provenance["after"]
    expected_driver = {row["path"]: row for row in pins["driverFiles"]}
    driver_files = provenance["driver"]["files"]
    expected_driver_paths = set(expected_driver)
    if spec["kind"] == "native":
        expected_driver_paths -= {".github/workflows/gitcore-snapshot-control.yml",
                                  "scripts/gitcore-native-evidence/snapshot-control.mjs"}
    assert len(driver_files) == len(expected_driver_paths)
    assert {row["path"] for row in driver_files} == expected_driver_paths
    for row in driver_files:
        assert row == expected_driver[row["path"]]
    snapshot = provenance["reportSnapshot"]
    assert snapshot["bytes"] == len(contents["results.json"])
    assert snapshot["sha256"] == sha256(contents["results.json"])
    assert snapshot["closeObserved"] is True and snapshot["outputCutoff"] is None
    assert snapshot["rootExit"] == observed["rootExit"]
    assert command["executable"] == "bun" and command["cwd"] == "apps/server"
    assert command["timeoutMs"] == 1200000
    args = command["args"]
    expected_prefix = ["run", "test", "src/git/Layers/GitCore.test.ts"]
    if spec["kind"] == "control":
        expected_prefix += ["-t", pins["selected"]]
    assert args[:-1] == expected_prefix + ["--reporter=default", "--reporter=json"]
    assert args[-1].startswith("--outputFile=") and args[-1].replace("\\", "/").endswith("/results.json")
    rows = [entry for suite in report["testResults"] for entry in suite["assertionResults"]]
    assert len(report["testResults"]) == 1 and len(rows) == 151 and report["numTotalTests"] == 151
    assert report["numTodoTests"] == 0
    failed_before = spec["kind"] == "control" and spec["side"] == "before"
    actual_exit(observed, 1 if failed_before else 0)
    if spec["kind"] == "native":
        assert provenance["expectedCases"] == 151
        assert report["numPassedTests"] == 151 and report["numFailedTests"] == report["numPendingTests"] == 0
        assert all(row["status"] == "passed" for row in rows)
        selected = rows
    else:
        assert provenance["target"] == spec["side"] and provenance["totalCases"] == 151
        selected = [row for row in rows if re.search(pins["selected"], row["fullName"])]
        unselected = [row for row in rows if not re.search(pins["selected"], row["fullName"])]
        assert len(selected) == 3 and len(unselected) == 148
        assert all(row["status"] in ("pending", "skipped") for row in unselected)
        assert report["numPendingTests"] == 148
        assert report["numPassedTests"] == (0 if failed_before else 3)
        assert report["numFailedTests"] == (3 if failed_before else 0)
        assert all(row["status"] == ("failed" if failed_before else "passed") for row in selected)
    assert report["success"] is (not failed_before)
    assert verified["errors"] == provenance["errors"]
    assert bool(verified["errors"]) == failed_before
    return {"source": source, "platform": spec["platform"], "kind": spec["kind"], "side": spec["side"],
            "passed": report["numPassedTests"], "failed": report["numFailedTests"],
            "unselected": report["numPendingTests"], "actualExit": observed,
            "sourceGuards": [provenance["before"], provenance["after"]],
            "driver": provenance["driver"], "reportSnapshot": snapshot,
            "selectedOutcomes": [{"name": row["fullName"], "status": row["status"],
                                  "failureMessages": row["failureMessages"]} for row in selected],
            "originalErrors": verified["errors"]}


receipts = []
try:
    reader_files = source_guard()
    for spec in pins["artifacts"]:
        artifact_id = spec["id"]
        metadata = json.loads(download(api + "/actions/artifacts/" + str(artifact_id), 65536, True))
        for key in ("id", "name"):
            assert metadata[key] == spec[key]
        assert metadata["size_in_bytes"] == spec["bytes"]
        assert metadata["digest"] == "sha256:" + spec["sha256"] and not metadata["expired"]
        assert metadata["workflow_run"]["id"] == spec["run"]
        assert metadata["workflow_run"]["head_sha"] == pins["driver"]
        data = download(api + "/actions/artifacts/" + str(artifact_id) + "/zip", spec["bytes"], True)
        assert len(data) == spec["bytes"] and sha256(data) == spec["sha256"]
        (root / (str(artifact_id) + ".zip")).write_bytes(data)
        contents = read_archive(data)
        source = pins["sources"][spec["side"]]
        result = verify_format(contents, source) if spec["kind"] == "format" else verify_tests(contents, spec, source)
        receipt = {"artifact": metadata, "archiveBytes": len(data), "archiveSha256": sha256(data),
                   "result": result, "members": [{"path": name, "bytes": len(value),
                       "sha256": sha256(value), "gitBlob": git_blob(value)} for name, value in sorted(contents.items())]}
        receipts.append(receipt)
        (root / (str(artifact_id) + "-receipt.json")).write_text(json.dumps(receipt, indent=2) + "\n")
        encoded = base64.b64encode(data).decode("ascii")
        chunks = [encoded[index:index + 12000] for index in range(0, len(encoded), 12000)]
        for index, chunk in enumerate(chunks):
            print("RETAINED_ZIP_CHUNK " + json.dumps({"id": artifact_id, "index": index, "count": len(chunks),
                "bytes": len(data), "sha256": sha256(data), "data": chunk}))
        print("RETAINED_RESULT " + json.dumps({"id": artifact_id, "kind": spec["kind"], "side": spec["side"],
            "passed": result.get("passed"), "failed": result.get("failed"), "unselected": result.get("unselected"),
            "members": receipt["members"], "result": result}))
    assert source_guard() == reader_files
    final = {"reader": os.environ["GITHUB_SHA"], "readerFiles": reader_files,
             "retrievedAtUnix": time.time(), "artifactsVerified": len(receipts),
             "qualification": "Reader success verifies the five retained ZIPs and their fixed reports only. No tests were rerun. The rejected pre-fix refusal proposal remains three actual failures; its 148 unselected cases are not passes. Native Windows/Linux each separately ran all 151 cases."}
    (root / "reader.json").write_text(json.dumps(final, indent=2) + "\n")
    print("RETAINED_READER " + json.dumps(final))
except Exception as error:
    (root / "reader-error.json").write_text(json.dumps({"type": type(error).__name__, "message": str(error)}) + "\n")
    raise
