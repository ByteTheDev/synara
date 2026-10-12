#!/usr/bin/env python3
"""Verify the retained GitHub artifacts, immutable source identities and actual outcomes."""
from pathlib import Path
import gzip
import hashlib
import json
import struct
import zipfile

ROOT = Path(__file__).resolve().parent
AFTER = "2a53c3c7c20e6aec90f6eaf3067d292955d2686e"
BEFORE = "1a9d70983750bc771e850d72a858c541bac52885"
FOOTER_BEFORE = "53248e7ed92a1d14147cd66822cfa982b0d6baef"
CURRENT_DRIVER = "a8e31e6a897ccdfa7babd66275798925fe904553"
PREVIOUS_DRIVER = "f9e18e56c90159c06ee7cce409c5933dface9807"
SOURCES = {
    BEFORE: ("before", "sourceBefore", "6479afa46f65f176445f51a8fe9a859f67c4ab17", 9025),
    AFTER: ("after", "source", "4505c81b9128f56a758708c0581106490b3a5859", 9029),
    FOOTER_BEFORE: ("footer-before", "sourceFooterBefore", "c22c3af445bd06fb427814cf5a7428eec25a2edd", 9029),
}
RUNS = {
    38195141054: ("current", CURRENT_DRIVER),
    38193107887: ("previous", PREVIOUS_DRIVER),
}
CASES = {
    "before": (BEFORE, CURRENT_DRIVER, 0, 2, 220, 114636052932),
    "after": (AFTER, CURRENT_DRIVER, 2, 0, 220, 114636052854),
    "footer-before": (FOOTER_BEFORE, CURRENT_DRIVER, 3, 3, 0, 114636018306),
    "footer-after": (AFTER, CURRENT_DRIVER, 6, 0, 0, 114636018139),
    "previous/before": (BEFORE, PREVIOUS_DRIVER, 0, 2, 220, 114629942019),
    "previous/after": (FOOTER_BEFORE, PREVIOUS_DRIVER, 0, 2, 220, 114629941969),
}


def sha(b):
    return hashlib.sha256(b).hexdigest()


def obj(kind, b):
    return hashlib.sha1(kind.encode() + b" " + str(len(b)).encode() + b"\0" + b).hexdigest()


def read(name):
    p = ROOT / name
    assert p.is_file() and not p.is_symlink(), name
    return p.read_bytes()


def js(name):
    return json.loads(read(name))


def receipt(name, expected):
    b = read(name)
    assert len(b) == expected["bytes"] and sha(b) == expected["sha256"], name
    if "blob" in expected:
        assert obj("blob", b) == expected["blob"], name
    return b


def tree_hash(entries):
    root = {}
    for e in entries:
        assert e["type"] == "blob" and e["mode"] in ("100644", "100755", "120000")
        parts = e["path"].split("/")
        assert not any(p in ("", ".", "..") for p in parts)
        node = root
        for part in parts[:-1]:
            node = node.setdefault(part, {})
            assert "sha" not in node
        assert parts[-1] not in node
        node[parts[-1]] = e

    def walk(node):
        data = bytearray()
        for name in sorted(node, key=lambda n: (n + ("/" if "sha" not in node[n] else "")).encode()):
            child = node[name]
            mode, digest = (child["mode"], child["sha"]) if "sha" in child else ("40000", walk(child))
            data += mode.encode() + b" " + name.encode() + b"\0" + bytes.fromhex(digest)
        return obj("tree", bytes(data))

    return walk(root)


trees = {}
for head, (label, api_name, tree, count) in SOURCES.items():
    raw = json.loads(gzip.decompress(read(f"source-trees/{label}.json.gz")))
    assert raw["sha"] == tree
    entries = raw["tree"]
    assert len(entries) == count and tree_hash(entries) == tree
    commit = js(f"api/{api_name}.json")
    assert (commit["sha"], commit["tree"]["sha"]) == (head, tree)
    trees[head] = {e["path"]: e for e in entries}
assert [p["sha"] for p in js("api/source.json")["parents"]] == [FOOTER_BEFORE]

drivers = {}
for label, head, source, api_name, count in [
    ("current", CURRENT_DRIVER, AFTER, "driver", 9),
    ("previous", PREVIOUS_DRIVER, FOOTER_BEFORE, "driverPrevious", 7),
]:
    manifest = js(f"driver-{label}-manifest.json")
    assert len(manifest) == count
    for f in manifest:
        receipt(f"driver-{label}/" + f["path"], f)
    commit = js(f"api/{api_name}.json")
    assert commit["sha"] == head and commit["parents"][-1]["sha"] == source
    union = dict(trees[source])
    for f in manifest:
        assert f["path"] not in union
        union[f["path"]] = {"path": f["path"], "mode": "100644", "type": "blob", "sha": f["blob"]}
    assert tree_hash(union.values()) == commit["tree"]["sha"]
    drivers[head] = {"label": label, "tree": commit["tree"]["sha"], "files": {f["path"]: f for f in manifest}}

