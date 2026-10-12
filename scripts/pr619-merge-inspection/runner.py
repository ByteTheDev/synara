"""Inspect an exact three-way merge without changing any source checkout or feature ref."""
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import tempfile
from datetime import datetime, timezone

WORKSPACE = Path(os.environ["GITHUB_WORKSPACE"])
DRIVER = WORKSPACE / "driver"
EVIDENCE = WORKSPACE / "pr619-merge-evidence"
INPUT_PATH = "scripts/pr619-merge-inspection/inputs.json"
DRIVER_PATHS = [
    ".github/workflows/pr619-merge-inspection.yml",
    "scripts/pr619-merge-inspection/runner.py",
    INPUT_PATH,
]
MAX_SOURCE_BYTES = 2 * 1024 * 1024
MAX_RESULT_BYTES = 12 * 1024 * 1024
MAX_TOTAL_BYTES = 96 * 1024 * 1024
ENV = dict(os.environ)
ENV.update({
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_SYSTEM": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_OPTIONAL_LOCKS": "0",
    "GIT_TERMINAL_PROMPT": "0",
})
sha256 = lambda data: hashlib.sha256(data).hexdigest()
git_blob = lambda data: hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
utc = lambda: datetime.now(timezone.utc).isoformat()

def metadata(info):
    return {key: getattr(info, key) for key in (
        "st_size", "st_mtime_ns", "st_ctime_ns", "st_dev", "st_ino",
    )}

def stable_read(path, limit):
    before = path.lstat()
    assert stat.S_ISREG(before.st_mode) and not stat.S_ISLNK(before.st_mode), str(path)
    assert 0 <= before.st_size <= limit, "file read bound: " + str(path)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as stream:
        opened = os.fstat(stream.fileno())
        assert metadata(opened) == metadata(before)
        data = stream.read(before.st_size + 1)
        assert len(data) == before.st_size, "changed size: " + str(path)
        after = os.fstat(stream.fileno())
    assert metadata(before) == metadata(after) == metadata(path.lstat())
    return data

def relative(value):
    path = PurePosixPath(value)
    assert value and not path.is_absolute() and "\\" not in value
    assert all(part not in ("", ".", "..") for part in value.split("/"))
    return Path(*path.parts)

def git(cwd, *args):
    result = subprocess.run(["git", "-C", str(cwd), *args], env=ENV,
                            check=True, capture_output=True, timeout=15)
    assert len(result.stdout) <= 2 * 1024 * 1024 and len(result.stderr) <= 65536
    return result.stdout

