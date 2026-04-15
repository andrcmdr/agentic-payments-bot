# ═══════════════════════════════════════════════════════════════════════════
# Dockerfile — OpenClaw + Agentic Payment Skill (dual-service)
#
# Runs the OpenClaw gateway and the agentic-payments-bot web API
# side by side in a single container, managed by tini.
# ═══════════════════════════════════════════════════════════════════════════

# ── Stage 1: Build the payment skill ─────────────────────────────────────
FROM node:trixie AS builder

WORKDIR /build

# Install build dependencies for better-sqlite3 (native addon)
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ sqlite3 gnupg2 && \
    rm -rf /var/lib/apt/lists/*

# Copy package manifests first for layer caching
COPY package.json tsconfig.json ./

# Install all dependencies (including devDependencies for tsc)
RUN npm install --verbose

# Copy source and config
COPY src/ src/
COPY config/ config/
COPY SKILL.md ./

# Compile TypeScript → dist/
RUN npm run build --verbose

# Prune devDependencies for a leaner production image
RUN npm prune --production

# ── Stage 2: Production runtime ──────────────────────────────────────────
FROM node:trixie AS runtime

# Install runtime system dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        curl \
        tini \
        jq \
        python3 \
        make \
        g++ && \
    rm -rf /var/lib/apt/lists/*

# Create a non-root user for both services
RUN groupadd --gid 1001 openclaw && \
    useradd --uid 1001 --gid openclaw --shell /bin/bash --create-home openclaw

# ── Install OpenClaw globally ────────────────────────────────────────────
RUN npm install -g openclaw@latest

# ── Set up the payment skill ────────────────────────────────────────────
WORKDIR /app/agentic-payments-bot

# Copy compiled output and production node_modules from builder
COPY --from=builder /build/dist/ ./dist/
COPY --from=builder /build/node_modules/ ./node_modules/
COPY --from=builder /build/package.json ./
COPY --from=builder /build/config/ ./config/
COPY --from=builder /build/SKILL.md ./

# Create runtime directories (data + logs + OpenClaw config & workspace)
RUN mkdir -p /app/agentic-payments-bot/data \
             /app/agentic-payments-bot/logs \
             /home/openclaw/.openclaw/workspace \
             /home/openclaw/.openclaw/skills/agentic-payments-bot

# Symlink the skill's SKILL.md into OpenClaw's skills directory
RUN ln -sf /app/agentic-payments-bot/SKILL.md \
           /home/openclaw/.openclaw/skills/agentic-payments-bot/SKILL.md

# Fix ownership
RUN chown -R openclaw:openclaw /app /home/openclaw

# ── Entrypoint script ───────────────────────────────────────────────────
COPY <<'ENTRYPOINT_SCRIPT' /usr/local/bin/entrypoint.sh
#!/usr/bin/env bash
set -euo pipefail

echo "═══════════════════════════════════════════════════════════"
echo "  🤖💵 OpenClaw + Agentic Payment Skill"
echo "  Payment API port : ${PAYMENT_API_PORT:-3402}"
echo "  OpenClaw gateway : ${OPENCLAW_GATEWAY_PORT:-18789}"
echo "  Dry-run mode     : ${DRY_RUN:-false}"
echo "═══════════════════════════════════════════════════════════"

OPENCLAW_HOME="/home/openclaw/.openclaw"
OPENCLAW_CONFIG="${OPENCLAW_HOME}/openclaw.json"

# ── First-run: generate OpenClaw configuration ────────────────────────
if [ ! -f "$OPENCLAW_CONFIG" ]; then
  echo "[openclaw] First run detected — generating configuration..."

  # Resolve gateway token: use env var or generate one
  GW_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")}"

  cat > "$OPENCLAW_CONFIG" <<EOF
{
  "gateway": {
    "mode": "local",
    "port": ${OPENCLAW_GATEWAY_PORT:-18789},
    "auth": {
      "mode": "token",
      "token": "${GW_TOKEN}"
    }
  },
  "llm": {
    "defaultProvider": "${LLM_PROVIDER:-anthropic}",
    "providers": {
      "${LLM_PROVIDER:-anthropic}": {
        "apiKey": "${LLM_API_KEY:-}"
      }
    }
  },
  "agents": {
    "defaults": {
      "workspace": "${OPENCLAW_HOME}/workspace"
    }
  },
  "tools": {
    "allow": [
      "read", "write", "edit", "apply_patch",
      "exec", "process",
      "web_search", "web_fetch"
    ]
  },
  "browser": {
    "enabled": false,
    "headless": true,
    "noSandbox": true
  }
}
EOF

  echo "[openclaw] Configuration written to ${OPENCLAW_CONFIG}"
  echo "[openclaw] Gateway token: ${GW_TOKEN:0:8}..."
fi

# ── First-run: register payment skill via 'skills' npm package ────────
SKILL_MARKER="${OPENCLAW_HOME}/.payment-skill-installed"
if [ ! -f "$SKILL_MARKER" ]; then
  echo "[skills] Registering payment skill with OpenClaw agent..."

  # Use the 'skills' npm package to install the local skill into OpenClaw
  cd /app/agentic-payments-bot
  npx -y skills add /app/agentic-payments-bot \
    --agent openclaw \
    --yes 2>/dev/null || {
      echo "[skills] npx skills add not available or failed, using manual symlink..."
      # Fallback: ensure the symlink exists (already created in Dockerfile)
      ln -sfn /app/agentic-payments-bot \
              "${OPENCLAW_HOME}/skills/agentic-payments-bot"
      echo "[skills] Symlinked skill into ${OPENCLAW_HOME}/skills/"
    }

  touch "$SKILL_MARKER"
  echo "[skills] Payment skill registered ✅"
fi

# ── Start the payment skill web API in the background ──────────────────
cd /app/agentic-payments-bot

if [ "${DRY_RUN:-false}" = "true" ]; then
  echo "[payment-skill] Starting in DRY-RUN mode..."
  export CONFIG_PATH="${CONFIG_PATH:-config/default.yaml}"
fi

echo "[payment-skill] Launching web API on port ${PAYMENT_API_PORT:-3402}..."
node dist/web-api.js &
PAYMENT_PID=$!

# ── Start OpenClaw gateway ─────────────────────────────────────────────
echo "[openclaw] Starting OpenClaw gateway on port ${OPENCLAW_GATEWAY_PORT:-18789}..."
cd /home/openclaw

openclaw gateway \
  --port "${OPENCLAW_GATEWAY_PORT:-18789}" \
  --allow-unconfigured &
OPENCLAW_PID=$!

# ── Trap signals and forward to both processes ─────────────────────────
PIDS=("$PAYMENT_PID" "$OPENCLAW_PID")

cleanup() {
  echo "[entrypoint] Shutting down..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  for pid in "${PIDS[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
  echo "[entrypoint] All processes stopped."
  exit 0
}
trap cleanup SIGTERM SIGINT SIGQUIT

# ── Wait for either process to exit ───────────────────────────────────
# If either process dies, bring everything down gracefully.
wait -n "${PIDS[@]}"
EXIT_CODE=$?

echo "[entrypoint] A process exited with code $EXIT_CODE. Stopping all..."
cleanup
ENTRYPOINT_SCRIPT

RUN chmod +x /usr/local/bin/entrypoint.sh

# ── Ports ────────────────────────────────────────────────────────────────
# 3402  = Payment skill web API
# 18789 = OpenClaw gateway
# 18790 = OpenClaw bridge
EXPOSE 3402 18789 18790

# ── Volumes ──────────────────────────────────────────────────────────────
VOLUME ["/app/agentic-payments-bot/data", \
        "/app/agentic-payments-bot/logs", \
        "/home/openclaw/.openclaw"]

# ── Runtime config ───────────────────────────────────────────────────────
USER openclaw
ENTRYPOINT ["tini", "--"]
CMD ["/usr/local/bin/entrypoint.sh"]
