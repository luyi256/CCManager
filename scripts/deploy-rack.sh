#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RACK_HOST="${CCM_RACK_HOST:-root@107.174.67.124}"
RACK_APP_DIR="${CCM_RACK_APP_DIR:-/home/CC/CCManager}"
RACK_USER="${CCM_RACK_USER:-CC}"
PUBLIC_URL="${CCM_PUBLIC_URL:-https://luyi256.top/ccm/}"

cd "$ROOT"

if [ -n "$(git status --porcelain)" ]; then
  echo "Refusing to deploy with uncommitted changes." >&2
  exit 1
fi

LOCAL_HEAD="$(git rev-parse HEAD)"
REMOTE_HEAD="$(git ls-remote origin refs/heads/main | awk '{print $1}')"
if [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]; then
  echo "Local HEAD is not the commit published on origin/main." >&2
  echo "local=$LOCAL_HEAD remote=$REMOTE_HEAD" >&2
  exit 1
fi

ssh "$RACK_HOST" \
  "sudo -u '$RACK_USER' env HOME='/home/$RACK_USER' PATH='/usr/local/bin:/usr/bin:/bin' bash -lc '
    set -euo pipefail
    cd \"$RACK_APP_DIR\"
    git pull --ff-only origin main
    pnpm install --frozen-lockfile
    pnpm run build
    pm2 restart ccm-server --update-env
    pm2 restart ccm-agent --update-env
    pm2 save
  '"

ssh "$RACK_HOST" "python3 - <<'PY'
import time
import urllib.request

url = 'http://127.0.0.1:3001/api/health'
for _ in range(30):
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            if response.status == 200:
                print(response.read().decode())
                break
    except Exception:
        pass
    time.sleep(1)
else:
    raise SystemExit('Rack health check failed')
PY"

node scripts/verify-public-deployment.mjs "$PUBLIC_URL"
echo "Rack deployment complete: $LOCAL_HEAD"
