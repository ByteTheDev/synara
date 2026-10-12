"""Read the two fixed PR 1804 validation artifacts; no tests, installs or source writes."""
import difflib
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPOSITORY = "Emanuele-web04/synara"
RUN = 38204298347
DRIVER = "648894897e8ed31169a389049256e4d352b37666"
DRIVER_FILES = [{"path":".github/workflows/pr1804-goal-retry-validation.yml","sha":"5db61b8245d3ae53ec37ce7149d0c2aaf56d8e5f","bytes":2324},{"path":"scripts/pr1804-goal-retry-validation/README.md","sha":"1a814d5181ebea03c4485b531a118bc90466cbcc","bytes":4129},{"path":"scripts/pr1804-goal-retry-validation/pins.json","sha":"e4177dbce1fd6dddbd15d5353fb5e4aff49e990f","bytes":3049},{"path":"scripts/pr1804-goal-retry-validation/runner.mjs","sha":"43572367634b2ee018ea2c4c446ee4404a027c7c","bytes":16693},{"path":"scripts/pr1804-goal-retry-validation/owned-command-observer.mjs","sha":"e484cd5e71d42c7d17fc71fcce4d5a0d44a11f33","bytes":4451}]
ARTIFACTS = [{"variant":"before","id":11726970629,"name":"pr1804-goal-retry-before-38204298347-1","bytes":34887,"sha256":"e156f516a0b88cdf5793b9f5888f259ecbbf2819d82ab27a3003756579ae9871","files":14},{"variant":"after","id":11726557541,"name":"pr1804-goal-retry-after-38204298347-1","bytes":320524,"sha256":"1813787ddf9067b04f90777046c76312c8ae000c29acc337fd392a47f404ad36","files":43}]
INPUT_PATH = "scripts/pr1804-goal-retry-validation/pins.json"
READER_PATHS = [".github/workflows/pr1804-goal-retry-artifact-reader.yml",
                "scripts/pr1804-goal-retry-artifact-reader.py"]
