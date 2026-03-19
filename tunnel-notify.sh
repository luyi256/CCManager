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

TOKENS_FILE="${DATA_PATH}/device-tokens.txt"

send_telegram() {
    local url="$1"
    if [ -z "$TELEGRAM_BOT_TOKEN" ] || [ -z "$TELEGRAM_CHAT_ID" ]; then
        echo "[WARN] Telegram not configured, skipping notification"
        return
    fi

    # Build per-device HTML links from device-tokens.txt
    local links=""
    if [ -f "$TOKENS_FILE" ]; then
        while IFS='=' read -r name token; do
            [[ "$name" =~ ^#.*$ || -z "$name" ]] && continue
            links="${links}<a href=\"${url}?token=${token}\">${name}</a>"$'\n'
        done < "$TOKENS_FILE"
    fi

    if [ -z "$links" ]; then
        links="${url}"
    fi

    local text
    text="🌐 CCManager Public URL"$'\n\n'"${links}"$'\n'"⏰ $(date '+%Y-%m-%d %H:%M:%S')"

    TG_TEXT="$text" python3 -c "
import json, urllib.request, os
data = json.dumps({
    'chat_id': os.environ['TELEGRAM_CHAT_ID'],
    'text': os.environ['TG_TEXT'].strip(),
    'parse_mode': 'HTML'
}).encode()
req = urllib.request.Request(
    'https://api.telegram.org/bot' + os.environ['TELEGRAM_BOT_TOKEN'] + '/sendMessage',
    data=data, headers={'Content-Type': 'application/json'})
urllib.request.urlopen(req)
" 2>/dev/null
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
