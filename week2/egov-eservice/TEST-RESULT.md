# TEST-RESULT · ผลพิสูจน์ว่า test จับบั๊กได้ (B14)

> run egov-eservice-20261116-131519 · ชุดเต็ม 51 TC (Playwright, `workers: 1`, `--reporter=list`) · เว็บรันด้วย `TEST_MODE=1 BUG_MODE=<รหัส>` โดยรีสตาร์ทเว็บและล้าง DB ทุกรอบ (สคริปต์ `/tmp/b14/run.sh`)
> ที่มาของตัวเลขทั้งหมด: ไฟล์ผลใน `/tmp/b14/` (`normalA.txt` `normalB.txt` `bug_B01.txt` ถึง `bug_B12.txt` `bug_B03,B07.txt` `bug_B01,B05,B09.txt`) · ไม่มีการประมาณตัวเลข

## 1. ผลรันปกติ (ไม่ตั้ง BUG_MODE)

| รอบ | ไฟล์ผล | ผล |
|---|---|---|
| A | `normalA.txt` | **51 passed จาก 51** (1.3m) |
| B (รันซ้ำทันที) | `normalB.txt` | **51 passed จาก 51** (1.3m) |

ผ่านครบทั้งสองรอบ → ผลซ้ำได้ (ตาม BUGS.md หัวข้อ 3 ขั้น 1–2)

## 2. ตารางบั๊ก B01–B12 และชุดผสม

คอลัมน์ "TC ที่ต้องล้มตาม BUGS.md" = คอลัมน์ "TC ที่ต้องล้ม" ใน BUGS.md หัวข้อ 2 · วงเล็บ = "TC ที่อาจล้มด้วย" (ผลข้างเคียงที่ยอมรับ)
"ตรงไหม": ✅ = ล้มครบตามที่ต้องล้ม และไม่มี TC ล้มเกินจากรายการที่ยอมให้ล้ม · ⚠️ = ล้มครบตามที่ต้องล้ม แต่มี TC ล้มเกินจากรายการที่ยอมให้ล้ม

