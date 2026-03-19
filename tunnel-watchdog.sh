#!/bin/bash

# Tunnel Health Check Watchdog
# Periodically checks if the cloudflare tunnel is reachable via /api/health.
# Restarts ccm-tunnel via PM2 after consecutive failures.

INTERVAL=180        # Check every 3 minutes
CURL_TIMEOUT=10     # Curl timeout in seconds
MAX_FAILURES=3      # Restart after this many consecutive failures
COOLDOWN=60         # Wait after restart before resuming checks

URL_FILE="/tmp/ccm-tunnel-last-url"

fail_count=0

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
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
            pm2 restart ccm-tunnel
            fail_count=0
            log "Cooldown ${COOLDOWN}s for tunnel to re-establish..."
            sleep "$COOLDOWN"
        fi
    fi

    sleep "$INTERVAL"
done
