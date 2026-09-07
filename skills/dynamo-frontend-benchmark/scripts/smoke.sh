#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# One bounded streaming request; require content, a finish reason and [DONE].
set -euo pipefail
cd "$(dirname "$0")"
source ./env.sh
SMOKE_DIR="$(mktemp -d "$LOG_DIR/smoke-XXXXXX")"
curl --fail --silent --show-error --max-time 20 \
    "http://localhost:${HTTP_PORT}/v1/models" > "$SMOKE_DIR/models.json"
python3 - "$SMOKE_DIR/models.json" "$SMOKE_DIR/request.json" <<'PY'
import json, os, sys
from pathlib import Path
model = os.environ['MODEL']
body = json.loads(Path(sys.argv[1]).read_text())
if not any(item.get('id') == model for item in body.get('data', [])):
    raise SystemExit('requested model is not advertised')
Path(sys.argv[2]).write_text(json.dumps({
    'model': model, 'messages': [{'role': 'user', 'content': 'Say hello in five words.'}],
    'stream': True, 'max_tokens': 32,
}))
PY
curl --fail --silent --show-error --max-time 30 \
    "http://localhost:${HTTP_PORT}/v1/chat/completions" \
    -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
    --data-binary "@$SMOKE_DIR/request.json" > "$SMOKE_DIR/response.sse"
python3 - "$SMOKE_DIR/response.sse" <<'PY'
import json, os, sys
from pathlib import Path
content, finished, done = [], False, False
for line in Path(sys.argv[1]).read_text().splitlines():
    if not line.startswith('data:'):
        continue
    value = line[5:].strip()
    if value == '[DONE]':
        done = True
        continue
    event = json.loads(value)
    if event.get('error') or event.get('model') != os.environ['MODEL']:
        raise SystemExit('stream error or model mismatch')
    for choice in event.get('choices', []):
        text = choice.get('delta', {}).get('content')
        if isinstance(text, str):
            content.append(text)
        if choice.get('finish_reason') in {'stop', 'length'}:
            finished = True
if not done or not finished or not ''.join(content).strip():
    raise SystemExit('incomplete or empty completion stream')
print(json.dumps({'ok': True, 'content': ''.join(content)}))
PY