| บั๊ก | TC ที่ต้องล้มตาม BUGS.md | TC ที่ล้มจริง | ตรงไหม | หมายเหตุ |
|---|---|---|---|---|
| (ปกติ) | – | – | ✅ | 51/51 passed ทั้งสองรอบ |
| B01 | TC-FEE-01 | TC-FEE-01 | ✅ | 50 passed · 1 failed · `fee-total` (area 101) expected `฿1,010` received `฿1,000` |
| B02 | TC-UPLOAD-01 | TC-UPLOAD-01 | ✅ | 50 passed · 1 failed · `file-item` toHaveCount expected 1 received 0 (ไฟล์ 5,242,880 ไบต์ถูกปฏิเสธ) |
| B03 | TC-SLA-01 · TC-SLA-02 (อาจล้มด้วย TC-SLA-03 · TC-RBAC-04) | TC-SLA-01 · TC-SLA-02 · TC-SLA-03 · TC-RBAC-04 · **TC-NOTI-02** | ⚠️ | 46 passed · 5 failed · ล้มครบที่ต้องล้ม + ผลข้างเคียงที่ยอมรับ 2 ตัว (SLA-03, RBAC-04) + **TC-NOTI-02 ล้มเกินรายการ** (ดูหัวข้อ 3) · SLA-01 แถว c `dueAt` expected `2026-12-08T16:30:00+07:00` received `2026-12-07T16:30:00+07:00` · SLA-02 `sla-due` expected `2026-12-08T16:30` received `2026-12-07T16:30` · SLA-03 (B) 4 ธ.ค. 09:00 `sla-level` expected `ใกล้ครบกำหนด` received `ปกติ` · RBAC-04 `dueAt` expected `2026-12-08T16:30` received `2026-12-04T16:30` |
| B04 | TC-SLA-02 | TC-SLA-02 | ✅ | 50 passed · 1 failed · `sla-due` expected `2026-12-08T16:30:00+07:00` received `2026-12-04T16:30:00+07:00` |
| B05 | TC-PAY-01 | TC-PAY-01 | ✅ | 50 passed · 1 failed · status expected 410 received 200 |
| B06 | TC-RBAC-01 | TC-RBAC-01 · **TC-DOC-01** · **TC-RBAC-05** | ⚠️ | 48 passed · 3 failed · ตาราง BUGS.md ไม่มี "TC ที่อาจล้มด้วย" ของ B06 → TC-DOC-01 กับ TC-RBAC-05 ล้มเกินรายการ (ดูหัวข้อ 3) · RBAC-01 `goto` หน้าคำขอของสมชายด้วยบัญชีสมหญิง expected 404 received 200 |
| B07 | TC-RBAC-02 | TC-RBAC-02 | ✅ | 50 passed · 1 failed · `POST /api/cases/EG-2569-000014/approve` expected 403 received 200 (`{"status":"APPROVED"}`) · TC-WORKFLOW-01 ผ่าน |
| B08 | TC-QUEUE-02 | TC-QUEUE-02 | ✅ | 50 passed · 1 failed · deep equality คาด 409 ได้ 200 (ส่วนรับเรื่องซ้อน) |
| B09 | TC-PDPA-02 | TC-PDPA-02 | ✅ | 50 passed · 1 failed · `GET /api/officer/queue` มีเลข 13 หลัก (key `idNo` ในแถว) ทั้งที่คาด `not /\d{13}/` |
| B10 | TC-DASH-02 (อาจล้มด้วย TC-DASH-01 · TC-DASH-03) | TC-DASH-01 · TC-DASH-02 · TC-DASH-03 | ✅ | 48 passed · 3 failed · ล้มทั้งสามตามที่ BUGS.md ยอมรับ · DASH-01 `ontimePct` expected `null` received `0` · DASH-02/03 `ontimePct` expected `85.7` received `23.1` (received=26) |
| B11 | TC-PDPA-03 · TC-AUDIT-01 | TC-PDPA-03 · TC-AUDIT-01 | ✅ | 49 passed · 2 failed · PDPA-03 จำนวน audit `UNMASK` expected 1 received 0 · AUDIT-01 expected 16 received 15 |
| B12 | TC-WORKFLOW-04 | TC-WORKFLOW-04 | ✅ | 50 passed · 1 failed · `return-btn` toHaveCount expected 0 received 1 |
| B03,B07 | union ของ B03 และ B07 = TC-SLA-01 · TC-SLA-02 · TC-SLA-03 · TC-RBAC-04 · TC-RBAC-02 (+ TC-NOTI-02 ซึ่งเกินรายการอยู่แล้วใน B03) | TC-SLA-01 · TC-SLA-02 · TC-SLA-03 · TC-NOTI-02 · TC-RBAC-02 · TC-RBAC-04 | ⚠️ | 45 passed · 6 failed · **เท่ากับ union ของผล B03 จริง (5 ตัว) กับ B07 จริง (1 ตัว) พอดี** ไม่หาย ไม่เพิ่ม · ⚠️ เฉพาะ TC-NOTI-02 ที่เกินรายการเหมือนใน B03 |
| B01,B05,B09 | union = TC-FEE-01 · TC-PAY-01 · TC-PDPA-02 | TC-FEE-01 · TC-PAY-01 · TC-PDPA-02 | ✅ | 48 passed · 3 failed · เท่ากับ union พอดี · ข้อความ assert เหมือนรันเดี่ยว (`฿1,010` vs `฿1,000` · 410 vs 200 · พบเลข 13 หลัก) |

สรุป: ทุกบั๊ก B01–B12 และทั้งสองชุดผสม **TC ที่ต้องล้มล้มครบ ไม่มีกรณี "ควรล้มแต่ผ่าน" (ไม่มี test ผ่านหลอก)** · ข้อความที่ล้มเป็นค่าจริงต่างจากค่าที่คาด ไม่ใช่ timeout หรือหา element ไม่เจอ (ยกเว้นข้อสังเกตของ B02/B12 ที่ล้มจากจำนวน element ไม่ตรง ซึ่งเป็นผลตรงของบั๊ก: ไฟล์ถูกปฏิเสธจึงไม่มี `file-item` / ปุ่ม `return-btn` ยังแสดง) · TC ที่ล้มเกินรายการมี 3 ตัวใน 2 บั๊ก (B03 → TC-NOTI-02, B06 → TC-DOC-01 และ TC-RBAC-05)

## 3. TC ที่ล้มเกินรายการที่ยอมให้ล้ม (ผลข้างเคียงที่ไม่อยู่ใน BUGS.md)

