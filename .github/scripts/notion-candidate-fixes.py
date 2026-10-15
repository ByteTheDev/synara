"""Temporary, hash-pinned handoff; creates blobs only, never commits or refs."""
import concurrent.futures
import gzip
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request

REPOSITORY = "Emanuele-web04/synara"
BUNDLE_SHA256 = "32bb918174472bc0539372b2718045df7d67dbc9916deeef966c9744320ef88e"
BUNDLE = Path(".github/scripts/notion-verified-recovery.json.gz")
SCRIPTS = ["notion-agent-continuation.py", "notion-ui-continuation.py", "notion-planning-continuation.py", "notion-document-continuation.py"]
CLEANUP = [*(".github/scripts/" + name for name in SCRIPTS), ".github/scripts/notion-candidate-fixes.py", str(BUNDLE), ".github/workflows/notion-integrated-validation.yml", ".github/workflows/notion-continuation-evidence.yml", ".github/workflows/notion-formatter-evidence.yml"]


def git(*args):
    return subprocess.check_output(["git", *args], text=True, timeout=20).strip()


def load():
    raw = BUNDLE.read_bytes()
    if hashlib.sha256(raw).hexdigest() != BUNDLE_SHA256:
        raise RuntimeError("Recovery bundle checksum mismatch")
    data = json.loads(gzip.decompress(raw))
    if os.environ.get("GITHUB_REPOSITORY") != REPOSITORY:
        raise RuntimeError("Wrong repository")
    if git("rev-parse", "HEAD^") != data["source_head"]:
        raise RuntimeError("Source head changed; rebuild rather than overwrite it")
    return data


def verify(data):
    for entry in data["entries"]:
        path = Path(entry["path"])
        if path.is_absolute() or ".." in path.parts or entry["path"] not in data["format_paths"]:
            raise RuntimeError("Out-of-scope source path")
        raw = path.read_bytes()
        digest = hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
        if digest != entry["sha"]:
            raise RuntimeError("Source hash mismatch: " + entry["path"])


def main():
    data = load()
    output = Path(os.environ["RUNNER_TEMP"]) / "notion-verified"
    output.mkdir(exist_ok=True)
    if sys.argv[1] == "prepare":
        for name in SCRIPTS:
            subprocess.run([sys.executable, ".github/scripts/" + name], check=True, timeout=30)
        for _ in range(2):
            subprocess.run(["node_modules/.bin/oxfmt", *data["format_paths"]], check=True, timeout=40)
        subprocess.run(["git", "apply", "--check", "-"], input=data["patch"], text=True, check=True, timeout=20)
        subprocess.run(["git", "apply", "-"], input=data["patch"], text=True, check=True, timeout=20)
        verify(data)
        (output / "capture.mjs").write_text(data["capture"])
        (output / "expected.json").write_text(json.dumps(data["entries"], indent=2))
        print("Recovered and hash-verified", len(data["entries"]), "source files.")
    elif sys.argv[1] == "export":
        verify(data)
        token = os.environ["GH_TOKEN"]
        def create_blob(entry):
            body = json.dumps({"content": Path(entry["path"]).read_text(), "encoding": "utf-8"}).encode()
            request = urllib.request.Request(
                "https://api.github.com/repos/" + REPOSITORY + "/git/blobs", data=body,
                headers={"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "synara-verified-handoff"}, method="POST")
            with urllib.request.urlopen(request, timeout=20) as response:
                result = json.load(response)
            if result.get("sha") != entry["sha"]:
                raise RuntimeError("Uploaded Git blob mismatch: " + entry["path"])
            return entry
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
            entries = list(executor.map(create_blob, data["entries"]))
        manifest = {"repository": REPOSITORY, "head": git("rev-parse", "HEAD"), "base_tree": git("rev-parse", "HEAD^{tree}"), "source_head": data["source_head"], "entries": entries, "cleanup": CLEANUP, "validation": json.loads(os.environ.get("VALIDATION_RESULTS", "{}"))}
        (output / "manifest.json").write_text(json.dumps(manifest, indent=2))
        print("Verified", len(entries), "Git blobs. No commit or branch ref was changed.")
    else:
        raise RuntimeError("Expected prepare or export")


if __name__ == "__main__":
    main()
