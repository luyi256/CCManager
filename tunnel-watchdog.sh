#!/bin/bash

# Tunnel Health Check Watchdog
# Periodically checks if the cloudflare tunnel is reachable via /api/health.
# Restarts ccm-tunnel via PM2 after consecutive failures.

INTERVAL=180        # Check every 3 minutes
CURL_TIMEOUT=10     # Curl timeout in seconds
MAX_FAILURES=3      # Restart after this many consecutive failures
COOLDOWN=60         # Wait after restart before resuming checks

DATA_PATH="${DATA_PATH:-./data}"
SECRETS_FILE="${DATA_PATH}/secrets.env"
URL_FILE="/tmp/ccm-tunnel-last-url"

if [ -f "$SECRETS_FILE" ]; then
    source "$SECRETS_FILE"
fi

fail_count=0

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

send_telegram() {
    local message="$1"
    if [ -z "$TELEGRAM_BOT_TOKEN" ] || [ -z "$TELEGRAM_CHAT_ID" ]; then
        return
    fi
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        -d "chat_id=${TELEGRAM_CHAT_ID}" \
        -d "text=${message}" \
        -d "parse_mode=Markdown" > /dev/null 2>&1
}

while true; do
    # Read current tunnel URL
    if [ ! -f "$URL_FILE" ]; then
        log "WARN: $URL_FILE not found, waiting..."
        sleep "$INTERVAL"
        continue
    fi

    TUNNEL_URL=$(cat "$URL_FILE" 2>/dev/null)
    if [ -z "$TUNNEL_URL" ]; then
        log "WARN: Tunnel URL is empty, waiting..."
        sleep "$INTERVAL"
        continue
    fi

    HEALTH_URL="${TUNNEL_URL}/api/health"

    # Health check
    HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$CURL_TIMEOUT" "$HEALTH_URL" 2>/dev/null)

    if [ "$HTTP_CODE" = "200" ]; then
        if [ "$fail_count" -gt 0 ]; then
            log "OK: $HEALTH_URL recovered (was $fail_count failures)"
        fi
        fail_count=0
    else
        fail_count=$((fail_count + 1))
        log "FAIL ($fail_count/$MAX_FAILURES): $HEALTH_URL returned $HTTP_CODE"

        if [ "$fail_count" -ge "$MAX_FAILURES" ]; then
            log "ACTION: Restarting ccm-tunnel after $fail_count consecutive failures"
            send_telegram "⚠️ *Tunnel Watchdog*

Tunnel health check failed $fail_count times in a row.
Restarting ccm-tunnel...

🔗 ${TUNNEL_URL}
⏰ $(date '+%Y-%m-%d %H:%M:%S')"
            pm2 restart ccm-tunnel
            fail_count=0
            log "Cooldown ${COOLDOWN}s for tunnel to re-establish..."
            sleep "$COOLDOWN"
        fi
    fi

    sleep "$INTERVAL"
done