จำแนกสาเหตุเท่าที่ตรวจได้จากไฟล์ผล (ไม่ได้รันซ้ำและไม่ได้เปิดโค้ดเว็บ) · ทุกตัวไม่ใช่ timeout หรือหา element ไม่เจอ

| บั๊ก | TC ที่ล้มเกิน | ข้อความที่ล้ม | สาเหตุที่น่าจะเป็น | ประเภท |
|---|---|---|---|---|
| B03 (และ B03,B07) | TC-NOTI-02 (`part2.spec.js:157` ในฟังก์ชัน `notifications`) | `/api/notifications` ของ `off.reg2` ที่นาฬิกา 2026-12-05 10:00: expected length 10 received length 9 · ที่ได้เป็น `overdue` ทั้ง 9 รายการ (…013, 015, 024–030) ตาม fixture ที่คาด `overdue` 9 + `near` 1 (…016) | **ฟังก์ชันวันทำการตัวเดียวกันกับ B03** คำนวณระดับ SLA เพี้ยน (ไม่ข้ามวันหยุด 7 ธ.ค.) จึงขาดการแจ้งเตือนระดับ `near` ของ …016 ไป 1 รายการ (…016 อ่านจาก fixture ในโค้ด test บรรทัด 150–153 ไม่ได้อยู่ในข้อความที่ล้ม) — เป็นกลไกเดียวกับที่ TC-SLA-03 ล้ม (ระดับ `ปกติ` แทน `ใกล้ครบกำหนด`) · สรุปจากข้อมูลในผล: จำนวน 9 กับ 10 และไม่มีแถว `near` ในรายการที่ได้ (ไม่ได้ตรวจโค้ดฝั่งเซิร์ฟเวอร์) | ผลข้างเคียงจากสูตรร่วมกัน (SLA → ระดับเตือน → การแจ้งเตือน) น่าจะยอมรับได้ในเชิงตรรกะ แต่ **ต้องเพิ่มลงรายการ "ที่อาจล้มด้วย" ของ B03 ใน BUGS.md** |
| B06 | TC-DOC-01 (`part2.spec.js:379`) | `GET /api/documents/<docNo>/pdf` ด้วยบัญชีสมชาย (ผู้ที่ไม่ใช่เจ้าของเอกสารของคำขอ 25) expected 404 received 200 | บั๊ก IDOR ของ B06 ครอบคลุมการตรวจเจ้าของคำขอ/เอกสารทั้งชุด ไม่ใช่แค่หน้า/API `GET /api/cases/:no` จึงทำให้ผู้ที่ไม่ใช่เจ้าของดาวน์โหลด PDF ได้ (ได้ 200 แทน 404) · ข้อนี้ TC-DOC-01 มีการตรวจสิทธิ์ท้ายเคสนี้ด้วย | บั๊กรั่วเกินจุดที่ระบุ หรือ BUGS.md ระบุขอบเขตแคบเกิน (ดู "ข้อสังเกต") |
| B06 | TC-RBAC-05 (`part2.spec.js:798`) | `GET /api/cases/<…025>/files` ด้วยบัญชี `1101700123456` (label `list 25`) expected 404 received 200 | เช่นเดียวกัน: การเลิกตรวจเจ้าของคำขอรั่วไปถึง endpoint รายการไฟล์แนบ (`/files`) ซึ่งเป็นทรัพยากรลูกของคำขอ | บั๊กรั่วเกินจุดที่ระบุ หรือ BUGS.md ระบุขอบเขตแคบเกิน |

### ข้อสังเกต / ข้อเสนอ (ยังไม่ได้ทำ)

