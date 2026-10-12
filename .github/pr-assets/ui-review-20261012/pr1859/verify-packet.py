#!/usr/bin/env python3
"""Verify retained raw evidence without changing any original or derivative file."""
from pathlib import Path
import gzip
import hashlib
import json
import struct
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parent
SIDES = {
    "before": ("9e01962e0b1e8fec9fb0e17f17a64017bc4eaf94", "81b2ce105b3362e1266bb15916e0b16633f3843d", 2, 1),
    "after": ("86caa8ca8c25c06809a20abd058473b41de7b630", "7757705a5437174d5150c1810aaaaa3d6c4b2885", 3, 0),
}
DRIVER = "19a5cfdaeab80e8ec2a7d44bfa10c2ac77c199b9"
PHASES = ["loading-before-ack", "thinking-after-ack", "devin-starting", "devin-active", "devin-stop-request"]
NAMES = [
    "ChatView transcript geometry (full app) shows Loading until ack, then keeps Thinking through the post-ack gap",
    "ChatView transcript geometry (full app) PR1859 review evidence preserves startup before provider activity",
    "ChatView transcript geometry (full app) PR1859 review evidence reports active Devin work and sends the exact task stop",
]

def sha(b):
    return hashlib.sha256(b).hexdigest()

def obj(kind, b):
    return hashlib.sha1(kind.encode() + b" " + str(len(b)).encode() + b"\0" + b).hexdigest()

def read(n):
    p = ROOT / n
    assert p.is_file() and not p.is_symlink(), n
    return p.read_bytes()

def js(n):
    return json.loads(read(n))

def receipt(n, expected):
    b = read(n)
    assert len(b) == expected["bytes"] and sha(b) == expected["sha256"], n
    for key in ("gitBlob", "blob"):
        if key in expected:
            assert obj("blob", b) == expected[key], n

def source_tree(side):
    entries = json.loads(gzip.decompress(read(f"source-trees/{side}.json.gz")))
    assert len(entries) == 9025
    paths = [e["path"] for e in entries]
    assert len(set(paths)) == len(paths)
    root = {}
    for e in entries:
        assert e["type"] == "blob" and e["mode"] in ("100644", "100755", "120000")
        parts = e["path"].split("/")
        assert not any(p in ("", ".", "..") for p in parts)
        node = root
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        assert parts[-1] not in node
        node[parts[-1]] = e
    listing = []
    def walk(node, prefix=""):
        out = bytearray()
        ordered = sorted(node, key=lambda n: (n + ("/" if "sha" not in node[n] else "")).encode())
        for name in ordered:
            child = node[name]
            if "sha" in child:
                mode, digest = child["mode"], child["sha"]
                listing.append(f"{mode} blob {digest}\t{prefix}{name}\0".encode())
            else:
                mode, digest = "40000", walk(child, prefix + name + "/")
            out += mode.encode() + b" " + name.encode() + b"\0" + bytes.fromhex(digest)
        return obj("tree", bytes(out))
    tree = walk(root)
    assert tree == SIDES[side][1], (side, tree)
    return {e["path"]: e for e in entries}, sha(b"".join(listing))

artifact_metadata = {a["id"]: a for a in js("api/artifacts.json")["artifacts"]}
jobs = {j["id"]: j for j in js("api/jobs.json")["jobs"]}
assert jobs[114623913291]["conclusion"] == "failure"
assert jobs[114623913279]["conclusion"] == "success"
assert all(j["run_id"] == 38191112310 and j["head_sha"] == DRIVER for j in jobs.values())
member_count = 0
for original in js("original-artifacts.json"):
    side = original["side"]
    archive = read(f"archives/{side}.zip")
    api = artifact_metadata[original["artifactId"]]
    assert len(archive) == original["size"] == api["size_in_bytes"]
    assert sha(archive) == original["sha256"] == api["digest"].removeprefix("sha256:")
    assert api["workflow_run"]["id"] == 38191112310
    assert api["workflow_run"]["head_sha"] == DRIVER
    members = original["members"]
    with zipfile.ZipFile(ROOT / f"archives/{side}.zip") as z:
        actual_names = sorted(n for n in z.namelist() if not n.endswith("/"))
        assert len(actual_names) == len(set(actual_names)) == 20
        assert actual_names == sorted(m["path"] for m in members)
        for m in members:
            assert m["path"].startswith(side + "/") and ".." not in Path(m["path"]).parts
            b = z.read(m["path"])
            assert b == read(m["path"])
            assert len(b) == m["bytes"] and sha(b) == m["sha256"]
            member_count += 1

driver_files = js("driver-manifest.json")
assert len(driver_files) == 7
for f in driver_files:
    receipt("driver/" + f["path"], f)
assert js("api/driver.json")["sha"] == DRIVER
assert js("api/driver.json")["tree"]["sha"] == "9c753258efdf0a7efd28ce1d51cfe8ff70141dbf"

