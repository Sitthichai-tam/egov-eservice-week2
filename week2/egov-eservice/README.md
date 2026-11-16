# e-Service กลาง · เทศบาลนครตัวอย่าง (ระบบสมมติ)

เว็บที่ทีมเอเจนต์ (`dag-planner` + `agent-team`) สร้างตามชุดโจทย์ Week 2 ThaiD, PromptPay และลายเซ็นดิจิทัลเป็นตัวจำลองทั้งหมด ไม่เชื่อมระบบจริง

## รันเว็บ

```bash
cd app
docker compose up --build                                # เว็บถูกต้อง (test hook ปิด)  → http://localhost:3000
TEST_MODE=1 docker compose up --build                    # เปิด /api/test/* เพื่อรัน Playwright
TEST_MODE=1 BUG_MODE=B03,B07 docker compose up --build   # เปิดบั๊กตาม BUGS.md
```

PowerShell ใช้ `$env:TEST_MODE=1; docker compose up --build` แทนบรรทัดข้างบน · เปลี่ยนพอร์ตด้วย `APP_PORT=8080` · ตรวจสุขภาพที่ `GET /api/health`

บัญชีทดสอบอยู่ใน `TEST-DATA.md` ของชุดโจทย์ (ประชาชนล็อกอินด้วยเลขบัตร 13 หลัก + OTP `123456`)

## รันชุดทดสอบ (51 TC)

```bash
cd app
npm install
npx playwright install chromium
# เปิดเว็บด้วย TEST_MODE=1 ไว้ก่อน (ดูด้านบน) แล้วรัน
npx playwright test --reporter=list
```

## ไฟล์ในโฟลเดอร์นี้

| ไฟล์ | คืออะไร |
|---|---|
| `blocks.json` `dag.png` `gantt-plan.png` `PLAN.md` | แผนงาน (ขั้น 1) |
| `REPORT.md` `gantt-actual.png` `compare.png` | แผนเทียบของจริง (ขั้น 3) |
| `app/` | เว็บ + ชุด Playwright (`e2e/`) |
| `test-report/` | ผลรันเต็ม 51 TC (`results.json`, `html/`, `gif/`) และ `FAILURE-TRIAGE.md` (จำแนก TC ที่ล้มระหว่างทาง) |
| `TEST-RESULT.md` `BUG-HUNT.md` | ผลล่าบั๊ก B01–B12 (ขั้น 5) |

## สถานะและข้อจำกัด

**ยืนยันแล้ว**
- ชุดเต็ม 51 TC ผ่าน 51/51 (`test-report/results.json`) และ `docker compose up --build` ทดสอบบน Docker Desktop (Windows) แล้ว เว็บ healthy และชุดเต็มผ่านจาก container แยกอีกตัว
- บั๊ก B01–B12 จับได้ 12/12 ยืนยันด้วยหลักฐานอิสระ 2 ชุดที่ตรงกัน: รันซ้ำโดยผู้เขียน 19 รอบ (`test-report/bug-rounds/`) และเอเจนต์ B14 รันใหม่ (`test-report/b14-agent-rerun-raw/`, `TEST-RESULT.md`) · B08 ล้มทุกครั้ง · ปิดบั๊กแล้วกลับมา 51/51 (ดู `BUG-HUNT.md`)
- GIF ของ TC ระดับ P1 ครบ 43 ข้อ: 40 ข้อเป็นวิดีโอหน้าเว็บ และ 3 ข้อ (TC-PAY-02, TC-PAY-03, TC-PDPA-02) ที่ยิง API ล้วนเป็นภาพบันทึกการเรียก API จริงของเทสต์ ดู `test-report/gif/NOTE.md`
- B06 เคยล้มเกินรายการ แก้แล้วที่เว็บ (`src/auth.js`, `src/citizen.js`) ผู้เขียนรายงานเป็นคนแก้ · B03 → TC-NOTI-02 เป็นผลข้างเคียงจากฟังก์ชันวันทำการร่วมกัน ยอมรับและเสนอให้ TA เพิ่มในรายการ "อาจล้มด้วย"

**ข้อจำกัด**
- `REPORT.md`, `gantt-actual.png`, `compare.png` มาจากรันแรก (`egov-eservice-20261116-131519`) ซึ่งบล็อก B14 หมดเวลา 25 นาที แล้วเสร็จด้วยการเรียบเรียงผลจากไฟล์เดิม ภายหลัง B14 ถูกรันใหม่ด้วยเอเจนต์เต็มรูปแบบ (`egov-b14-rerun`, `yolo1`, 1,960 วินาที, สำเร็จ) ผลของรอบนี้อยู่ใน `TEST-RESULT.md` แต่ไม่อยู่ในภาพ Gantt
- เวลาใน Gantt: แท่ง B14 ยาวราว 43 นาที แต่ `compare.png` ระบุ 1.4 นาที เพราะ B14 รันสองครั้ง เวลารวมจริง 88.2 นาที (แผน 20.3) รวมรอบที่ล้มและช่วงรอ ไม่ใช่ความเร็วของทีม · ฝั่ง Claude ในรันแรกมีเฉพาะ `yolo2`
- ไม่มีประวัติเนื้อหาโค้ดก่อน/หลังของการแก้เว็บรอบแรก คอลัมน์ "แก้อะไร" ใน `test-report/FAILURE-TRIAGE.md` จึงเป็นการอนุมาน
- ขั้น "ให้ Claude สร้างสกิลเอง" ของบท 03–05 ข้ามไป ใช้สกิลสำเร็จรูป (`agent-team`, `dag-planner`) แทน
