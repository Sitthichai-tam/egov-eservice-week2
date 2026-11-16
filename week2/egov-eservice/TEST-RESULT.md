# TEST-RESULT · ผลพิสูจน์ว่า test จับบั๊กได้ (B14 รันใหม่ egov-b14-rerun)

> วันที่รัน 2026-11-16 · ชุดเต็ม 51 TC (`npx playwright test --reporter=list`, `workers: 1`, ไม่ retry) · เว็บรันด้วย `TEST_MODE=1 BUG_MODE=<รหัส>` โดย **restart เว็บและใช้ DB ใหม่ทุกรอบ** (ยกเว้นรอบ B ของ "ปกติ" ที่รันซ้ำทันทีโดยไม่ restart ตาม BUGS.md ขั้น 2)
> ที่มาของตัวเลขทั้งหมด: ไฟล์ผลดิบ `/tmp/b14r/` (`normalA.txt` `normalB.txt` `bug_B01.txt`…`bug_B12.txt` `bug_B03,B07.txt` `bug_B01,B05,B09.txt` `bug_final.txt`) · สคริปต์ `/tmp/b14r/run.sh` และ `/tmp/b14r/all.sh` · ไม่มีการประมาณตัวเลข และ **ไม่ได้แก้ผลที่คาดหวังใน test ใด ๆ**

## 0. ข้อจำกัดที่ต้องรู้ (Docker)

- `docker compose config` ตรวจ syntax ของ `docker-compose.yml` ผ่าน แต่ **Docker daemon สตาร์ทไม่ได้ในสภาพแวดล้อมนี้** (`failed to start containerd: timeout waiting for containerd to start`) จึง **ยังไม่ได้ build/รัน image จริง ด้วย `docker compose up`**
- ทุกรอบทดสอบด้านล่างรันด้วย `node --disable-warning=ExperimentalWarning src/server.js` ซึ่งเป็นคำสั่งเดียวกับ `CMD` ใน `Dockerfile` (ตั้ง `DB_PATH`, `UPLOAD_DIR`, `PORT`, `TEST_MODE`, `BUG_MODE` เหมือนที่ compose ส่งให้) ผลพิสูจน์ตัวเว็บและ test ได้ แต่ไม่ได้พิสูจน์ขั้น build image · ต้องรัน `TEST_MODE=1 docker compose up --build` บนเครื่องที่มี daemon เพื่อยืนยันเกณฑ์ "รันด้วย compose" ให้ครบ

## 1. ผลรันปกติ (ไม่ตั้ง BUG_MODE)

| รอบ | ไฟล์ผล | ผล |
|---|---|---|
| A (restart เว็บ + DB ใหม่) | `normalA.txt` | **51 passed จาก 51** (1.3m) |
| B (รันซ้ำทันที ไม่ restart) | `normalB.txt` | **51 passed จาก 51** (1.3m) |
| ท้ายสุด (ปิดบั๊กทั้งหมดหลังรันบั๊กครบ = BUGS.md ขั้น 6) | `bug_final.txt` | **51 passed จาก 51** (1.6m) |

> หมายเหตุความน่าเชื่อถือ: รอบแรกของการรันนี้เคยได้ 44 passed · 7 failed เพราะมี `playwright test` ค้างจากคำสั่งที่ถูกฆ่ากลางทางวิ่งชนเว็บ/DB เดียวกันบนพอร์ต 3000 (ทุก test เรียก `/api/test/reset`) ไม่ใช่บั๊กของเว็บหรือ test · ตรวจแล้ว: test ที่ล้ม 3 ข้อรันเดี่ยวผ่าน · ล้างโปรเซสแล้วรันใหม่ได้ 51/51 (ผลที่ลงในตารางคือรอบสะอาดนี้) · ผลดิบของรอบที่ชนไม่ได้เก็บ

## 2. ตารางบั๊ก B01–B12 และชุดผสม

