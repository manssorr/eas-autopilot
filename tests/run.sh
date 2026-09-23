#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TOOL="$HERE/../bin/eas-autopilot"
DEPS="$HERE/.deps"
EAS_CLI_VERSION="${EAS_CLI_VERSION:-24.7.0}"

if [[ ! -d "$DEPS/node_modules/eas-cli" ]]; then
  echo "Installing eas-cli@$EAS_CLI_VERSION for the mock (one time)..."
  npm install --prefix "$DEPS" --no-audit --no-fund --silent "eas-cli@$EAS_CLI_VERSION" ora@5 >/dev/null
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
APP="$WORK/app"
mkdir -p "$APP"
echo '{"expo":{"name":"example"}}' > "$APP/app.json"
git -C "$APP" init -q
git -C "$APP" -c user.name=test -c user.email=test@example.com add app.json
git -C "$APP" -c user.name=test -c user.email=test@example.com commit -qm init

export TOOL APP_DIR="$APP"
export EAS_MOCK_NODE_MODULES="$DEPS/node_modules"
export EAS_MOCK_NEW_DEVICE="00000000-000A00000B00000C"
export EAS_AUTOPILOT_STATE="$WORK/state"
export EAS_AUTOPILOT_CMD="node $HERE/mock-eas.js"

pass=0
fail=0
check() {
  if [[ "$2" == "$3" ]]; then echo "  ✔ $1"; pass=$((pass + 1)); else echo "  ✘ $1: expected [$3], got [$2]"; fail=$((fail + 1)); fi
}
last_meta() { ls -d "$EAS_AUTOPILOT_STATE"/runs/*/ | tail -1 | sed 's#/$#/meta.json#'; }

run_case() {
  export EAS_MOCK_RESULT="$WORK/result-$1"
  : > "$EAS_MOCK_RESULT"
  set +e
  EAS_MOCK_FAIL="$2" APPLE_ID_KEY="$3" expect "$HERE/drive.exp" > "$WORK/out-$1" 2>&1
  CODE=$?
  set -e
}

echo "Case 1: first run, trust the Apple ID, every device selected"
run_case first 0 t
check "exit code" "$CODE" 0
check "all devices selected on every target" "$(grep -c 'selected .* 20/20' "$EAS_MOCK_RESULT")" 3
check "result" "$(jq -r .result "$(last_meta)")" queued
check "trust saved" "$(cut -f1 "$EAS_AUTOPILOT_STATE/trust.tsv")" tester@example.com

echo "Case 2: trusted Apple ID, no question asked"
run_case trusted 0 x
check "exit code" "$CODE" 0
check "no Apple ID question" "$(grep -c 'use it and trust' "$WORK/out-trusted" || true)" 0

echo "Case 3: Apple refuses the new device, Enter stops before building"
run_case refused 1 t
check "exit code" "$CODE" 3
check "EAS answered No" "$(grep '^continue' "$EAS_MOCK_RESULT")" "continue false"
check "result" "$(jq -r .result "$(last_meta)")" device-not-provisioned-at-apple

echo "Case 4: history is valid UTF-8 JSON lines"
check "runs recorded" "$(wc -l < "$EAS_AUTOPILOT_STATE/runs.jsonl" | tr -d ' ')" 3
check "utf-8" "$(python3 -c "open('$EAS_AUTOPILOT_STATE/runs.jsonl',encoding='utf-8').read(); print('ok')")" ok

echo
echo "$pass passed, $fail failed"
(( fail == 0 ))
