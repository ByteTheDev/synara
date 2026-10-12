"""Inspect four exact completed PR 1863 artifacts; preserve every original failed outcome."""
import base64
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
RUN = 38205787703
DRIVER = "cebd11121aee4c4ef4a00e4a1c769e84a33b128f"
DRIVER_FILES = [{"path":".github/workflows/pr1863-prefix-proof.yml","sha":"14ba12017e7bfa25946e07fa429642fe89401c77","bytes":2350},{"path":"scripts/pr1863-prefix-proof/README.md","sha":"7c395ec96eec6b3c7b3358bed1bc36cc4fe587db","bytes":4420},{"path":"scripts/pr1863-prefix-proof/pins.json","sha":"4376d812971ea76de85651be66a1e71505fc762f","bytes":5247},{"path":"scripts/pr1863-prefix-proof/probe.ts","sha":"2d69ed1257146f95e325ee76c0d9cb27afeaddbe","bytes":12511},{"path":"scripts/pr1863-prefix-proof/runner.mjs","sha":"c61ad0edde975d08104369fef8ade6ba9ca751dc","bytes":17727},{"path":"scripts/pr1863-prefix-proof/owned-command-observer.mjs","sha":"e484cd5e71d42c7d17fc71fcce4d5a0d44a11f33","bytes":4451}]
ARTIFACTS = [{"variant":"after","platform":"linux","id":11727531132,"name":"pr1863-prefix-ubuntu-24.04-after-38205787703-1","bytes":32838,"sha256":"aec4c11a3d75a45f8ab9c28aed2853fcaf189bb94b8ac43137df5b96a8d02cba","job":114668858680,"jobConclusion":"success"},{"variant":"after","platform":"win32","id":11727371802,"name":"pr1863-prefix-windows-latest-after-38205787703-1","bytes":31656,"sha256":"9ac144bd22a62f6dc9970c7c6cd5c6c262958c3b6a5ee420bf5ed1426da477fc","job":114668858755,"jobConclusion":"failure"},{"variant":"before","platform":"win32","id":11727009032,"name":"pr1863-prefix-windows-latest-before-38205787703-1","bytes":38488,"sha256":"3b5b453465b3207dec0a29538787fee2dfb3038d7b9b0ee713ceffe56a4f70d8","job":114668858639,"jobConclusion":"failure"},{"variant":"before","platform":"linux","id":11726664912,"name":"pr1863-prefix-ubuntu-24.04-before-38205787703-1","bytes":40422,"sha256":"c8e3615d32789365aab19b6594ac6e95a329d8402de665e0395826b9153cad42","job":114668858527,"jobConclusion":"failure"}]
INPUT_PATH = "scripts/pr1863-prefix-proof/pins.json"
READER_PATHS = [".github/workflows/pr1863-prefix-artifact-reader.yml",
                "scripts/pr1863-prefix-artifact-reader.py"]
