#!/bin/bash

# Cloudflare Tunnel URL monitor script
# Detects URL changes and sends Telegram notifications
#
# Required env vars (or set in <DATA_PATH>/secrets.env):
#   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
# Optional env var:
#   DATA_PATH - path to CCManagerData directory

DATA_PATH="${DATA_PATH:-./data}"
SECRETS_FILE="${DATA_PATH}/secrets.env"

if [ -f "$SECRETS_FILE" ]; then
    source "$SECRETS_FILE"
else
    echo "[WARN] secrets.env not found at $SECRETS_FILE"
    echo "       Create it with TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID"
fi

TUNNEL_LOG="/tmp/ccm-tunnel.log"
LAST_URL_FILE="/tmp/ccm-tunnel-last-url"
CHECK_INTERVAL=10  # seconds

send_telegram() {
    local message="$1"
    if [ -z "$TELEGRAM_BOT_TOKEN" ] || [ -z "$TELEGRAM_CHAT_ID" ]; then
        echo "[WARN] Telegram not configured, skipping notification"
        return
    fi
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        -d "chat_id=${TELEGRAM_CHAT_ID}" \
        -d "text=${message}" \
        -d "parse_mode=Markdown" > /dev/null
}

get_tunnel_url() {
    if [ -f "$TUNNEL_LOG" ]; then
        grep -o "https://[a-z0-9-]*\.trycloudflare\.com" "$TUNNEL_LOG" 2>/dev/null | tail -1
    fi
}

echo "Starting tunnel URL monitor..."

LAST_URL=""
if [ -f "$LAST_URL_FILE" ]; then
    LAST_URL=$(cat "$LAST_URL_FILE")
fi

while true; do
    CURRENT_URL=$(get_tunnel_url)

    if [ -n "$CURRENT_URL" ] && [ "$CURRENT_URL" != "$LAST_URL" ]; then
        echo "$(date): URL changed: $CURRENT_URL"

        echo "$CURRENT_URL" > "$LAST_URL_FILE"
        LAST_URL="$CURRENT_URL"

        send_telegram "🌐 *CCManager Public URL Updated*

$CURRENT_URL

⏰ $(date '+%Y-%m-%d %H:%M:%S')"

        echo "Telegram notification sent!"
    fi

    sleep $CHECK_INTERVAL
done
