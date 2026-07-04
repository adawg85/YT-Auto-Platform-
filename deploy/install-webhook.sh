#!/bin/bash
#
# One-time installer for the GitHub auto-deploy webhook receiver.
# Run on the droplet:   cd /root/ytauto && git pull && bash deploy/install-webhook.sh
#
set -e

REPO_DIR="/root/ytauto"
SECRET_FILE="/etc/ytauto-webhook.secret"
PORT="9876"

# 1) generate a webhook secret once (reused on re-runs)
if [ ! -f "$SECRET_FILE" ]; then
  openssl rand -hex 32 > "$SECRET_FILE"
  chmod 600 "$SECRET_FILE"
fi

# 2) install + (re)start the systemd service
cp "$REPO_DIR/deploy/ytauto-webhook.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable ytauto-webhook >/dev/null 2>&1 || true
systemctl restart ytauto-webhook

# 3) open the port if a host firewall is active (no-op otherwise)
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "${PORT}/tcp" || true
fi

IP="$(curl -s http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address)"
sleep 1
STATE="$(systemctl is-active ytauto-webhook || true)"

echo ""
echo "=================================================================="
echo "  Webhook receiver: $STATE  (listening on port $PORT)"
echo ""
echo "  Add this webhook in GitHub:"
echo "    Repo -> Settings -> Webhooks -> Add webhook"
echo "    Payload URL:   http://${IP}:${PORT}/"
echo "    Content type:  application/json"
echo "    Secret:        $(cat "$SECRET_FILE")"
echo "    SSL verify:    (leave default; endpoint is http, HMAC-protected)"
echo "    Events:        Just the push event"
echo ""
echo "  After adding, GitHub sends a 'ping' -> should show a green check."
echo "  Deploy log:  tail -f /var/log/ytauto-webhook.log"
echo "=================================================================="