sha256 = lambda data: hashlib.sha256(data).hexdigest()
git_blob = lambda data: hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
assert os.environ["GITHUB_REPOSITORY"] == REPOSITORY
root = Path(os.environ["RUNNER_TEMP"]) / "pr1863-prefix-artifact-reader"
root.mkdir(exist_ok=False)
token = os.environ.pop("GH_TOKEN")
api = "https://api.github.com/repos/" + REPOSITORY
headers = {"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
           "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "synara-prefix-artifact-reader"}

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
    print("SYNARA_PR1863_READER_" + label + " " + encoded, flush=True)

def inspect(spec, pins, reader_files, jobs):
    variant, platform = spec["variant"], spec["platform"]
    source = pins[variant]
    job = next(row for row in jobs["jobs"] if row["id"] == spec["job"])
    assert job["status"] == "completed" and job["conclusion"] == spec["jobConclusion"]
    assert job["conclusion"] == ("success" if platform == "linux" and variant == "after" else "failure")
    metadata = json.loads(download(api + "/actions/artifacts/" + str(spec["id"]), 65536, True))
    assert metadata["id"] == spec["id"] and metadata["name"] == spec["name"]
    assert metadata["size_in_bytes"] == spec["bytes"] and metadata["digest"] == "sha256:" + spec["sha256"]
    assert metadata["expired"] is False
    assert metadata["workflow_run"]["id"] == RUN and metadata["workflow_run"]["head_sha"] == DRIVER
    data = download(api + "/actions/artifacts/" + str(spec["id"]) + "/zip", spec["bytes"], True)
    directory = root / (platform + "-" + variant)
    directory.mkdir(exist_ok=False)
    (directory / "original.zip").write_bytes(data)
    assert len(data) == spec["bytes"] and sha256(data) == spec["sha256"]
    contents = {}
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        members = archive.infolist()
        assert 1 <= len(members) <= 32
        assert sum(item.file_size for item in members) <= 32 * 1024 * 1024
        for item in members:
            name = safe_name(item.filename)
            assert name not in contents and not item.is_dir() and "/" not in name
            mode = stat.S_IFMT(item.external_attr >> 16)
            assert mode in (0, stat.S_IFREG), "non-regular ZIP member"
            assert item.flag_bits & 1 == 0 and 0 <= item.file_size <= 16 * 1024 * 1024
            value = archive.read(item)
            assert len(value) == item.file_size  # zipfile also validates every original CRC.
            contents[name] = value
    expected_names = {
        "manifest.json", "provenance.json", "result.json", "ui-payload.json",
        "source-initial.json", "source-tests-ready.json", "source-restored.json",
        "source-before-tests.json", "source-after-tests.json",
        "source-before-probe.json", "source-after-probe.json",
        "tests.process.json", "probe.process.json", "probe-verification.json",
    }
    for phase in ("tests", "probe"):
        for suffix in ("log", "json"):
            expected_names.update({phase + "." + suffix, phase + "." + suffix + ".snapshot.json"})
    if not (platform == "win32" and variant == "after"):
        expected_names.add("tests-verification.json")
    assert set(contents) == expected_names, "unexpected or missing fixed evidence files"
    manifest = json.loads(contents["manifest.json"])
    assert manifest["schemaVersion"] == 1 and manifest["source"] == source
    assert manifest["driverHead"] == DRIVER and manifest["platform"] == platform
    rows = manifest["files"]
    assert len(rows) == len({row["path"] for row in rows}) == len(contents) - 1
    assert {row["path"] for row in rows} == set(contents) - {"manifest.json"}
    for row in rows:
        value = contents[safe_name(row["path"])]
        assert len(value) == row["bytes"] and sha256(value) == row["sha256"] and git_blob(value) == row["gitBlob"]
    provenance = json.loads(contents["provenance.json"])
    assert provenance["variant"] == variant and provenance["source"] == source and provenance["platform"] == platform
    assert provenance["author"] == pins["after"] and provenance["driverHead"] == DRIVER
    actual_driver = {row["path"]: {key: row[key] for key in ("bytes", "sha256", "gitBlob")}
                     for row in provenance["driver"]}
    assert len(actual_driver) == len(provenance["driver"]) == len(DRIVER_FILES)
    assert actual_driver == {row["path"]: reader_files[row["path"]] for row in DRIVER_FILES}
    proofs, snapshots = [], []
    expected_stages = {"initial", "tests-ready", "before-tests", "after-tests", "before-probe", "after-probe", "restored"}
    for name, value in contents.items():
        if name.startswith("source-") and name.endswith(".json"):
            proof = json.loads(value)
            assert proof["head"] == source["sha"] and proof["tree"] == source["tree"]
            assert proof["trackedFiles"] == source["files"] and proof["rawBytesAndIndexModesVerified"] is True
            assert proof["filesystemExecutableBitsChecked"] is (platform != "win32")
            stage = proof["stage"]
            assert stage in expected_stages
            overlays = ({row["path"]: row["after"] for row in pins["feature"] if row["path"] in pins["testPaths"]}
                        if variant == "before" and stage not in ("initial", "restored") else {})
            assert {row["path"]: row["gitBlob"] for row in proof["overlays"]} == overlays
            assert len(proof["overlays"]) == len(overlays)
            extras = {pins["probeDestination"]: pins["probeBlob"]} if stage in ("before-probe", "after-probe") else {}
            assert {row["path"]: row["gitBlob"] for row in proof["extras"]} == extras
            assert len(proof["extras"]) == len(extras)
            assert all(name == ".pr-driver/" or name in extras for name in proof["untracked"])
            proofs.append(proof)
        if name.endswith(".snapshot.json"):
            receipt = json.loads(value)
            target = name.removesuffix(".snapshot.json")
            captured = contents[target]
            assert receipt.get("missing", False) is False
            assert receipt["capped"] is False and receipt["shortRead"] is False and receipt["changed"] is False
            assert receipt["initialBytes"] == receipt["endBytes"] == receipt["capturedBytes"] == len(captured)
            assert receipt["capturedBytes"] <= receipt["capBytes"] <= 16 * 1024 * 1024
            assert receipt["sha256"] == sha256(captured) and receipt["gitBlob"] == git_blob(captured)
            assert isinstance(receipt["startedAt"], str) and isinstance(receipt["completedAt"], str)
            snapshots.append({"path": target, "sha256": sha256(captured), "gitBlob": git_blob(captured)})
    assert len(proofs) == 7 and {row["stage"] for row in proofs} == expected_stages
    assert len({row["listingSha256"] for row in proofs}) == 1 and len(snapshots) == 4
    result = json.loads(contents["result.json"])
    assert result["variant"] == variant and result["source"] == source
    assert result["expectedFailuresNeverConvertedToJobSuccess"] is True and result["descendantExitProven"] is False
    expected_exit = 0 if platform == "linux" and variant == "after" else 1
    assert result["exitCode"] == expected_exit
    assert [row["name"] for row in result["phases"]] == ["tests", "probe"]
    for phase in result["phases"]:
        expected_code = expected_exit if phase["name"] == "tests" else (1 if variant == "before" else 0)
        complete_root(phase["result"], expected_code)
        assert phase["result"] == json.loads(contents[phase["name"] + ".process.json"])
        assert phase["result"]["observedBytes"] == phase["result"]["retainedBytes"] == len(contents[phase["name"] + ".log"])
    report = json.loads(contents["tests.json"])
    assertions = [entry for suite in report["testResults"] for entry in suite["assertionResults"]]
    assert len(assertions) == pins["expectedTotal"] == 190 and len(report["testResults"]) == 3
    suite_names = [suite["name"].replace("\\", "/") for suite in report["testResults"]]
    assert all(sum(name.endswith("/apps/server/" + expected) for name in suite_names) == 1 for expected in pins["suites"])
    selected = []
    for title in pins["names"]:
        matches = [entry for entry in assertions if entry["title"] == title]
        assert len(matches) == 1 and matches[0]["status"] in ("passed", "failed")
        selected.append({key: matches[0].get(key, [] if key == "failureMessages" else None)
                         for key in ("title", "status", "failureMessages")})
    totals = {name: report[key] for name, key in
              [("passed", "numPassedTests"), ("failed", "numFailedTests"), ("pending", "numPendingTests"), ("todo", "numTodoTests")]}
    assert all(isinstance(value, int) and value >= 0 for value in totals.values())
    assert sum(totals.values()) == 190 and totals["todo"] == 0
    assert totals["pending"] == (187 if platform == "win32" else 0)
    assert totals["failed"] == sum(entry["status"] == "failed" for entry in assertions)
    assert totals["passed"] == sum(entry["status"] == "passed" for entry in assertions)
    assert report["success"] is (expected_exit == 0)
    if variant == "before":
        assert totals["failed"] == 3 and all(entry["status"] == "failed" for entry in selected)
    elif platform == "linux":
        assert totals["passed"] == 190 and totals["failed"] == 0
    else:
        assert 1 <= totals["failed"] <= 3  # Discover and retain the actual Windows assertion failures.
    if "tests-verification.json" in contents:
        test_verification = json.loads(contents["tests-verification.json"])
        assert result["tests"] == test_verification and test_verification["selected"] == selected
        assert {key: test_verification[key] for key in ("passed", "failed")} == {key: totals[key] for key in ("passed", "failed")}
        assert test_verification["unselected"] == totals["pending"] and test_verification["total"] == 190
        assert result["verificationPassed"] is True and result["failures"] == []
    else:
        assert result["tests"] is None and result["verificationPassed"] is False
        assert len(result["failures"]) == 1 and result["failures"][0]["phase"] == "tests-verification"
    probe = json.loads(contents["probe.json"])
    probe_verification = json.loads(contents["probe-verification.json"])
    assert probe["source"] == source and probe["platform"] == platform
    assert result["probe"] == probe_verification
    assert [row["name"] for row in probe["scenarios"]] == ["default", "noprefix", "mnemonic", "custom", "color"]
    assert all(len(row["checks"]) == 11 for row in probe["scenarios"])
    assert all(value is True for value in probe["scenarios"][0]["checks"].values())
    assert len([row for row in probe["cleanup"] if row.get("runtimeDisposed") is True]) == 5
    assert len([row for row in probe["cleanup"] if row.get("ownedTreeRemoved") is True]) == 5
    assert probe["cleanup"][-1]["rootRemoved"] is True
    assert all(isinstance(row.get("check"), str) for row in probe["failures"])
    if variant == "after":
        assert probe["failures"] == []
        assert all(value is True for row in probe["scenarios"] for value in row["checks"].values())
    else:
        assert probe["failures"] and all(row["scenario"] != "default" for row in probe["failures"])
    assert probe_verification["actualFailures"] == probe["failures"]
    assert probe_verification["scenarios"] == [{key: row[key] for key in ("name", "config", "checks")} for row in probe["scenarios"]]
    ui = json.loads(contents["ui-payload.json"])
    assert ui == probe["ui"] and ui["source"] == source and ui["schemaVersion"] == 1
    assert ui["config"] == {"diff.noprefix": "true", "core.autocrlf": "false"}
    assert ui["expectedPaths"] == ["README.md", "src/greeting.ts"] and ui["checkpoint"]["ok"] is True
    assert len(contents["ui-payload.json"]) <= 32768
    receipt = {
        "variant": variant, "platform": platform, "artifact": metadata, "job": job,
        "zipSha256": sha256(data), "driver": DRIVER, "source": source,
        "totals": totals, "selected": selected, "phases": result["phases"],
        "originalFailures": result["failures"], "sourceGuardsVerified": len(proofs),
        "snapshotsVerified": len(snapshots), "probeScenarios": probe_verification["scenarios"],
        "probeFailures": probe["failures"], "probeCleanup": probe["cleanup"],
        "ui": {"bytes": len(contents["ui-payload.json"]), "sha256": sha256(contents["ui-payload.json"]), "gitBlob": git_blob(contents["ui-payload.json"])},
        "retrievedAtUnix": time.time(),
        "files": [{"path": name, "bytes": len(value), "sha256": sha256(value), "gitBlob": git_blob(value)}
                  for name, value in sorted(contents.items())],
        "qualification": "Read-only verification of prior fixed ZIP bytes and real failed jobs. No rerun, source edit, new native execution, causal inference or discharge of the failed Windows assertion.",
    }
    (directory / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    for name in ("tests.json", "tests.log", "probe.json", "ui-payload.json", "result.json"):
        (directory / name).write_bytes(contents[name])
    emit("OBSERVED", {key: receipt[key] for key in ("variant", "platform", "zipSha256", "totals", "selected", "originalFailures", "sourceGuardsVerified", "snapshotsVerified", "probeScenarios", "probeFailures", "ui")})
    emit("UI", {"variant": variant, "platform": platform, **receipt["ui"], "base64": base64.b64encode(contents["ui-payload.json"]).decode()}, 65536)
    return receipt

try:
    reader_files = source_guard()
    pins = json.loads(Path(INPUT_PATH).read_bytes())
    assert pins["before"]["sha"] == "d4509644c8b7c2ba419680f7da8c2441f230d67e"
    assert pins["after"]["sha"] == "04f25e61fe8e6ff68b9a72218741300cee732cff"
    run = json.loads(download(api + "/actions/runs/" + str(RUN), 128 * 1024, True))
    assert run["id"] == RUN and run["head_sha"] == DRIVER
    assert run["status"] == "completed" and run["conclusion"] == "failure"
    jobs = json.loads(download(api + "/actions/runs/" + str(RUN) + "/jobs?per_page=100", 2 * 1024 * 1024, True))
    assert jobs["total_count"] == len(jobs["jobs"]) == 4
    assert {row["id"] for row in jobs["jobs"]} == {row["job"] for row in ARTIFACTS}
    (root / "run.json").write_text(json.dumps(run, indent=2) + "\n")
    (root / "jobs.json").write_text(json.dumps(jobs, indent=2) + "\n")
    receipts = [inspect(spec, pins, reader_files, jobs) for spec in ARTIFACTS]
    assert source_guard() == reader_files
    (root / "receipt.json").write_text(json.dumps({
        "reader": os.environ["GITHUB_SHA"], "readerFiles": reader_files, "run": RUN, "driver": DRIVER,
        "readOnly": True, "noSourceMutationOrTestExecution": True,
        "artifacts": [{key: row[key] for key in ("variant", "platform", "zipSha256", "totals", "ui")} for row in receipts],
    }, indent=2) + "\n")
    emit("COMPLETE", {"reader": os.environ["GITHUB_SHA"], "run": RUN, "artifacts": len(receipts),
                      "sourceAndArchiveVerificationPassed": True, "priorJobConclusionsUnchanged": True})
except Exception as error:
    (root / "reader-error.json").write_text(json.dumps({"type": type(error).__name__, "message": str(error)}) + "\n")
    raise