results = []
for side, (head, tree, passed, failed) in SIDES.items():
    leaves, listing_hash = source_tree(side)
    commit = js(f"api/{side}.json")
    assert commit["sha"] == head and commit["tree"]["sha"] == tree
    p = js(f"{side}/provenance.json")
    assert (p["source"], p["tree"], p["driver"]["head"]) == (head, tree, DRIVER)
    assert p["expectedSelected"] == 3 and p["viewport"] == {"width": 960, "height": 1100}
    for f in p["driver"]["files"]:
        receipt("driver/" + f["path"], f)
    original = read(f"{side}/canonical-fixture.tsx")
    assert obj("blob", original) == leaves["apps/web/src/components/ChatView.browser.tsx"]["sha"]
    overlay = js(f"{side}/overlay.json")
    assert overlay == js("driver/scripts/pr1859-devin-evidence/overlay.json")
    assert obj("blob", original) == overlay["canonicalBlob"]
    assert len(original) == overlay["canonicalBytes"] and sha(original) == overlay["canonicalSha256"]
    prepared = original
    for replacement in overlay["replacements"]:
        before, after = replacement["before"].encode(), replacement["after"].encode()
        assert prepared.count(before) == 1
        prepared = prepared.replace(before, after)
        # Both original observations are the only edits within the existing case.
        assert after.replace(b'      await pr1859Capture("loading-before-ack");\n\n', b'').replace(b'      await pr1859Capture("thinking-after-ack");\n', b'') == before
    append = read(f"{side}/append-fixture.tsx")
    assert append == read("driver/scripts/pr1859-devin-evidence/append-fixture.tsx")
    observed = prepared[:-4] + append + b"});\n"
    assert observed == read(f"{side}/observed-fixture.tsx")
    assert len(observed) == overlay["observedBytes"] and sha(observed) == overlay["observedSha256"]
    reverse = observed[:-4-len(append)] + b"});\n"
    for r in reversed(overlay["replacements"]):
        assert reverse.count(r["after"].encode()) == 1
        reverse = reverse.replace(r["after"].encode(), r["before"].encode())
    assert reverse == original
    assert read(f"{side}/vitest.config.ts") == read("driver/scripts/pr1859-devin-evidence/vitest.pr1859-devin-evidence.config.ts")
    for name in ("source-before.json", "source-after.json"):
        proof = js(f"{side}/{name}")
        assert (proof["source"], proof["tree"], proof["trackedFiles"]) == (head, tree, 9025)
        assert proof["rawTrackedBlobsAndModesVerified"] and proof["mismatches"] == []
        assert proof["gitTreeListingSha256"] == listing_hash
    v = js(f"{side}/verified.json")
    report = js(f"{side}/vitest.json")
    assert (report["numPassedTests"], report["numFailedTests"], report["numPendingTests"]) == (passed, failed, 219)
    assert report["success"] == (side == "after") and v["passed"] == (side == "after")
    selected = [t for f in report["testResults"] for t in f["assertionResults"] if t["fullName"] in NAMES]
    assert [t["fullName"] for t in selected] == NAMES
    expected = ["passed", "passed", "failed" if side == "before" else "passed"]
    assert [t["status"] for t in selected] == expected
    assert v["selectedTests"] == [
        {k: t[k] for k in ("fullName", "status", "failureMessages")} for t in selected
    ]
    if side == "before":
        assert len(selected[2]["failureMessages"]) == 1
        assert "Cannot find element with locator: getByText('Thinking', { exact: true })" in selected[2]["failureMessages"][0]
        assert len(v["verificationErrors"]) == 3
    else:
        assert v["verificationErrors"] == []
    assert js(f"{side}/exits.json") == v["actualExits"] == {"vitest": failed, "tee": 0}
    assert v["browserStepOutcome"] == ("failure" if failed else "success")
    for f in v["files"]:
        receipt(f"{side}/" + f["path"], f)
    snapshots = js(f"{side}/snapshot-captures.json")
    assert len(snapshots) == 9 and snapshots == v["snapshots"]
    for s in snapshots:
        assert not s["possibleTail"] and not s["capped"] and not s["changedDuringCapture"]
        assert s["capturedBytes"] == s["observedInitialBytes"] == s["observedEndBytes"]
        receipt(f"{side}/" + s["path"], s)
    observations = v["observations"]
    assert [o["phase"] for o in observations] == PHASES
    active_label = "Starting Devin…" if side == "before" else "Thinking"
    assert [o["workingLabels"] for o in observations] == [["Loading"], ["Thinking"], ["Starting Devin…"], [active_label], [active_label]]
    assert observations[-1]["stops"] == [{"type":"thread.task.stop", "threadId":"thread-browser-test", "taskId":"pr1859-check-task"}]
    for i, o in enumerate(observations):
        assert (o["source"], o["side"], o["viewport"]) == (head, side, {"width":960,"height":1100})
        b = read(f"{side}/{o['phase']}.png")
        assert b[:8] == b"\x89PNG\r\n\x1a\n" and struct.unpack(">II", b[16:24]) == (960, 1100)
        if i != 4:
            assert o["stops"] == []
    results.append({"side":side,"source":head,"tree":tree,"passed":passed,"failed":failed,"filtered":219,"canonicalByteReversal":True,"sourceLeavesVerified":len(leaves),"snapshots":len(snapshots),"originalPngs":5})

for name in ("canonical-fixture.tsx", "observed-fixture.tsx", "append-fixture.tsx", "overlay.json", "vitest.config.ts"):
    assert read("before/" + name) == read("after/" + name)
for clip in js("clips.json")["clips"]:
    receipt(clip["path"], clip)
    assert sha(read(clip["source"])) == clip["sourceSha256"]
    for f in clip["frames"]:
        receipt(f["path"], f)
assert js("derivative-reproduction.json")["actualExitCode"] == 0
print(json.dumps({"verified":True,"rawArchiveMembers":member_count,"driverFiles":7,"sources":results,"clips":2,"registeredFrames":6,"qualification":"This verifies packet integrity and preserves the actual failed Before job; it does not convert that execution to a pass or prove a live provider lifecycle."}, indent=2))
