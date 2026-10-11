"""Run the real native lifecycle test with isolated config and an empty workspace.

Run from the repository root with Bun and the native OpenCode CLI on PATH.
OPENCODE_LIVE_BINARY can specify the native executable explicitly.
No API credentials or existing provider configuration are inherited.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import urllib.request


binary = os.environ.get("OPENCODE_LIVE_BINARY") or shutil.which("opencode")
bun = shutil.which("bun")
assert binary and bun, "Install Bun and the native OpenCode CLI first"
model = "opencode/mimo-v2.6-flash-free"
transport = {
    key: value
    for key, value in os.environ.items()
    if key.upper()
    in {
        "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
        "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY",
        "CODEX_NETWORK_PROXY_ACTIVE", "CODEX_NETWORK_ALLOW_LOCAL_BINDING", "NETWORK",
    }
}
with tempfile.TemporaryDirectory(prefix="synara-isolated-opencode-") as directory:
    root = Path(directory)
    workspace = root / "workspace"
    workspace.mkdir()
    env = {"PATH": os.environ.get("PATH", ""), "HOME": str(root), **transport}
    for variable, folder in {
        "XDG_CONFIG_HOME": "config", "XDG_DATA_HOME": "data",
        "XDG_CACHE_HOME": "cache", "XDG_STATE_HOME": "state",
    }.items():
        env[variable] = str(root / folder)
    env["OPENCODE_CONFIG_CONTENT"] = json.dumps({
        "enabled_providers": ["opencode"], "model": model, "small_model": model,
        "autoupdate": False, "share": "disabled", "permission": {"*": "deny"},
        "instructions": [],
        "tools": {name: False for name in [
            "read", "edit", "write", "bash", "glob", "grep", "webfetch",
            "task", "skill", "question", "todowrite",
        ]},
    })
    with (root / "native-server.txt").open("w") as output:
        server = subprocess.Popen(
            [binary, "serve", "--hostname", "127.0.0.1", "--port", "46144"],
            cwd=workspace, env=env, stdout=output, stderr=subprocess.STDOUT,
        )
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            for _ in range(100):
                assert server.poll() is None, "Native CLI exited during startup"
                try:
                    with opener.open("http://127.0.0.1:46144/global/health", timeout=1):
                        break
                except OSError:
                    time.sleep(0.2)
            else:
                raise RuntimeError("Native CLI did not become healthy")
            subprocess.run(
                [bun, "run", "--cwd", "apps/server", "test",
                 "src/provider/Layers/OpenCodeAdapter.live.test.ts"],
                check=True,
                env={**env, "SYNARA_LIVE_OPENCODE": "1", "OPENCODE_LIVE_MODEL": model,
                     "OPENCODE_LIVE_BINARY": binary,
                     "OPENCODE_LIVE_SERVER_URL": "http://127.0.0.1:46144"},
            )
        finally:
            server.kill()
            server.wait()