artifacts, jobs = {}, {}
for run_id, (label, driver) in RUNS.items():
    run = js(f"api/{label}-run.json")
    assert (run["id"], run["head_sha"], run["status"], run["conclusion"]) == (run_id, driver, "completed", "failure")
    for job in js(f"api/{label}-jobs.json")["jobs"]:
        assert job["run_id"] == run_id and job["head_sha"] == driver
        jobs[job["id"]] = job
    for artifact in js(f"api/{label}-artifacts.json")["artifacts"]:
        assert artifact["workflow_run"]["id"] == run_id and artifact["workflow_run"]["head_sha"] == driver
        artifacts[artifact["id"]] = artifact

member_count = 0
originals = js("original-artifacts.json")
assert len(originals) == 6
for original in originals:
    api = artifacts[original["artifactId"]]
    archive = receipt(original["archive"], original)
    assert len(archive) == api["size_in_bytes"]
    assert sha(archive) == api["digest"].removeprefix("sha256:")
    assert original["run"] == api["workflow_run"]["id"]
    with zipfile.ZipFile(ROOT / original["archive"]) as z:
        names = [n for n in z.namelist() if not n.endswith("/")]
        assert len(names) == len(set(names)) == original["memberCount"]
        assert sorted(names) == sorted(m["originalPath"] for m in original["members"])
        for m in original["members"]:
            assert ".." not in Path(m["originalPath"]).parts
            assert z.read(m["originalPath"]) == receipt(m["path"], m)
            member_count += 1
assert member_count == 85
for origin in js("origins.json"):
    receipt(origin["path"], origin)

source_proofs = driver_proofs = manifests = snapshots = pngs = 0
results = []
for label, (source, driver, passed, failed, filtered, job_id) in CASES.items():
    base = label + "/"
    p, v = js(base + "provenance.json"), js(base + "verified.json")
    assert (p["source"], p.get("sourceTree", p.get("tree")), p["driver"], p["driverTree"]) == (
        source, SOURCES[source][2], driver, drivers[driver]["tree"]
    )
    for f in p["sourceFiles"]:
        assert f["blob"] == trees[source][f["path"]]["sha"]
        source_proofs += 1
    for f in p["driverFiles"]:
        expected = drivers[driver]["files"][f["path"]]
        assert all(f[k] == expected[k] for k in ("bytes", "sha256", "blob"))
        driver_proofs += 1
    manifest = js(base + "manifest.json")
    assert len({f["path"] for f in manifest}) == len(manifest)
    for f in manifest:
        receipt(base + f["path"], f)
        manifests += 1
    report = js(base + "vitest.json")
    assert (report["numPassedTests"], report["numFailedTests"], report["numPendingTests"]) == (passed, failed, filtered)
    assert report["success"] == (failed == 0)
    assert js(base + "exits.json") == v["exits"] == {"vitest": int(failed > 0), "tee": 0}
    assert (v["actualExitCode"], v["browserOutcome"], v["status"]) == (
        int(failed > 0), "failure" if failed else "success", "failed" if failed else "completed"
    )
    assert jobs[job_id]["conclusion"] == v["browserOutcome"]
    s = js(base + "output-snapshots.json")
    stable = s.get("files", s.get("snapshots", []))
    failure_screens = s.get("failureScreenshots", [])
    for f in stable:
        receipt(base + f["path"], f)
    for f in failure_screens:
        receipt(base + "failure-screenshots/" + f["path"], f)
    for f in stable + failure_screens:
        assert f["immutableCopy"] is True
        assert f["sourceBefore"] == f["sourceAfter"]
        assert f["bytes"] == f["sourceBefore"]["size"] and f["cutoffUtc"]
        snapshots += 1

    if label.startswith("footer-"):
        canonical = receipt(base + "common-canonical-ChatComposerFooter.browser.tsx", p["canonical"])
        assert obj("blob", canonical) == trees[AFTER][p["canonical"]["path"]]["sha"]
        production = read(base + "source-ChatComposerFooter.tsx")
        assert obj("blob", production) == trees[source]["apps/web/src/components/chat/ChatComposerFooter.tsx"]["sha"]
        assertions = [a for f in report["testResults"] for a in f["assertionResults"]]
        assert len(assertions) == 6 and v["assertions"] == assertions
        assert [a["status"] for a in assertions[:3]] == ["passed"] * 3
        assert [a["status"] for a in assertions[3:]] == ["failed" if failed else "passed"] * 3
        assert all("holds handoff admission separately" in a["fullName"] for a in assertions[3:])
        assert v["expectedControlMatched"] is True and v["errors"] == []
        # A matching expected Before control does not change its actual failed exit/job.
        assert len(failure_screens) == (3 if failed else 0)
    else:
        spec = js(base + "overlay.json")
        assert spec == js(f"driver-{drivers[driver]['label']}/scripts/handoff-evidence/overlay.json")
        original = receipt(base + "common-canonical-ChatView.browser.tsx", p["commonFixture"])
        assert obj("blob", original) == trees[AFTER][spec["fixture"]["path"]]["sha"]
        assert obj("blob", read(base + "source-ChatView.browser.tsx")) == trees[source][spec["fixture"]["path"]]["sha"]
        start, end = spec["newCases"]["start"].encode(), spec["newCases"]["end"].encode()
        assert original.count(start) == original.count(end) == 1
        offset = original.index(start)
        main = original[:offset] + original[original.index(end, offset):]
        assert obj("blob", main) == trees[BEFORE][spec["fixture"]["path"]]["sha"] == spec["beforeFixture"]["blob"]
        assert len(main) == spec["beforeFixture"]["bytes"] and sha(main) == spec["beforeFixture"]["sha256"]
        observed = original
        for change in spec["replacements"]:
            a, b = change["before"].encode(), change["after"].encode()
            assert observed.count(a) == 1
            observed = observed.replace(a, b)
        helpers = read(f"driver-{drivers[driver]['label']}/scripts/handoff-evidence/helpers.ts") + b"\n"
        anchor = spec["helperAnchor"].encode()
        assert observed.count(anchor) == 1
        observed = observed.replace(anchor, helpers + anchor)
        assert observed == read(base + "observed-ChatView.browser.tsx") and sha(observed) == spec["observedSha256"]
        assert observed.count(helpers) == 1
        reversed_bytes = observed.replace(helpers, b"")
        for change in reversed(spec["replacements"]):
            a, b = change["after"].encode(), change["before"].encode()
            assert reversed_bytes.count(a) == 1
            reversed_bytes = reversed_bytes.replace(a, b)
        assert reversed_bytes == original
        all_assertions = [a for f in report["testResults"] for a in f["assertionResults"]]
        selected = [a for a in all_assertions if "holds the composer for a durable provider request until its matching" in a["fullName"]]
        other = [a for a in all_assertions if a not in selected]
        assert len(other) == 220 and all(a["status"] in ("pending", "skipped") for a in other)
        assert len(selected) == 2
        assert [{k: a[k] for k in ("fullName", "status", "failureMessages")} for a in selected] == v["selectedTests"]
        assert all("holds the composer for a durable provider request" in a["fullName"] for a in selected)
        if failed:
            assert v["verificationErrors"]
        else:
            assert v["verificationErrors"] == []
        observations = v["observations"]
        expected_observations = 8 if label == "after" else 0 if label == "previous/after" else 4
        assert len(observations) == expected_observations
        for o in observations:
            assert o["source"] == source and o["fonts"] == "loaded" and o["theme"] == "light"
            viewport = o["viewport"]
            assert viewport in ({"width": 960, "height": 1100}, {"width": 480, "height": 640})
            assert o["documentWidth"] == viewport["width"]
            b = read(base + o["phase"] + ".png")
            assert b[:8] == b"\x89PNG\r\n\x1a\n" and struct.unpack(">II", b[16:24]) == (viewport["width"], viewport["height"])
            assert o["editor"]["text"] == "Keep this draft while the provider changes."
            pending_after = label == "after" and o["stage"] == "pending"
            assert o["editor"]["editable"] == ("false" if pending_after else "true")
            assert o["send"]["disabled"] is pending_after
            assert o["send"]["label"] == ("Connecting" if pending_after else "Send message")
            pngs += 1
    results.append({"label": label, "source": source, "driver": driver, "passed": passed, "failed": failed, "filtered": filtered, "actualJob": job_id, "jobConclusion": jobs[job_id]["conclusion"]})