"ตรงไหม": ✅ = ล้มครบตามที่ต้องล้ม และไม่มี TC ล้มเกินรายการที่ BUGS.md ยอมให้ล้ม · ⚠️ = ล้มครบตามที่ต้องล้ม แต่มี TC ล้มเกินรายการที่ยอมให้ล้ม

| บั๊ก | TC ที่ต้องล้ม (อาจล้มด้วย) ตาม BUGS.md | TC ที่ล้มจริง | ตรงไหม | ข้อความ assert ที่ล้ม (ค่าจริงต่างจากค่าที่คาด) |
|---|---|---|---|---|
| (ปกติ) | – | – | ✅ | 51/51 ทั้ง 3 รอบ |
| B01 | TC-FEE-01 | TC-FEE-01 | ✅ | 50 passed · 1 failed · พื้นที่ 101 `fee-total` expected `฿1,010` received `฿1,000` |
| B02 | TC-UPLOAD-01 | TC-UPLOAD-01 | ✅ | 50 passed · 1 failed · `size-5242880.pdf` → `file-item` count expected 1 received 0 (ไฟล์ขนาดพอดีถูกปฏิเสธ — ล้มจากจำนวนรายการไฟล์ ซึ่งเป็นผลตรงของบั๊ก ไม่ใช่ timeout) |
| B03 | TC-SLA-01 · TC-SLA-02 (TC-SLA-03 · TC-RBAC-04) | TC-SLA-01 · TC-SLA-02 · TC-SLA-03 · TC-RBAC-04 · **TC-NOTI-02** | ⚠️ | 46 passed · 5 failed · SLA-01 แถว c `dueAt` expected `2026-12-08T16:30:00+07:00` received `2026-12-07T16:30:00+07:00` · SLA-02 `sla-due` expected `…12-08…` received `…12-07…` · SLA-03 (B) 4 ธ.ค. 09:00 `sla-level` expected `ใกล้ครบกำหนด` received `ปกติ` · RBAC-04 `dueAt` expected `2026-12-08` received `2026-12-04` · **NOTI-02** `/api/notifications` expected length 10 received 9 (ดูหัวข้อ 3) |
| B04 | TC-SLA-02 | TC-SLA-02 | ✅ | 50 passed · 1 failed · `sla-due` expected `2026-12-08T16:30:00+07:00` received `2026-12-04T16:30:00+07:00` |
| B05 | TC-PAY-01 | TC-PAY-01 | ✅ | 50 passed · 1 failed · ชำระที่อายุ QR 15:00 พอดี status expected 410 received 200 |
| B06 | TC-RBAC-01 | TC-RBAC-01 | ✅ | 50 passed · 1 failed · สมหญิง `goto` `/citizen/cases/EG-2569-000005` expected 404 received 200 · **TC-DOC-01 และ TC-RBAC-05 ผ่านเมื่อเปิด B06** (ตรวจเจ้าของ PDF/ไฟล์แนบยังทำงาน — บั๊กจำกัดเฉพาะ `scope === 'case'` ใน `src/auth.js:50`) |
| B07 | TC-RBAC-02 (TC-WORKFLOW-01) | TC-RBAC-02 | ✅ | 50 passed · 1 failed · `POST /api/cases/EG-2569-000014/approve` ด้วย off.reg2 expected 403 received 200 `{"status":"APPROVED"}` · TC-WORKFLOW-01 ผ่าน |
| B08 | TC-QUEUE-02 | TC-QUEUE-02 | ✅ | 50 passed · 1 failed · รับเรื่องพร้อมกัน 2 คน status ที่ได้ `[200,200]` expected `[200,409]` |
| B09 | TC-PDPA-02 | TC-PDPA-02 | ✅ | 50 passed · 1 failed · `GET /api/officer/queue` มี `"idNo":"1101700…"` ตรงกับ `not /\d{13}/` |
| B10 | TC-DASH-02 (TC-DASH-01 · TC-DASH-03) | TC-DASH-01 · TC-DASH-02 · TC-DASH-03 | ✅ | 48 passed · 3 failed · DASH-01 `ontimePct` expected `null` received `0` · DASH-02/03 `ontimePct` expected `85.7` received `23.1` (received=26) |
| B11 | TC-PDPA-03 · TC-AUDIT-01 | TC-PDPA-03 · TC-AUDIT-01 | ✅ | 49 passed · 2 failed · PDPA-03 audit `UNMASK` count expected 1 received 0 · AUDIT-01 count expected 16 received 15 |
| B12 | TC-WORKFLOW-04 | TC-WORKFLOW-04 | ✅ | 50 passed · 1 failed · `return-btn` count expected 0 received 1 (ปุ่มยังแสดงหลังตีกลับครบ 2 ครั้ง) |
| B03,B07 | union = SLA-01 · SLA-02 · SLA-03 · RBAC-04 · RBAC-02 (+NOTI-02 จาก B03) | TC-SLA-01 · 02 · 03 · TC-NOTI-02 · TC-RBAC-02 · TC-RBAC-04 | ⚠️ | 45 passed · 6 failed · **เท่ากับ union ของผล B03 จริง (5 ตัว) กับ B07 จริง (1 ตัว) พอดี** ไม่หาย ไม่เพิ่ม · ⚠️ เฉพาะ NOTI-02 ที่เกินรายการเหมือนใน B03 |
| B01,B05,B09 | union = FEE-01 · PAY-01 · PDPA-02 | TC-FEE-01 · TC-PAY-01 · TC-PDPA-02 | ✅ | 48 passed · 3 failed · เท่ากับ union พอดี · ข้อความ assert เหมือนรันเดี่ยว |

