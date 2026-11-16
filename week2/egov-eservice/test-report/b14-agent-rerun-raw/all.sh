#!/bin/bash
cd /workspace/plans/egov-eservice/app
# รอบ B: ไม่ restart เว็บ
npx playwright test --reporter=list > /tmp/b14r/normalB.txt 2>&1
for b in B01 B02 B03 B04 B05 B06 B07 B08 B09 B10 B11 B12 B03,B07 B01,B05,B09 ""; do
  f=/tmp/b14r/bug_${b:-final}.txt
  /tmp/b14r/run.sh "$b" "$f"
done
touch /tmp/b14r/all.done
