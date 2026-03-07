#!/bin/bash

# Cloudflare Tunnel wrapper script
# Starts cloudflared and monitors URL changes, sends Telegram notifications
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

LAST_URL_FILE="/tmp/ccm-tunnel-last-url"

send_telegram() {
    local url="$1"
    if [ -z "$TELEGRAM_BOT_TOKEN" ] || [ -z "$TELEGRAM_CHAT_ID" ]; then
        echo "[WARN] Telegram not configured, skipping notification"
        return
    fi
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        -d "chat_id=${TELEGRAM_CHAT_ID}" \
        -d "text=🌐 *CCManager Public URL*

${url}

⏰ $(date '+%Y-%m-%d %H:%M:%S')" \
        -d "parse_mode=Markdown" > /dev/null 2>&1
    echo "[$(date)] Telegram sent: $url"
}

# Start cloudflared, process stderr for URL detection
exec 2>&1
cloudflared tunnel --url http://localhost:3001 2>&1 | while IFS= read -r line; do
    echo "$line"

    if [[ "$line" =~ (https://[a-z0-9-]+\.trycloudflare\.com) ]]; then
        URL="${BASH_REMATCH[1]}"

        LAST_URL=""
        [ -f "$LAST_URL_FILE" ] && LAST_URL=$(cat "$LAST_URL_FILE" 2>/dev/null)

        if [ "$URL" != "$LAST_URL" ]; then
            echo "$URL" > "$LAST_URL_FILE"
            send_telegram "$URL"

            # Write tunnel URL to DATA_PATH/server-url.txt for remote agent discovery
            if [ -d "$DATA_PATH" ]; then
                echo "$URL" > "${DATA_PATH}/server-url.txt"
                (cd "$DATA_PATH" && git add server-url.txt && git commit -m "tunnel: $URL" && git push) &
            fi
        fi
    fi
done