assert manifests == 79 and snapshots == 41 and pngs == 16
assert read("before/common-canonical-ChatView.browser.tsx") == read("after/common-canonical-ChatView.browser.tsx")
assert read("before/observed-ChatView.browser.tsx") == read("after/observed-ChatView.browser.tsx")
assert read("footer-before/common-canonical-ChatComposerFooter.browser.tsx") == read("footer-after/common-canonical-ChatComposerFooter.browser.tsx")
checks = js("api/current-checks.json")["check_runs"]
assert len(checks) == 24 and all(c["head_sha"] == AFTER and c["conclusion"] == "success" for c in checks)
for clip in js("clips.json")["clips"]:
    receipt(clip["path"], clip)
    assert sha(read(clip["source"])) == clip["sourceSha256"]
    stream = clip["measured"]["streams"][0]
    assert (stream["width"], stream["height"], stream["avg_frame_rate"]) == (960, 1100, "25/1")
    for frame in clip["frames"]:
        receipt(frame["path"], frame)
assert js("derivative-reproduction.json")["actualExitCode"] == 0
print(json.dumps({"verified": True, "originalZips": 6, "rawArchiveMembers": member_count, "retainedManifestEntries": manifests, "sourceIdentityReceipts": source_proofs, "driverIdentityReceipts": driver_proofs, "sourceTreesIndependentlyRebuilt": 3, "driverTreesIndependentlyRebuilt": 2, "fullCanonicalChatViewReversals": 4, "stableSnapshots": snapshots, "originalChatViewPngs": pngs, "footerFailurePngs": 3, "clips": 2, "registeredFrames": 6, "currentExactHeadChecks": 24, "cases": results, "qualification": "Packet integrity and actual browser controls only. Expected Before failures remain failed jobs. Source tree identity does not mean every source file was read at execution; the driver also checks clean tracked Git state and the declared raw source files. No live provider, native desktop or operating-system behavior is established."}, indent=2))