**สรุป:** ทุกบั๊ก B01–B12 และทั้งสองชุดผสม **TC ที่ต้องล้มล้มครบ ไม่มี "ควรล้มแต่ผ่าน" (ไม่มี test ผ่านหลอก)** · ทุกข้อความที่ล้มเป็นค่าจริงต่างจากค่าที่คาด ไม่ใช่ timeout หรือหา element ไม่เจอ (B02 และ B12 ล้มจากจำนวน element ซึ่งเป็นผลตรงของบั๊ก) · TC ที่ล้มเกินรายการมี 1 ตัวใน 1 บั๊ก: B03 → TC-NOTI-02

## 3. TC ที่ล้มเกินรายการที่ BUGS.md ยอมให้ล้ม

| บั๊ก | TC ที่ล้มเกิน | ข้อความที่ล้ม | สาเหตุ (ตรวจจากโค้ด) | ประเภท |
|---|---|---|---|---|
| B03 (และ B03,B07) | TC-NOTI-02 (`e2e/part2.spec.js:142`) | `/api/notifications` ของ `off.reg2` ที่นาฬิกา 2026-12-05 10:00 expected length 10 received 9 (ได้ `overdue` ครบแต่ขาดระดับ `near` ของ …016) | `src/notifications.js:42` เรียก `rules.slaLevel(...)` ตัวเดียวกับที่หน้าคำขอใช้แสดง `sla-level` · `slaLevel` นับ "วันคงเหลือ" ผ่าน `isBusinessDay` ที่ B03 ปิดการข้ามวันหยุด (`src/rules.js:117`) → …016 ได้ `ปกติ` แทน `ใกล้ครบกำหนด` จึงไม่มีแจ้งเตือน `near` · เป็นกลไกเดียวกับ TC-SLA-03 ส่วน B ที่ BUGS.md ยอมรับอยู่แล้ว | ผลข้างเคียงจากฟังก์ชันวันทำการร่วมกัน (SLA → ระดับเตือน → แจ้งเตือน) ยอมรับได้เชิงตรรกะ แต่ **BUGS.md ไม่ได้ระบุ** |

### ข้อเสนอ (ไม่ได้ทำ — BUGS.md อยู่นอกโฟลเดอร์ app/ จึงไม่แก้)