def write_once(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as stream:
        stream.write(data)

def json_bytes(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()

INPUT_BYTES = stable_read(DRIVER / INPUT_PATH, 128 * 1024)
INPUT = json.loads(INPUT_BYTES)
assert INPUT["format"] == 1 and INPUT["pr"] == 619
assert os.environ["GITHUB_REPOSITORY"] == INPUT["repository"] == "Emanuele-web04/synara"
assert len(INPUT["files"]) == 124
assert len({item["path"] for item in INPUT["files"]}) == 124
EVIDENCE.mkdir(exist_ok=False)
PRIVATE = Path(tempfile.mkdtemp(prefix="pr619-merge-", dir=os.environ["RUNNER_TEMP"]))

def guard():
    receipts = {"driver": os.environ["GITHUB_SHA"], "sourceHeads": INPUT["heads"], "files": []}
    for side, declaration in INPUT["heads"].items():
        root = WORKSPACE / side
        assert git(root, "rev-parse", "HEAD").decode().strip() == declaration["commit"]
        assert git(root, "rev-parse", "HEAD^{tree}").decode().strip() == declaration["tree"]
        git(root, "diff", "--exit-code", "HEAD", "--")
        assert git(root, "status", "--porcelain=v1", "--untracked-files=all") == b""
        for item in INPUT["files"]:
            path = root / relative(item["path"])
            expected = item[side]
            if expected is None:
                assert not path.exists() and not path.is_symlink()
                continue
            assert item["mode"] == "100644"
            data = stable_read(path, MAX_SOURCE_BYTES)
            assert git_blob(data) == expected, side + ":" + item["path"]
            receipts["files"].append({
                "side": side, "path": item["path"], "bytes": len(data),
                "gitBlob": git_blob(data), "sha256": sha256(data),
            })
    assert git(DRIVER, "rev-parse", "HEAD").decode().strip() == os.environ["GITHUB_SHA"]
    git(DRIVER, "diff", "--exit-code", "HEAD", "--")
    assert git(DRIVER, "status", "--porcelain=v1", "--untracked-files=all") == b""
    receipts["driverFiles"] = []
    for path in DRIVER_PATHS:
        data = stable_read(DRIVER / path, MAX_SOURCE_BYTES)
        assert data == git(DRIVER, "show", "HEAD:" + path)
        receipts["driverFiles"].append({"path": path, "bytes": len(data),
                                        "sha256": sha256(data), "gitBlob": git_blob(data)})
    return receipts

def command(arguments, directory, name, accepted):
    stdout_path = directory / (name + ".stdout")
    stderr_path = directory / (name + ".stderr")
    started = utc()
    timed_out = False
    with stdout_path.open("xb") as stdout, stderr_path.open("xb") as stderr:
        try:
            result = subprocess.run(arguments, cwd=directory, env=ENV,
                                    stdout=stdout, stderr=stderr, timeout=15)
            code = result.returncode
        except subprocess.TimeoutExpired:
            code = None
            timed_out = True
    output = stable_read(stdout_path, MAX_RESULT_BYTES)
    errors = stable_read(stderr_path, 65536)
    receipt = {"command": arguments, "exit": code, "timedOut": timed_out,
               "started": started, "finished": utc(), "stderr": errors.decode("utf-8"),
               "stdoutBytes": len(output), "stdoutSha256": sha256(output)}
    assert not timed_out and code in accepted, json.dumps(receipt)
    return output, receipt

results = []
failures = []
before = None
after = None
retained_bytes = 0
try:
    before = guard()
    write_once(EVIDENCE / "before.json", json_bytes(before))
    for index, item in enumerate(INPUT["files"]):
        directory = PRIVATE / str(index)
        directory.mkdir()
        try:
            buffers = {}
            for side in ("base", "author", "current"):
                buffers[side] = b"" if item[side] is None else stable_read(
                    WORKSPACE / side / relative(item["path"]), MAX_SOURCE_BYTES)
                if item[side] is not None:
                    assert git_blob(buffers[side]) == item[side]
                write_once(directory / side, buffers[side])
            assert item["author"] is not None
            assert item["current"] is not None or item["base"] is None, "delete/modify needs explicit review"
            merged, merge = command([
                "git", "merge-file", "--diff3", "--stdout",
                "-L", "author@" + INPUT["heads"]["author"]["commit"],
                "-L", "base@" + INPUT["heads"]["base"]["commit"],
                "-L", "current@" + INPUT["heads"]["current"]["commit"],
                "author", "base", "current",
            ], directory, "merge", set(range(128)))
            write_once(directory / "merged", merged)
            patch, diff = command([
                "git", "diff", "--no-index", "--no-ext-diff", "--no-textconv",
                "--binary", "--", "current", "merged",
            ], directory, "diff", {0, 1})
            assert (diff["exit"] == 0) == (merged == buffers["current"])
            retained_bytes += len(merged) + len(patch)
            assert retained_bytes <= MAX_TOTAL_BYTES, "total output bound"
            row = {
                "path": item["path"], "inputs": item, "mode": item["mode"],
                "gitBlob": git_blob(merged), "sha256": sha256(merged), "bytes": len(merged),
                "conflicts": merge["exit"], "merge": merge, "diff": diff,
                "patchBytes": len(patch), "patchSha256": sha256(patch),
                "patchBase64": base64.b64encode(patch).decode(),
            }
            write_once(EVIDENCE / "merged" / relative(item["path"]), merged)
            write_once(EVIDENCE / "patches" / (str(index) + ".patch"), patch)
            results.append(row)
        except Exception as error:
            failures.append({"path": item["path"], "type": type(error).__name__, "message": str(error)})
    after = guard()
    assert before == after, "source or driver changed during merge inspection"
    write_once(EVIDENCE / "after.json", json_bytes(after))
except Exception as error:
    failures.append({"phase": "guard", "type": type(error).__name__, "message": str(error)})
conflicted = [row["path"] for row in results if row["conflicts"]]
receipt = {
    "driver": os.environ["GITHUB_SHA"], "run": os.environ["GITHUB_RUN_ID"],
    "attempt": os.environ["GITHUB_RUN_ATTEMPT"], "heads": INPUT["heads"],
    "inputSha256": sha256(INPUT_BYTES), "results": results, "failures": failures,
    "conflictedPaths": conflicted, "resultCount": len(results), "finished": utc(),
    "qualification": INPUT["qualification"],
}
write_once(EVIDENCE / "receipt.json", json_bytes(receipt))
print("SYNARA_PR619_MERGE_BEGIN " + json.dumps({
    "driver": receipt["driver"], "run": receipt["run"], "heads": INPUT["heads"],
    "results": len(results), "conflicts": len(conflicted), "failures": failures,
}))
for row in results:
    print("SYNARA_PR619_MERGE_RESULT " + json.dumps(row, separators=(",", ":")))
print("SYNARA_PR619_MERGE_END " + json.dumps({
    "results": len(results), "conflicts": len(conflicted), "failures": failures,
    "sourceUnchanged": before is not None and before == after,
    "receiptSha256": sha256(json_bytes(receipt)),
}))
assert len(results) == 124 and not failures and not conflicted, "Unresolved merge conflicts or inspection failures remain"
