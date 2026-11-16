# BUG-HUNT · พิสูจน์ว่า test จับบั๊กได้ (LAB 5)

เว็บ: `week2/egov-eservice/app` · ชุดทดสอบ: Playwright 51 TC (`e2e/part1.spec.js`, `e2e/part2.spec.js`) · รันด้วย `TEST_MODE=1 BUG_MODE=<รหัส>` ทีละตัว รีสตาร์ทเว็บและล้าง DB ทุกรอบ

## ที่มาของตัวเลข (ต้องอ่านก่อน)

| ส่วน | มาจาก | ผู้ตรวจ |
|---|---|---|
| รอบเปิดบั๊ก B01–B12 และชุดผสม | สคริปต์ที่เอเจนต์ B14 รันไว้ ไฟล์ผลดิบ `bug_B01.txt` … `bug_B12.txt`, `bug_B03,B07.txt`, `bug_B01,B05,B09.txt` ใน container (`/tmp/b14/`) | ข้อความผลดิบอ่านและเทียบกับ BUGS.md แล้ว **ยังไม่ได้รันซ้ำเอง** |
| รอบปกติ (ไม่ตั้ง BUG_MODE) | รันเองสองรอบหลังจบรอบเปิดบั๊ก: **51/51 passed** ทั้งสองรอบ (รอบที่ 2 ไม่รีสตาร์ทเว็บ) หลักฐาน `test-report/results.json` (expected 51, unexpected 0, flaky 0) และ `test-report/html/` | ผู้เขียนรายงานนี้ |

หมายเหตุ: ขั้น 6 ของ BUGS.md (ปิดบั๊กแล้วกลับมา 51/51) ครบจากรอบปกติที่รันหลังรอบเปิดบั๊ก

## ตารางบันทึกผล (รูปแบบ BUGS.md หัวข้อ 4)

| บั๊ก | TC ที่คาดว่าล้ม | TC ที่ล้มจริง | TC ล้มเกินที่คาด | TC ที่ควรล้มแต่ผ่าน | ผล |
|---|---|---|---|---|---|
| (ปกติ) | – | – | – | – | 51/51 passed ✅ |
| B01 | TC-FEE-01 | TC-FEE-01 | – | – | ✅ 50 passed · 1 failed |
| B02 | TC-UPLOAD-01 | TC-UPLOAD-01 | – | – | ✅ 50 passed · 1 failed |
| B03 | TC-SLA-01 · TC-SLA-02 (อาจล้มด้วย TC-SLA-03 · TC-RBAC-04) | TC-SLA-01 · 02 · 03 · TC-RBAC-04 · **TC-NOTI-02** | **TC-NOTI-02** | – | ⚠️ 46 passed · 5 failed |
| B04 | TC-SLA-02 | TC-SLA-02 | – | – | ✅ 50 passed · 1 failed |
| B05 | TC-PAY-01 | TC-PAY-01 | – | – | ✅ 50 passed · 1 failed |
| B06 | TC-RBAC-01 | TC-RBAC-01 (หลังแก้เว็บ) · เดิมล้มเกิน TC-DOC-01 · TC-RBAC-05 | – (แก้แล้ว) | – | ✅ 50 passed · 1 failed (หลังแก้) · รอบแรกก่อนแก้ 48 passed · 3 failed |
| B07 | TC-RBAC-02 | TC-RBAC-02 | – | – | ✅ 50 passed · 1 failed |
| B08 | TC-QUEUE-02 | TC-QUEUE-02 | – | – | ✅ 50 passed · 1 failed |
| B09 | TC-PDPA-02 | TC-PDPA-02 | – | – | ✅ 50 passed · 1 failed |
| B10 | TC-DASH-02 (อาจล้มด้วย TC-DASH-01 · 03) | TC-DASH-01 · 02 · 03 | – (อยู่ในรายการที่ยอมรับ) | – | ✅ 48 passed · 3 failed |
| B11 | TC-PDPA-03 · TC-AUDIT-01 | TC-PDPA-03 · TC-AUDIT-01 | – | – | ✅ 49 passed · 2 failed |
| B12 | TC-WORKFLOW-04 | TC-WORKFLOW-04 | – | – | ✅ 50 passed · 1 failed |
| B03 + B07 | union | TC-SLA-01 · 02 · 03 · TC-NOTI-02 · TC-RBAC-02 · TC-RBAC-04 | TC-NOTI-02 | – | ⚠️ 45 passed · 6 failed (เท่ากับ union ของแต่ละตัวพอดี) |
| B01 + B05 + B09 | union | TC-FEE-01 · TC-PAY-01 · TC-PDPA-02 | – | – | ✅ 48 passed · 3 failed (เท่ากับ union พอดี) |

**สรุป: บั๊กทั้ง 12 ตัวมี TC ที่ต้องล้มล้มจริงครบ (จับได้ 12/12) ไม่มี test ผ่านหลอก**

## ข้อความที่ล้มบอกค่าต่าง ไม่ใช่ timeout (BUGS.md หัวข้อ 3 ขั้น 4)

