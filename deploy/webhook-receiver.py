#!/usr/bin/env python3
"""
GitHub push-webhook receiver for the single-droplet deployment.

On a signature-verified push to the branch the droplet currently tracks, it
pulls the repo and rebuilds the docker compose stack — the same two commands
you'd run by hand, now triggered automatically (like Render/Vercel).

Runs as a host systemd service (see ytauto-webhook.service). Uses only the
Python stdlib — no dependencies to install. The shared secret lives in
/etc/ytauto-webhook.secret and is verified via GitHub's HMAC-SHA256 header,
so authenticity holds even over plain HTTP.
"""
import hashlib
import hmac
import json
import os
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

REPO_DIR = os.environ.get("YTAUTO_REPO_DIR", "/root/ytauto")
PORT = int(os.environ.get("YTAUTO_WEBHOOK_PORT", "9876"))
SECRET_FILE = os.environ.get("YTAUTO_WEBHOOK_SECRET_FILE", "/etc/ytauto-webhook.secret")
LOG_FILE = os.environ.get("YTAUTO_WEBHOOK_LOG", "/var/log/ytauto-webhook.log")

_lock = threading.Lock()


def log(msg: str) -> None:
    with open(LOG_FILE, "a") as f:
        f.write(msg + "\n")


def secret() -> bytes:
    with open(SECRET_FILE, "rb") as f:
        return f.read().strip()


def current_branch() -> str:
    r = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        cwd=REPO_DIR,
        capture_output=True,
        text=True,
    )
    return r.stdout.strip()


def deploy() -> None:
    # serialize: never let two overlapping pushes rebuild at once
    if not _lock.acquire(blocking=False):
        log("deploy: already in progress, skipping")
        return
    try:
        log("deploy: git pull")
        subprocess.run(["git", "pull"], cwd=REPO_DIR, check=True,
                       capture_output=True, text=True)
        log("deploy: docker compose up -d --build")
        subprocess.run(
            ["docker", "compose", "-f", "docker-compose.prod.yml", "up", "-d", "--build"],
            cwd=REPO_DIR, check=True, capture_output=True, text=True,
        )
        log("deploy: SUCCESS")
    except subprocess.CalledProcessError as e:
        log(f"deploy: FAILED rc={e.returncode}\n{e.stderr}")
    finally:
        _lock.release()


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)

        sig = self.headers.get("X-Hub-Signature-256", "")
        expected = "sha256=" + hmac.new(secret(), body, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            log("rejected: bad signature")
            self.send_response(403)
            self.end_headers()
            self.wfile.write(b"bad signature")
            return

        event = self.headers.get("X-GitHub-Event", "")
        if event == "ping":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"pong")
            log("ping ok")
            return

        if event == "push":
            ref = ""
            try:
                ref = json.loads(body.decode()).get("ref", "")
            except Exception:
                pass
            want = f"refs/heads/{current_branch()}"
            if ref != want:
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"ignored (other branch)")
                log(f"push ignored: {ref} != {want}")
                return
            # respond immediately so GitHub's 10s timeout is never hit
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"deploying")
            log(f"push accepted: {ref}")
            threading.Thread(target=deploy, daemon=True).start()
            return

        self.send_response(204)
        self.end_headers()

    def log_message(self, *a):  # silence default stderr logging
        pass


if __name__ == "__main__":
    log(f"webhook receiver listening on :{PORT} (repo {REPO_DIR})")
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
