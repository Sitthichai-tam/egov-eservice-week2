#!/bin/bash
# usage: run.sh <BUG_MODE> <outfile> ; restart เว็บ + DB ใหม่ทุกรอบ
cd /workspace/plans/egov-eservice/app
pkill -f "^node --disable-warning=ExperimentalWarning src/server"; sleep 1
rm -rf /tmp/b14r/data; mkdir -p /tmp/b14r/data
DB_PATH=/tmp/b14r/data/app.db UPLOAD_DIR=/tmp/b14r/data/uploads TEST_MODE=1 BUG_MODE="$1" PORT=3000 nohup node --disable-warning=ExperimentalWarning src/server.js > /tmp/b14r/server.log 2>&1 &
for i in $(seq 1 40); do curl -sf localhost:3000/api/health >/dev/null && break; sleep 0.5; done
npx playwright test --reporter=list > "$2" 2>&1
