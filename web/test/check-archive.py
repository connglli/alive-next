"""Replay the certificate from a real browser download with the independent kernel."""

import json
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[2]
archive, expected = sys.argv[1:]
with tempfile.TemporaryDirectory() as directory:
  target = Path(directory)
  with zipfile.ZipFile(archive) as package:
    assert package.testzip() is None
    for name in package.namelist():
      assert not Path(name).is_absolute() and ".." not in Path(name).parts
    package.extractall(target)
  certificate = target / "session/certificate"
  if expected == "unknown":
    assert not certificate.exists()
    assert "No certificate is available" in (target / "README.txt").read_text()
  else:
    assert (certificate / "check.py").read_bytes() == (root / "kernel/check.py").read_bytes()
    manifest = json.loads((certificate / "manifest.json").read_text())
    assert manifest["verdict"] == expected
    start = json.loads((target / "session/trajectory.jsonl").read_text().splitlines()[0])
    toolchain = Path(
      subprocess.check_output([str(root / "scripts/depman.sh"), "toolchain"], text=True).strip()
    )
    command = [
      sys.executable,
      str(certificate / "check.py"),
      "--llops",
      str(toolchain / "llops/build/llops"),
      "--alive-tv",
      str(toolchain / "alive2/build/alive-tv"),
      "--llrwt",
      str(toolchain / "veir/.lake/build/bin/llrwt"),
      "--src",
      str(target / f"session/store/{start['src']}.ll"),
      "--tgt",
      str(target / f"session/store/{start['tgt']}.ll"),
      "--smt-to",
      "5000",
    ]
    replay = subprocess.run(command, capture_output=True, text=True, timeout=45)
    if replay.returncode:
      raise RuntimeError(replay.stdout + replay.stderr)
    print(f"Native certificate replay: {expected}")
