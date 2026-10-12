"""Reproduce continuous full-frame derivatives from the retained original WebMs."""

from pathlib import Path
import argparse
import hashlib
import json
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent
SPECS = [
    ("before", "before/video/page@9ad0386c13f955f4542b6f972ac5d07f.webm", "786e64641905a9a3778fc1b828c4398ce2d709b913819ff8306ec2b4dfaae51f", "101.00", "5.44"),
    ("after", "after/video/page@8dbd6182ca981133a95990d37b9fbe03.webm", "4d0513a072ce1f79c499e955da8fd719358ba08bd536c7eb0d09e0838ba9881d", "72.40", "3.52"),
]
FRAME_SPECS = [
    ("before", "0.5"), ("before", "2.0"), ("before", "4.0"),
    ("after", "0.8"), ("after", "1.25"), ("after", "1.5"),
    ("after", "1.85"), ("after", "2.15"), ("after", "2.6"),
]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="pr1858-media-reproduction-") as temporary:
        output_root = Path(temporary) if args.verify else ROOT
        (output_root / "clips").mkdir(exist_ok=True)
        (output_root / "frames").mkdir(exist_ok=True)
        ffmpeg_version = subprocess.check_output(["ffmpeg", "-version"], text=True).splitlines()[0]
        ffprobe_version = subprocess.check_output(["ffprobe", "-version"], text=True).splitlines()[0]
        clips = []
        frames = []
        for label, source, source_sha, start, duration in SPECS:
            assert digest(ROOT / source) == source_sha
            relative = f"clips/{label}-interaction.webm"
            command = [
                "ffmpeg", "-loglevel", "error", "-nostdin", "-ss", start,
                "-i", str(ROOT / source), "-t", duration,
                "-map", "0:v:0", "-an", "-sn", "-dn", "-map_metadata", "-1",
                "-c:v", "libvpx-vp9", "-crf", "28", "-b:v", "0",
                "-threads", "1", "-row-mt", "0", "-fflags", "+bitexact",
                "-flags:v", "+bitexact", "-y", str(output_root / relative),
            ]
            subprocess.run(command, check=True)
            output = output_root / relative
            probe = json.loads(subprocess.check_output([
                "ffprobe", "-v", "error", "-show_entries",
                "stream=codec_name,width,height:format=duration", "-of", "json", str(output),
            ], text=True))
            assert probe["streams"] == [{"codec_name": "vp9", "width": 960, "height": 1100}]
            assert abs(float(probe["format"]["duration"]) - float(duration)) < 0.041
            if args.verify:
                assert output.read_bytes() == (ROOT / relative).read_bytes()
            clips.append({
                "path": relative, "source": source, "sourceSha256": source_sha,
                "sourceStartSeconds": float(start), "requestedDurationSeconds": float(duration),
                "actualProbe": probe, "bytes": output.stat().st_size, "sha256": digest(output),
                "encoderArgv": [value.replace(str(ROOT), "PACKAGE").replace(str(output_root), "OUTPUT") for value in command],
                "qualification": "New reproducible derivative: continuous original full-frame interval at original speed, re-encoded as VP9 solely for trimming. No overlays, speed change, synthesized frames or internal cuts. Complete original WebM remains unchanged.",
            })
        for label, offset in FRAME_SPECS:
            relative = f"frames/{label}-{offset.replace('.', '_')}.png"
            clip = f"clips/{label}-interaction.webm"
            command = [
                "ffmpeg", "-loglevel", "error", "-nostdin", "-ss", offset,
                "-i", str(output_root / clip), "-frames:v", "1", "-y", str(output_root / relative),
            ]
            subprocess.run(command, check=True)
            if args.verify:
                assert (output_root / relative).read_bytes() == (ROOT / relative).read_bytes()
            frames.append({
                "path": relative, "clip": clip, "clipOffsetSeconds": float(offset),
                "sha256": digest(output_root / relative),
                "qualification": "Actual full derivative-video frame; source interval is recorded in clips.json.",
            })
        receipt = {"ffmpegVersion": ffmpeg_version, "ffprobeVersion": ffprobe_version, "clips": 2, "frames": 9, "byteIdenticalReproduction": args.verify}
        if args.verify:
            assert {p.name for p in (ROOT / "clips").iterdir()} == {Path(row["path"]).name for row in clips}
            assert {p.name for p in (ROOT / "frames").iterdir()} == {Path(row["path"]).name for row in frames}
        if not args.verify:
            (ROOT / "clips.json").write_text(json.dumps(clips, indent=2) + "\n")
            (ROOT / "frames.json").write_text(json.dumps(frames, indent=2) + "\n")
            (ROOT / "derivative-generation.json").write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps(receipt))


if __name__ == "__main__":
    main()