| บั๊ก | ข้อความจากผลรัน |
|---|---|
| B01 | `fee-total` (พื้นที่ 101) expected `฿1,010` received `฿1,000` |
| B03 | SLA-01 `dueAt` expected `2026-12-08T16:30:00+07:00` received `2026-12-07T16:30:00+07:00` |
| B05 | status expected 410 received 200 |
| B07 | `POST /api/cases/EG-2569-000014/approve` expected 403 received 200 |
| B09 | `GET /api/officer/queue` มีเลข 13 หลัก ทั้งที่คาดว่าไม่มี |
| B10 | `ontimePct` expected 85.7 received 23.1 |
| B11 | audit `UNMASK` expected 1 received 0 |
| B02, B12 | ล้มจากจำนวน element ไม่ตรง (`file-item` expected 1 received 0 · `return-btn` expected 0 received 1) ซึ่งเป็นผลตรงของบั๊ก |

## Triage: TC ที่ล้มเกินรายการ (BUGS.md หัวข้อ 5)

| บั๊ก | TC เกิน | ข้อความที่ล้ม | สาเหตุที่น่าจะเป็น | ต้องทำ |
|---|---|---|---|---|
| B03 | TC-NOTI-02 | `/api/notifications` ของ `off.reg2` ที่ 2026-12-05 10:00 expected length 10 received 9 | ใช้ฟังก์ชันวันทำการตัวเดียวกับ B03 ระดับ SLA เพี้ยนจึงขาดการแจ้งเตือนระดับ "ใกล้ครบกำหนด" 1 รายการ (เหตุผลเดียวกับ TC-SLA-03) | **ยังไม่ได้ตรวจโค้ดเว็บ** น่าจะเสนอเพิ่ม TC-NOTI-02 ในรายการ "อาจล้มด้วย" ของ B03 |
| B06 | TC-DOC-01 | `GET /api/documents/<docNo>/pdf` ด้วยบัญชีที่ไม่ใช่เจ้าของ expected 404 received 200 | **ยืนยันจากโค้ด:** ฟังก์ชัน `canViewCase` (`src/auth.js`) เป็นตัวตรวจเจ้าของคำขอตัวเดียวที่ใช้ร่วม 4 จุด (`citizen.js:143,186` · `documents.js:118` · `workflow.js:288`) บั๊กถูกฝังในฟังก์ชันกลางจึงรั่วไปทุกจุด | **เว็บผิด → แก้แล้ว** |
| B06 | TC-RBAC-05 | `GET /api/cases/<…025>/files` ด้วยบัญชีที่ไม่ใช่เจ้าของ expected 404 received 200 | สาเหตุเดียวกัน (`workflow.js:288`) | **เว็บผิด → แก้แล้ว** |

**การแก้ B06 (แก้ที่เว็บ ไม่ได้แก้ test):** ให้ `canViewCase(user, row, scope)` ข้ามการตรวจเจ้าของเฉพาะเมื่อ `scope === 'case'` และเปิด B06 โดยส่ง `'case'` ที่ 2 จุดตาม BUGS.md คือหน้า `/citizen/cases/:no` และ `GET /api/cases/:no` ส่วน PDF และไฟล์แนบตรวจเจ้าของเสมอ เมื่อไม่เปิดบั๊กพฤติกรรมเหมือนเดิมทุกประการ ผลหลังแก้: เปิด B06 → ล้มเฉพาะ TC-RBAC-01 (50 passed · 1 failed) และรอบปกติ 51/51 passed

**B03 → TC-NOTI-02: ไม่แก้ ยอมรับเป็นผลข้างเคียง** ยืนยันจากโค้ด: ฟังก์ชัน `isBusinessDay` (`src/rules.js`) ตัวเดียวใช้นับกำหนดเสร็จ หยุดนับ และวันคงเหลือ การแจ้งเตือนอ่านระดับเตือนจากค่าเดียวกัน จึงล้มด้วยกลไกเดียวกับ TC-SLA-03 ที่ BUGS.md ยอมรับอยู่แล้ว ไม่ใช่บั๊กรั่ว ข้อเสนอ: ถามอาจารย์/TA ให้เพิ่ม TC-NOTI-02 ในรายการ "อาจล้มด้วย" ของ B03

## สิ่งที่ยังไม่ได้ทำ / ข้อจำกัด

- รอบเปิดบั๊กแต่ละตัวรัน **ครั้งเดียว** ยังไม่ได้ทดสอบความเสถียร (B08 ตาม BUGS.md ต้องล้มทุกครั้งเมื่อยิงพร้อมกัน ควรรันซ้ำหลายครั้ง) ผลรอบเปิดบั๊กทั้งหมดมาจากสคริปต์ของ B14 ยกเว้น **B06 ที่รันซ้ำเองหลังแก้เว็บ**
- ยังไม่ได้ตรวจเนื้อหาโค้ดที่เอเจนต์ B14 แก้ระหว่างรัน (ดูเวลาแก้ไฟล์เท่านั้น: แก้ `src/*.js` และ `public/style.css` ไม่ได้แก้ไฟล์ใน `e2e/`) ส่วนการแก้ B06 ข้างบนผมแก้เอง (ไฟล์ `src/auth.js`, `src/citizen.js`)
- ชุดผสมทดสอบเพียง 2 ชุดตามที่ BUGS.md ระบุ