sha256 = lambda data: hashlib.sha256(data).hexdigest()
git_blob = lambda data: hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
assert os.environ["GITHUB_REPOSITORY"] == REPOSITORY
root = Path(os.environ["RUNNER_TEMP"]) / "pr1804-goal-retry-artifact-reader"
root.mkdir(exist_ok=False)
token = os.environ.pop("GH_TOKEN")
api = "https://api.github.com/repos/" + REPOSITORY
headers = {"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
           "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "synara-goal-retry-artifact-reader"}

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


def git(*args):
    return subprocess.run(["git", *args], check=True, capture_output=True, timeout=10).stdout

def source_guard():
    assert git("rev-parse", "HEAD").decode().strip() == os.environ["GITHUB_SHA"]
    assert git("status", "--porcelain=v1", "--untracked-files=all") == b""
    git("merge-base", "--is-ancestor", DRIVER, "HEAD")
    files = {}
    expected = {row["path"]: row for row in DRIVER_FILES}
    for name in READER_PATHS + sorted(expected):
        target = Path(name)
        assert target.is_file() and not target.is_symlink()
        value = target.read_bytes()
        assert value == git("show", "HEAD:" + name), "reader/source bytes changed"
        if name in expected:
            assert len(value) == expected[name]["bytes"] and git_blob(value) == expected[name]["sha"]
        files[name] = {"bytes": len(value), "sha256": sha256(value), "gitBlob": git_blob(value)}
    return files

def safe_name(name):
    assert isinstance(name, str) and name and "\\" not in name and "\0" not in name
    assert not name.startswith("/") and str(PurePosixPath(name)) == name
    assert all(part and not part.startswith(".") and ":" not in part for part in name.split("/"))
    return name

def complete_root(result, code):
    assert result["actualRootExitObserved"] is True and result["actualRootExit"] == code
    assert result["actualRootSignal"] is None and result["closeObserved"] is True
    assert result["closeCode"] == code and result["closeSignal"] is None
    assert result["deadline"] is False and result["capped"] is False
    assert result["forcedOutputCutoff"] is False
    assert result["processErrors"] == [] and result["outputErrors"] == []
    assert result["observerStatus"] == code

def emit(label, value, limit=262144):
    encoded = json.dumps(value, separators=(",", ":"))
    assert len(encoded.encode()) <= limit, "bounded log record exceeded"
    print("SYNARA_PR1804_" + label + " " + encoded, flush=True)

def snapshot_target(name, feature):
    fixed = {"tests-log-snapshot.json": "tests.log", "vitest-report-snapshot.json": "vitest.json"}
    for phase in ["types", "format", "format-copy", "lint", "sync-fs"]:
        fixed[phase + "-log-snapshot.json"] = phase + ".log"
    for row in feature:
        fixed["formatted-" + row["path"].replace("/", "_") + "-snapshot.json"] = "formatted-source/" + row["path"]
    assert name in fixed, "unknown snapshot receipt"
    return fixed[name]

def inspect(spec, pins, reader_files):
    variant = spec["variant"]
    source = pins["before"] if variant == "before" else pins["candidate"]
    metadata = json.loads(download(api + "/actions/artifacts/" + str(spec["id"]), 65536, True))
    assert metadata["id"] == spec["id"] and metadata["name"] == spec["name"]
    assert metadata["size_in_bytes"] == spec["bytes"] and metadata["digest"] == "sha256:" + spec["sha256"]
    assert metadata["expired"] is False
    assert metadata["workflow_run"]["id"] == RUN and metadata["workflow_run"]["head_sha"] == DRIVER
    data = download(api + "/actions/artifacts/" + str(spec["id"]) + "/zip", spec["bytes"], True)
    directory = root / variant
    directory.mkdir(exist_ok=False)
    (directory / "original.zip").write_bytes(data)
    assert len(data) == spec["bytes"] and sha256(data) == spec["sha256"]
    contents = {}
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        members = archive.infolist()
        assert len(members) == spec["files"] <= 100
        assert sum(item.file_size for item in members) <= 32 * 1024 * 1024
        for item in members:
            name = safe_name(item.filename)
            assert name not in contents and not item.is_dir()
            mode = stat.S_IFMT(item.external_attr >> 16)
            assert mode in (0, stat.S_IFREG), "non-regular ZIP member"
            assert item.flag_bits & 1 == 0 and 0 <= item.file_size <= 8 * 1024 * 1024
            value = archive.read(item)  # zipfile checks CRC as each bounded member is read.
            assert len(value) == item.file_size
            contents[name] = value
    manifest = json.loads(contents["manifest.json"])
    assert manifest["source"] == source and manifest["driverHead"] == DRIVER and manifest["variant"] == variant
    rows = manifest["files"]
    assert len(rows) == len({row["path"] for row in rows}) == len(contents) - 1
    assert {row["path"] for row in rows} == set(contents) - {"manifest.json"}
    for row in rows:
        value = contents[safe_name(row["path"])]
        assert len(value) == row["bytes"] and sha256(value) == row["sha256"] and git_blob(value) == row["gitBlob"]
    provenance = json.loads(contents["provenance.json"])
    assert provenance["variant"] == variant and provenance["source"] == source
    assert provenance["candidate"] == pins["candidate"] and provenance["driverHead"] == DRIVER
    actual_driver = {row["path"]: {key: row[key] for key in ("bytes", "sha256", "gitBlob")}
                     for row in provenance["driver"]}
    expected_driver = {row["path"]: reader_files[row["path"]] for row in DRIVER_FILES}
    assert actual_driver == expected_driver
    proofs = []
    snapshots = []
    for name, value in contents.items():
        if name.startswith("source-") and name.endswith(".json"):
            proof = json.loads(value)
            assert proof["head"] == source["sha"] and proof["tree"] == source["tree"]
            assert proof["trackedFiles"] == source["files"] and proof["rawBytesAndModesVerified"] is True
            assert proof["exactOverlays"] == [], "No test or production overlays were permitted"
            proofs.append(proof)
        if name.endswith("-snapshot.json"):
            receipt = json.loads(value)
            target = snapshot_target(name, pins["feature"])
            captured = contents[target]
            assert not receipt.get("missing", False) and receipt["capped"] is False
            assert receipt["observedSizeChange"] is False and receipt["shortRead"] is False
            assert receipt["observedInitialBytes"] == receipt["observedEndBytes"] == receipt["capturedBytes"] == len(captured)
            assert receipt["sha256"] == sha256(captured) and receipt["gitBlob"] == git_blob(captured)
            assert isinstance(receipt["captureStartedAt"], str) and isinstance(receipt["captureCompletedAt"], str)
            snapshots.append({"path": target, "sha256": receipt["sha256"], "gitBlob": receipt["gitBlob"]})
    assert len(proofs) == (15 if variant == "after" else 5)
    assert len({proof["listingSha256"] for proof in proofs}) == 1
    assert len(snapshots) == (9 if variant == "after" else 2)
    report = json.loads(contents["vitest.json"])
    verification = json.loads(contents["test-verification.json"])
    result = json.loads(contents["result.json"])
    assert result["variant"] == variant and result["source"] == source
    assert result["testVerification"] == verification and result["exitCode"] == 1
    assert result["expectedBaselineFailureNeverConvertedToJobSuccess"] is True
    assert result["descendantExitProven"] is False
    expected_totals = {
        "before": {"passed": 1, "failed": 1, "pending": 479, "todo": 0},
        "after": {"passed": 481, "failed": 0, "pending": 0, "todo": 0},
    }[variant]
    assert verification["totals"] == expected_totals
    assert {name: report[key] for name, key in
            [("passed", "numPassedTests"), ("failed", "numFailedTests"), ("pending", "numPendingTests"), ("todo", "numTodoTests")]} == expected_totals
    assertions = [entry for suite in report["testResults"] for entry in suite["assertionResults"]]
    selected_names = pins["goalNames"] if variant == "before" else pins["originalNames"] + pins["goalNames"]
    selected = []
    for title in selected_names:
        matches = [entry for entry in assertions if entry["title"] == title]
        assert len(matches) == 1 and matches[0]["status"] in ("passed", "failed")
        entry = matches[0]
        selected.append({"title": title, "status": entry["status"], "failureMessages": entry.get("failureMessages", [])})
    assert selected == verification["selected"]
    expected_codes = {"tests": 1} if variant != "after" else {
        "tests": 0, "types": 0, "format": 1, "format-copy": 0, "lint": 0, "sync-fs": 0}
    assert {row["name"] for row in result["phases"]} == set(expected_codes)
    for phase in result["phases"]:
        complete_root(phase["result"], expected_codes[phase["name"]])
        assert phase["result"] == json.loads(contents[phase["name"] + "-process.json"])
    if variant == "after":
        assert report["success"] is True
        assert all(entry["status"] == "passed" for entry in assertions)
        assert result["verificationPassed"] is False and result["sourceValidationPassed"] is False
        assert len(result["failures"]) == 1 and result["failures"][0]["phase"] == "format-verification"
    else:
        assert report["success"] is False and result["verificationPassed"] is True
        assert result["failures"] == [] and result["sourceValidationPassed"] is False
        assert [entry["status"] for entry in selected] == ["failed", "passed"]
    changed = []
    if variant == "after":
        total_diff_bytes = 0
        for row in pins["feature"]:
            name = "formatted-source/" + row["path"]
            formatted = contents[name]
            original = Path(row["path"]).read_bytes()
            assert len(original) == row["bytes"] and git_blob(original) == row["sha"]
            if formatted == original:
                continue
            entry = {"path": row["path"], "beforeBlob": row["sha"], "bytes": len(formatted),
                     "sha256": sha256(formatted), "gitBlob": git_blob(formatted)}
            changed.append(entry)
            target = directory / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(formatted)
            patch = "".join(difflib.unified_diff(
                original.decode("utf-8").splitlines(keepends=True),
                formatted.decode("utf-8").splitlines(keepends=True),
                fromfile="a/" + row["path"], tofile="b/" + row["path"], n=3))
            assert patch, "Changed formatter output must produce a nonempty patch"
            patch_bytes = patch.encode("utf-8")
            total_diff_bytes += len(patch_bytes)
            assert total_diff_bytes <= 131072, "Formatter patch export exceeds bound"
            entry["patchBytes"] = len(patch_bytes)
            entry["patchSha256"] = sha256(patch_bytes)
            (target.parent / (target.name + ".patch")).write_bytes(patch_bytes)
            emit("FORMATTED_DIFF", {**entry, "patch": patch})
        assert changed, "formatter failure yielded no changed copies"
        emit("FORMAT_LOG", {"variant": variant, "log": contents["format.log"].decode()})
    receipt = {"variant": variant, "artifact": metadata, "zipSha256": sha256(data),
               "driver": DRIVER, "source": source, "totals": expected_totals, "selected": selected,
               "phases": result["phases"], "originalFailures": result["failures"],
               "formattedChanges": changed, "sourceGuardsVerified": len(proofs),
               "snapshotsVerified": len(snapshots), "retrievedAtUnix": time.time(),
               "files": [{"path": name, "bytes": len(value), "sha256": sha256(value), "gitBlob": git_blob(value)}
                         for name, value in sorted(contents.items())],
               "qualification": "Read-only verification of prior fixed ZIP bytes and failed job exits. No test rerun, source edit, new native execution, causal inference or publication."}
    (directory / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    emit("OBSERVED", {key: receipt[key] for key in ("variant", "zipSha256", "totals", "selected",
                                                   "originalFailures", "formattedChanges",
                                                   "sourceGuardsVerified", "snapshotsVerified")})
    return receipt

try:
    reader_files = source_guard()
    pins = json.loads(Path(INPUT_PATH).read_bytes())
    assert pins["candidate"]["sha"] == "beb3f13af6377783ad6b32f47c29976d682cc6b9"
    assert pins["before"]["sha"] == "b7ce9417bda2d2b2da644cf43e5865a67a5f7a61"
    run = json.loads(download(api + "/actions/runs/" + str(RUN), 128 * 1024, True))
    assert run["id"] == RUN and run["head_sha"] == DRIVER
    assert run["status"] == "completed" and run["conclusion"] == "failure"
    receipts = [inspect(spec, pins, reader_files) for spec in ARTIFACTS]
    assert source_guard() == reader_files
    (root / "receipt.json").write_text(json.dumps({
        "reader": os.environ["GITHUB_SHA"], "readerFiles": reader_files,
        "run": RUN, "driver": DRIVER, "readOnly": True,
        "artifacts": [{key: row[key] for key in ("variant", "zipSha256", "totals", "formattedChanges")}
                      for row in receipts],
        "noSourceMutationOrTestExecution": True,
    }, indent=2) + "\n")
    emit("READER_COMPLETE", {"reader": os.environ["GITHUB_SHA"], "run": RUN, "artifacts": len(receipts),
                             "sourceAndArchiveVerificationPassed": True, "priorJobConclusionsUnchanged": True})
except Exception as error:
    (root / "reader-error.json").write_text(json.dumps({"type": type(error).__name__, "message": str(error)}) + "\n")
    raise
