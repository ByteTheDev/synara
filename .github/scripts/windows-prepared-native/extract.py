"""Extract only the two published regular package members into a fresh owned directory."""
from pathlib import Path, PurePosixPath
import hashlib
import json
import os
import sys
import tarfile

archive, destination, pin_file, platform = sys.argv[1:]
pin = json.loads(Path(pin_file).read_text())["platforms"][platform]
target = Path(destination)
target.mkdir()
binary_member = "package/bin/opencode.exe" if platform == "windows-x64" else "package/bin/opencode"
allowed = {"package/package.json", binary_member}
observed = []
total = 0
with tarfile.open(archive, "r:gz") as package:
    for member in package:
        path = PurePosixPath(member.name)
        assert not path.is_absolute() and ".." not in path.parts
        assert member.name in allowed, f"Unexpected archive member: {member.name}"
        assert member.isfile(), f"Only regular files are accepted: {member.name}"
        assert member.name not in [entry["path"] for entry in observed], "Duplicate archive member"
        assert 0 < member.size <= pin["unpackedBytes"]
        total += member.size
        assert total <= pin["unpackedBytes"]
        source = package.extractfile(member)
        assert source is not None
        name = "package.json" if member.name == "package/package.json" else Path(binary_member).name
        output = target / name
        digest = hashlib.sha256()
        count = 0
        with output.open("xb") as writer:
            while chunk := source.read(1024 * 1024):
                count += len(chunk)
                assert count <= member.size
                digest.update(chunk)
                writer.write(chunk)
        assert count == member.size
        observed.append({"path": member.name, "bytes": count, "sha256": digest.hexdigest()})
assert len(observed) == 2 and {entry["path"] for entry in observed} == allowed
assert total == pin["unpackedBytes"]
metadata = json.loads((target / "package.json").read_text())
assert metadata["name"] == pin["name"] and metadata["version"] == "2.0.25"
assert metadata["os"] == [pin["os"]] and metadata["cpu"] == ["x64"]
executable = target / Path(binary_member).name
if os.name != "nt":
    executable.chmod(0o700)
print(json.dumps({"platform": platform, "package": metadata, "members": observed,
                  "unpackedBytes": total, "executable": str(executable)}))
