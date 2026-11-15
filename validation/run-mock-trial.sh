#!/usr/bin/env bash
# run-mock-trial.sh — one mock-gateway practice trial for free-model-aggregator-02:
#   1. start program/env/server.mjs with the trial's env data
#   2. start the /tmp mock gateway (429 once on the first call, then token echo)
#   3. run entry/main.ts against both (it registers, serves 6/6, exits 0 on /work done)
#   4. SIGTERM the env so it exports state.json, build a cassette from the mock log,
#      score with program/scorer/score.mjs
# Usage: ./run-mock-trial.sh <trial 0|1|2> <run label, e.g. A>
# Output: entry/validation/mock-trial-<trial>-<label>/
set -u
KIT="$HOME/workspace/makefun/free-model-aggregator-02/kit/free-model-aggregator-02-kit"
ENTRY="$HOME/workspace/makefun/free-model-aggregator-02/entry"
N="$1"
LABEL="$2"
OUT="$ENTRY/validation/mock-trial-$N-$LABEL"
STATE="$OUT/state"
SCORES="$OUT/scores"
ENV_PORT=$((18080 + N))
MOCK_PORT=$((18190 + N))
rm -rf "$OUT"
mkdir -p "$STATE" "$SCORES"
echo "=== mock trial-$N run-$LABEL (env port $ENV_PORT, mock port $MOCK_PORT) ==="

MAKEFUN_ENV_DATA_DIR="$KIT/practice/trial-$N/input/env" \
  MAKEFUN_STATE_DIR="$STATE" MAKEFUN_ENV_PORT="$ENV_PORT" \
  node "$KIT/program/env/server.mjs" > "$OUT/env.log" 2>&1 &
ENV_PID=$!
for _ in $(seq 1 50); do [ -f "$STATE/ready" ] && break; sleep 0.1; done
if [ ! -f "$STATE/ready" ]; then echo "ENV DID NOT START"; cat "$OUT/env.log"; kill $ENV_PID 2>/dev/null; exit 1; fi
ENV_URL="http://127.0.0.1:$(python3 -c "import json;print(json.load(open('$STATE/ready'))['port'])")"
echo "env up: $ENV_URL"

node /tmp/mock-gateway.mjs --port "$MOCK_PORT" --log "$OUT/mock-gateway.log" --refuse-first > "$OUT/mock.log" 2>&1 &
MOCK_PID=$!
sleep 0.5
kill -0 $MOCK_PID 2>/dev/null || { echo "MOCK DID NOT START"; cat "$OUT/mock.log"; kill $ENV_PID 2>/dev/null; exit 1; }

MAKEFUN_ENV_URL="$ENV_URL" MAKEFUN_PROMPT_FILE="$KIT/practice/trial-$N/input/prompt.txt" \
  OPENAI_BASE_URL="http://127.0.0.1:$MOCK_PORT/v1" OPENAI_API_KEY=dummy-mock-key ANTHROPIC_API_KEY=dummy-mock-key \
  timeout 120 node "$ENTRY/main.ts" > "$OUT/entry.log" 2>&1
ENTRY_CODE=$?
echo "entry exit: $ENTRY_CODE"
kill $MOCK_PID 2>/dev/null
kill -TERM $ENV_PID 2>/dev/null
wait $ENV_PID 2>/dev/null
if [ ! -f "$STATE/export/state.json" ]; then echo "NO EXPORT"; tail -20 "$OUT/env.log"; exit 1; fi
node /tmp/build-cassette.mjs "$OUT/mock-gateway.log" "$OUT/cassette"
MAKEFUN_OUTPUT_DIR="$STATE/export" MAKEFUN_REFERENCE_DIR="$KIT/practice/trial-$N/reference" \
  MAKEFUN_CASSETTE_DIR="$OUT/cassette" MAKEFUN_SCORES_DIR="$SCORES" \
  node "$KIT/program/scorer/score.mjs"
echo "scores: $(cat "$SCORES/scores.json")"
python3 - "$STATE/export/state.json" "$OUT/mock-gateway.log" <<'EOF'
import json,sys
s=json.load(open(sys.argv[1]))
for r in s['prompts']:
    f=r['failures'][0] if r['failures'] else None
    print(f"{r['id']} valid={int(r['valid'])} token_ok={int(r['token_ok'])} {str(r['model'] or '-'):44s} status={r['status']} failures={len(r['failures'])} checks={sum(1 for c in r['checks'] if c['pass'])}/{len(r['checks'])}")
print('totals:', s['totals'])
print('catalog_route ok:', s['catalog_route']['openai']==s['catalog_route']['anthropic'], 'n=', len(s['catalog_route']['openai']))
calls=[json.loads(l) for l in open(sys.argv[2]) if l.strip()]
print('mock calls:', len(calls), 'statuses:', [c['status'] for c in calls])
print('mock models:', [c['model'].replace('openrouter/','') for c in calls])
EOF
