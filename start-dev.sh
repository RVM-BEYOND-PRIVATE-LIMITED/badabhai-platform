#!/usr/bin/env bash

set -e

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

API_PORT=3001
AI_PORT=8000

is_port_in_use() {
    lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

echo "========================================"
echo " Badabhai Platform Development Startup"
echo "========================================"

# -------------------------
# Start AI Service
# -------------------------
if is_port_in_use "$AI_PORT"; then
    echo "✅ AI service already running on port $AI_PORT"
else
    echo "🚀 Starting AI service..."

    (
        cd "$ROOT_DIR/apps/ai-service"

        exec ./.venv/bin/uvicorn \
            app.main:app \
            --reload \
            --port "$AI_PORT"
    ) &

    AI_PID=$!

    sleep 3

    if is_port_in_use "$AI_PORT"; then
        echo "✅ AI service started successfully."
    else
        echo "❌ Failed to start AI service."
        exit 1
    fi
fi

# -------------------------
# Start API
# -------------------------
if is_port_in_use "$API_PORT"; then
    echo "✅ API already running on port $API_PORT"
    echo ""
    echo "Nothing else to start."
    echo ""
    echo "Health checks:"
    echo "API : http://127.0.0.1:3001/health"
    echo "AI  : http://127.0.0.1:8000/health"
    exit 0
fi

echo "🚀 Starting Turbo (pnpm dev)..."

cd "$ROOT_DIR"

exec pnpm dev