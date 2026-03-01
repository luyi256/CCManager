#!/usr/bin/env bash
# CCManager Server - One-click setup & run script
# Usage: bash setup-server.sh
set -euo pipefail

# ── Colors ──────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo -e "${CYAN}════════════════════════════════════════════${NC}"
echo -e "${CYAN}   CCManager Server Setup${NC}"
echo -e "${CYAN}════════════════════════════════════════════${NC}"
echo

# ── 1. Check prerequisites ─────────────────────────────
info "Checking prerequisites..."

# Node.js
if ! command -v node &>/dev/null; then
  err "Node.js not found. Please install Node.js >= 18."
  err "  → https://nodejs.org/ or: curl -fsSL https://fnm.vercel.app/install | bash"
  exit 1
fi
NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  err "Node.js >= 18 required, found $(node -v)"
  exit 1
fi
ok "Node.js $(node -v)"

# pnpm
if ! command -v pnpm &>/dev/null; then
  warn "pnpm not found, installing..."
  npm install -g pnpm@9
fi
ok "pnpm $(pnpm -v)"

# PM2
if ! command -v pm2 &>/dev/null; then
  warn "PM2 not found, installing..."
  npm install -g pm2
fi
ok "PM2 $(pm2 -v)"

echo

# ── 2. Install dependencies ────────────────────────────
info "Installing dependencies..."
pnpm install
ok "Dependencies installed"
echo

# ── 3. Environment variables ───────────────────────────
if [ ! -f .env ]; then
  warn ".env file not found, creating from .env.example..."
  if [ -f .env.example ]; then
    cp .env.example .env
    warn "Please edit .env and fill in your credentials:"
    warn "  → CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY (required)"
    warn "  → GROQ_API_KEY (optional, for voice transcription)"
  else
    cat > .env <<'ENVEOF'
# Claude Code Authentication (choose one)
CLAUDE_CODE_OAUTH_TOKEN=clt_xxxxxxxxxx
# ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxx

# Server Configuration
PORT=3001
NODE_ENV=development
ENVEOF
    warn "Created minimal .env — please edit it with your credentials."
  fi
  echo
  read -rp "Press Enter after editing .env (or press Enter to continue)... "
fi
ok ".env file exists"
echo

# ── 4. Data directory ──────────────────────────────────
DATA_PATH="${DATA_PATH:-}"
if [ -z "$DATA_PATH" ]; then
  # Try to read from .env
  DATA_PATH=$(grep -E '^DATA_PATH=' .env 2>/dev/null | cut -d= -f2- || true)
fi
if [ -z "$DATA_PATH" ]; then
  DATA_PATH="$SCRIPT_DIR/data"
fi

if [ ! -d "$DATA_PATH" ]; then
  info "Creating data directory: $DATA_PATH"
  mkdir -p "$DATA_PATH"
fi
ok "Data directory: $DATA_PATH"
echo

# ── 5. Build project ───────────────────────────────────
info "Building server and web..."
pnpm run build
ok "Build complete"
echo

# ── 6. Start with PM2 ──────────────────────────────────
info "Starting server with PM2..."

# Check if ccm-server already running
if pm2 describe ccm-server &>/dev/null 2>&1; then
  info "ccm-server already exists in PM2, restarting..."
  pm2 restart ccm-server --update-env
else
  info "Creating ccm-server PM2 process..."
  pm2 start packages/server/dist/index.js \
    --name ccm-server \
    --cwd "$SCRIPT_DIR" \
    --env DATA_PATH="$DATA_PATH" \
    --env SERVE_STATIC=true \
    --env STATIC_PATH="$SCRIPT_DIR/packages/web/dist"
fi

pm2 save

# ── 7. Health check ────────────────────────────────────
PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2- || echo "3001")
PORT="${PORT:-3001}"

info "Waiting for server to start..."
for i in $(seq 1 10); do
  if curl -sf "http://localhost:${PORT}/api/health" &>/dev/null; then
    break
  fi
  sleep 1
done

if curl -sf "http://localhost:${PORT}/api/health" &>/dev/null; then
  ok "Server is running!"
else
  err "Server health check failed. Check logs: pm2 logs ccm-server"
  exit 1
fi

echo
echo -e "${GREEN}════════════════════════════════════════════${NC}"
echo -e "${GREEN}   Server is ready!${NC}"
echo -e "${GREEN}════════════════════════════════════════════${NC}"
echo
echo -e "  Web UI:   ${CYAN}http://localhost:${PORT}${NC}"
echo -e "  API:      ${CYAN}http://localhost:${PORT}/api${NC}"
echo -e "  Health:   ${CYAN}http://localhost:${PORT}/api/health${NC}"
echo
echo -e "  Logs:     ${YELLOW}pm2 logs ccm-server${NC}"
echo -e "  Status:   ${YELLOW}pm2 status${NC}"
echo -e "  Restart:  ${YELLOW}pm2 restart ccm-server${NC}"
echo
