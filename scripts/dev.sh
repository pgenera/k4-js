#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIM_LISTEN="127.0.0.1:19205"
WS_PORT="9280"
WS_LISTEN="127.0.0.1:${WS_PORT}"
CONTROL_HTTP="127.0.0.1:19206"
FPS="20"
PASSWORD=""
MODEL="k4"
SERVE_WEB=0
RX_ONLY=0
RADIO_ADDR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --serve)
      SERVE_WEB=1
      shift
      ;;
    --rx-only)
      RX_ONLY=1
      shift
      ;;
    --model)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then echo "Missing value for $1" >&2; exit 1; fi
      MODEL="$2"
      shift 2
      ;;
    --fps)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then echo "Missing value for $1" >&2; exit 1; fi
      FPS="$2"
      shift 2
      ;;
    --password)
      if [[ $# -lt 2 ]]; then echo "Missing value for $1" >&2; exit 1; fi
      PASSWORD="$2"
      shift 2
      ;;
    --ws-port)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then echo "Missing value for $1" >&2; exit 1; fi
      WS_PORT="$2"
      WS_LISTEN="127.0.0.1:${WS_PORT}"
      shift 2
      ;;
    --sim-port)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then echo "Missing value for $1" >&2; exit 1; fi
      SIM_LISTEN="127.0.0.1:$2"
      shift 2
      ;;
    --radio)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then echo "Missing value for $1" >&2; exit 1; fi
      RADIO_ADDR="$2"
      shift 2
      ;;
    -h|--help)
      cat <<EOF
Usage: $(basename "$0") [options]
  --serve            Serve web/ over http://localhost:${WS_PORT}/ via websockify --web (natively trusted isSecureContext for mic capture + ws://localhost:${WS_PORT}/ws without SSL certs)
  --rx-only          Start k4sim in strict RX-only mode (-rx-only, blocking operational TX CAT commands)
  --model <model>    Simulated radio model: k4 (default), k4d, or k4hd
  --fps <1..30>      Simulator panadapter FPS (default: 20)
  --password <pw>    Optional simulator SHA-384 network password
  --ws-port <port>   Websockify listen port (default: 9280)
  --sim-port <port>  Simulator TCP port (default: 19205)
  --radio <host[:port]>  Connect directly to a physical K4 (default port 9205) instead of starting k4sim
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

SIM_PID=""
WS_PID=""

cleanup() {
  trap - EXIT INT TERM
  if [[ -n "$WS_PID" ]] && kill -0 "$WS_PID" 2>/dev/null; then
    kill "$WS_PID" 2>/dev/null || true
    wait "$WS_PID" 2>/dev/null || true
  fi
  if [[ -n "$SIM_PID" ]] && kill -0 "$SIM_PID" 2>/dev/null; then
    kill "$SIM_PID" 2>/dev/null || true
    wait "$SIM_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

TARGET_LISTEN="$SIM_LISTEN"
TARGET_LABEL="tcp://${SIM_LISTEN}"
if [[ -n "$RADIO_ADDR" ]]; then
  if [[ "$RADIO_ADDR" =~ ^\[[^]]+\]:[0-9]+$ || "$RADIO_ADDR" =~ ^[^:]+:[0-9]+$ ]]; then
    TARGET_LISTEN="$RADIO_ADDR"
  elif [[ "$RADIO_ADDR" =~ ^\[[^]]+\]$ ]]; then
    TARGET_LISTEN="${RADIO_ADDR}:9205"
  elif [[ "$RADIO_ADDR" == *:*:* && "$RADIO_ADDR" != *[* && "$RADIO_ADDR" != *]* ]]; then
    TARGET_LISTEN="[${RADIO_ADDR}]:9205"
  elif [[ "$RADIO_ADDR" =~ ^[^:]+$ ]]; then
    TARGET_LISTEN="${RADIO_ADDR}:9205"
  else
    echo "Invalid --radio address: $RADIO_ADDR (expected host, host:port, or [ipv6]:port)" >&2
    exit 1
  fi
  TARGET_LABEL="tcp://${TARGET_LISTEN} (physical K4)"
else
  SIM_BIN="$ROOT_DIR/sim/k4sim"
  echo "Building k4sim..."
  (cd "$ROOT_DIR/sim" && go build -o "$SIM_BIN" .)

  SIM_ARGS=(
    -listen "$SIM_LISTEN"
    -fps "$FPS"
    -password "$PASSWORD"
    -control-http "$CONTROL_HTTP"
    -model "$MODEL"
  )
  if [[ "$RX_ONLY" -eq 1 ]]; then
    SIM_ARGS+=(-rx-only)
  fi

  "$SIM_BIN" "${SIM_ARGS[@]}" &
  SIM_PID=$!

  # Brief pause for simulator TCP socket readiness
  sleep 0.3
fi

if [[ "$SERVE_WEB" -eq 1 ]]; then
  echo "Starting websockify + static web server on http://localhost:${WS_PORT}/ (bound ${WS_LISTEN}) -> ${TARGET_LABEL}"
  websockify --web="$ROOT_DIR/web" --file-only "$WS_LISTEN" "$TARGET_LISTEN" &
  WS_PID=$!
  echo "Open in browser: http://localhost:${WS_PORT}/"
  echo "  (http://localhost:${WS_PORT}/ is a natively trusted window.isSecureContext without SSL certs, enabling getUserMedia mic capture + ws://localhost:${WS_PORT}/ws)"
else
  echo "Starting websockify on ws://${WS_LISTEN} -> ${TARGET_LABEL}"
  websockify "$WS_LISTEN" "$TARGET_LISTEN" &
  WS_PID=$!
  echo "Open directly in browser: file://${ROOT_DIR}/web/index.html"
fi

if [[ -z "$RADIO_ADDR" ]]; then
  echo "Debug stats endpoint: http://${CONTROL_HTTP}/debug/stats"
fi
echo "Press Ctrl+C to stop."

if [[ -n "$SIM_PID" ]]; then
  wait -n "$SIM_PID" "$WS_PID"
else
  wait "$WS_PID"
fi
