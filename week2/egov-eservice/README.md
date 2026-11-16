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

## สถานะที่ยังไม่ครบ

- `docker compose up --build` ทดสอบบน Docker Desktop (Windows) แล้ว เว็บ healthy และชุดเต็ม 51 TC ผ่านจาก container แยกอีกตัว
- GIF ของ TC ระดับ P1 ครบ 43 ข้อ: 40 ข้อเป็นวิดีโอหน้าเว็บ และ 3 ข้อ (TC-PAY-02, TC-PAY-03, TC-PDPA-02) ที่ยิง API ล้วนเป็นภาพบันทึกการเรียก API จริงของเทสต์ ดู `test-report/gif/NOTE.md`
- B06 ล้มเกินรายการ แก้แล้วที่เว็บ (`src/auth.js`, `src/citizen.js`) · B03 → TC-NOTI-02 เป็นผลข้างเคียงจากฟังก์ชันวันทำการร่วมกัน ยอมรับและเสนอให้ TA เพิ่มในรายการ (ดู `BUG-HUNT.md`)
- ผลรอบเปิดบั๊กส่วนใหญ่มาจากสคริปต์ของเอเจนต์ B14 ยังไม่ได้รันซ้ำเอง (ยกเว้น B06)
- `gantt-actual.png` / `compare.png`: แท่ง B14 ใน Gantt ยาวราว 43 นาที แต่ `compare.png` ระบุ B14 1.4 นาที เพราะ B14 รันสองครั้ง (รอบแรก timeout 25 นาที แล้วรันซ้ำแบบสั้น) เวลารวมจริง 88.2 นาทีจึงรวมรอบที่ล้มและช่วงรอ ไม่ใช่ความเร็วของทีม · ฝั่ง Claude ในภาพมีเฉพาะ `yolo2` (`yolo1` ไม่ได้รับงาน)