- **B03 → TC-NOTI-02**: เสนอเพิ่ม TC-NOTI-02 ในคอลัมน์ "TC ที่อาจล้มด้วย" ของ B03 ใน BUGS.md (เหตุผลเดียวกับ TC-SLA-03)
- **B06 → TC-DOC-01, TC-RBAC-05**: ตามกติกา BUGS.md ข้อ 1 บั๊กต้องเปลี่ยนพฤติกรรม **เฉพาะจุดที่ระบุ** (หน้า `/citizen/cases/:no` และ `GET /api/cases/:no`) ผลที่เห็นคือเลิกตรวจสิทธิ์เจ้าของไปถึง `/files` และ PDF ของเอกสาร จึงมีสองทาง: (ก) แก้เว็บให้ B06 ปิดตรวจเจ้าของเฉพาะ `GET /api/cases/:no` กับหน้าเว็บ ให้ TC-DOC-01 กับ TC-RBAC-05 ผ่านตอนเปิด B06 หรือ (ข) เพิ่ม TC ทั้งสองลงใน "TC ที่อาจล้มด้วย" ของ B06 เพราะใช้ตัวตรวจเจ้าของคำขอร่วมกัน · ไฟล์ผลไม่พอจะบอกว่าเว็บแชร์ฟังก์ชันตรวจสิทธิ์ตัวเดียวกันหรือไม่ จึงยังไม่สรุปว่าเป็นทางไหน (ต้องเปิดโค้ดเว็บของ B06)
- TC อื่นทั้งหมดผ่านในทุกรอบที่เปิดบั๊ก ไม่พบบั๊กรั่วอื่น
- ขั้น 6 ของ BUGS.md หัวข้อ 3 (ปิดบั๊กทั้งหมดแล้วกลับมา 51/51): รอบ `normalA` และ `normalB` ถูกรันก่อนรอบเปิดบั๊กตามลำดับสคริปต์ ไม่มีรอบหลังปิดบั๊กในไฟล์ผล จึงยังไม่มีหลักฐานของขั้นนี้ในชุดนี้ (รอบถัดไปที่ไม่ตั้ง BUG_MODE จะให้ผลนี้ได้)

## 4. ตารางบันทึกผล (รูปแบบ BUGS.md หัวข้อ 4)

| บั๊ก | TC ที่คาดว่าล้ม (จากตาราง 2) | TC ที่ล้มจริง | TC ล้มเกินที่คาด | TC ที่ควรล้มแต่ผ่าน | ผล |
|---|---|---|---|---|---|
| (ปกติ) | – | – | – | – | 51/51 passed (2 รอบ) |
| B01 | TC-FEE-01 | TC-FEE-01 | – | – | ✅ 50 passed · 1 failed |
| B02 | TC-UPLOAD-01 | TC-UPLOAD-01 | – | – | ✅ 50 passed · 1 failed |
| B03 | TC-SLA-01 · TC-SLA-02 (อาจล้มด้วย TC-SLA-03 · TC-RBAC-04) | TC-SLA-01 · 02 · 03 · TC-RBAC-04 · TC-NOTI-02 | TC-NOTI-02 | – | ⚠️ 46 passed · 5 failed |
| B04 | TC-SLA-02 | TC-SLA-02 | – | – | ✅ 50 passed · 1 failed |
| B05 | TC-PAY-01 | TC-PAY-01 | – | – | ✅ 50 passed · 1 failed |
| B06 | TC-RBAC-01 | TC-RBAC-01 · TC-DOC-01 · TC-RBAC-05 | TC-DOC-01 · TC-RBAC-05 | – | ⚠️ 48 passed · 3 failed |
| B07 | TC-RBAC-02 | TC-RBAC-02 | – | – | ✅ 50 passed · 1 failed |
| B08 | TC-QUEUE-02 | TC-QUEUE-02 | – | – | ✅ 50 passed · 1 failed |
| B09 | TC-PDPA-02 | TC-PDPA-02 | – | – | ✅ 50 passed · 1 failed |
| B10 | TC-DASH-02 (อาจล้มด้วย TC-DASH-01 · TC-DASH-03) | TC-DASH-01 · 02 · 03 | – (อยู่ในรายการที่ยอมรับ) | – | ✅ 48 passed · 3 failed |
| B11 | TC-PDPA-03 · TC-AUDIT-01 | TC-PDPA-03 · TC-AUDIT-01 | – | – | ✅ 49 passed · 2 failed |
| B12 | TC-WORKFLOW-04 | TC-WORKFLOW-04 | – | – | ✅ 50 passed · 1 failed |
| B03,B07 | union | TC-SLA-01 · 02 · 03 · TC-NOTI-02 · TC-RBAC-02 · TC-RBAC-04 | TC-NOTI-02 | – | ⚠️ 45 passed · 6 failed (= union พอดี) |
| B01,B05,B09 | union | TC-FEE-01 · TC-PAY-01 · TC-PDPA-02 | – | – | ✅ 48 passed · 3 failed (= union พอดี) |