- เพิ่ม TC-NOTI-02 ในคอลัมน์ "TC ที่อาจล้มด้วย" ของ B03 ใน BUGS.md (เหตุผลเดียวกับ TC-SLA-03) · ทางเลือกอื่นคือให้ `notifications.js` ใช้สูตรวันทำการแยกจากฟังก์ชัน B03 ซึ่งจะขัดกับคำอธิบายของ BUGS.md ที่ระบุว่า "ฟังก์ชันวันทำการตัวเดียวกันใช้นับวันคงเหลือ" จึงไม่ทำ
- ขั้น 6 ของ BUGS.md (ปิดบั๊กทั้งหมดแล้วกลับมา 51/51): ✅ ทำแล้ว ผลใน `bug_final.txt`

### ความต่างจากผลรันก่อนหน้า (TEST-RESULT เดิมเวลา 14:43)

- B06 เดิมล้มเกิน 2 ตัว (TC-DOC-01, TC-RBAC-05) เพราะบั๊ก IDOR รั่วไปถึง PDF/ไฟล์แนบ · ปัจจุบัน `src/auth.js` จำกัดบั๊กที่ `scope === 'case'` (หน้า `/citizen/cases/:no` กับ `GET /api/cases/:no`) แล้ว รันใหม่ B06 ล้มเฉพาะ TC-RBAC-01 ✅

## 4. ตารางบันทึกผล (รูปแบบ BUGS.md หัวข้อ 4)

| บั๊ก | TC ที่คาดว่าล้ม (จากตาราง 2) | TC ที่ล้มจริง | TC ล้มเกินที่คาด | TC ที่ควรล้มแต่ผ่าน | ผล |
|---|---|---|---|---|---|
| (ปกติ) | – | – | – | – | 51/51 passed (3 รอบ: A, B ซ้ำ, ท้ายสุดหลังปิดบั๊ก) |
| B01 | TC-FEE-01 | TC-FEE-01 | – | – | ✅ 50 passed · 1 failed |
| B02 | TC-UPLOAD-01 | TC-UPLOAD-01 | – | – | ✅ 50 passed · 1 failed |
| B03 | TC-SLA-01 · TC-SLA-02 (อาจล้มด้วย TC-SLA-03 · TC-RBAC-04) | TC-SLA-01 · 02 · 03 · TC-RBAC-04 · TC-NOTI-02 | TC-NOTI-02 | – | ⚠️ 46 passed · 5 failed (NOTI-02 ผลข้างเคียงจาก `slaLevel` ร่วม) |
| B04 | TC-SLA-02 | TC-SLA-02 | – | – | ✅ 50 passed · 1 failed |
| B05 | TC-PAY-01 | TC-PAY-01 | – | – | ✅ 50 passed · 1 failed |
| B06 | TC-RBAC-01 | TC-RBAC-01 | – | – | ✅ 50 passed · 1 failed |
| B07 | TC-RBAC-02 | TC-RBAC-02 | – | – | ✅ 50 passed · 1 failed |
| B08 | TC-QUEUE-02 | TC-QUEUE-02 | – | – | ✅ 50 passed · 1 failed |
| B09 | TC-PDPA-02 | TC-PDPA-02 | – | – | ✅ 50 passed · 1 failed |
| B10 | TC-DASH-02 (อาจล้มด้วย TC-DASH-01 · TC-DASH-03) | TC-DASH-01 · 02 · 03 | – (อยู่ในรายการที่ยอมรับ) | – | ✅ 48 passed · 3 failed |
| B11 | TC-PDPA-03 · TC-AUDIT-01 | TC-PDPA-03 · TC-AUDIT-01 | – | – | ✅ 49 passed · 2 failed |
| B12 | TC-WORKFLOW-04 | TC-WORKFLOW-04 | – | – | ✅ 50 passed · 1 failed |
| B03,B07 | union | TC-SLA-01 · 02 · 03 · TC-NOTI-02 · TC-RBAC-02 · TC-RBAC-04 | TC-NOTI-02 | – | ⚠️ 45 passed · 6 failed (= union พอดี) |
| B01,B05,B09 | union | TC-FEE-01 · TC-PAY-01 · TC-PDPA-02 | – | – | ✅ 48 passed · 3 failed (= union พอดี) |
