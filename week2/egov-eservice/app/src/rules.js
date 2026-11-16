'use strict';
/**
 * rules.js (B03) · กฎธุรกิจล้วน: ค่าธรรมเนียม · วันทำการ/วันหยุด · SLA · ระดับเตือน
 * =====================================================================================
 * เป็นไลบรารีฟังก์ชันล้วน (ไม่ผูก route) — require ได้จากทุกโมดูล: const rules = require('./rules')
 * ไม่เรียก Date.now()/new Date() เพื่ออ่านเวลาเครื่อง · เวลาปัจจุบันต้องส่งเข้ามา (ctx.clock.now()) เสมอ
 * แหล่งกฎ: REQUIREMENTS BR-05 BR-12 BR-13 · DECISIONS §0 §3 §8 §18 · TEST-DATA §2 §3
 *
 * สรุป API (ทุกตัว export ที่ท้ายไฟล์)
 *   ── ค่าธรรมเนียม (BR-04 BR-05)
 *   calcFee(service, input)        → {ok:true, fee} | {ok:false, status:400, code, message}
 *        service = แถวตาราง services {id, fee, fee_per_sqm, sla}  (หรือ {id, fee, feePerSqm})
 *        input   = {qty} (SV-01, ว่าง = 1) · {areaSqm} (SV-03) · SV-02 ไม่ต้องมี
 *   feeSv01/feeSv02/feeSv03        → ตัวคำนวณย่อย
 *   ── วันทำการ (วัน = 'YYYY-MM-DD')
 *   loadHolidays(db)               → Set ของวันหยุดจากตาราง holidays (เรียกใหม่ทุกครั้งที่ใช้ ไม่ cache)
 *   isBusinessDay(date, holidays)  · nextBusinessDay(date, holidays) · addBusinessDays(date, n, holidays)
 *   businessDaysBetween(from, to, holidays) → จำนวนวันทำการใน (from, to]
 *   ── SLA (BR-12 BR-13)
 *   calcDueAt(paidAtIso, slaDays, holidays)                → ISO กำหนดเสร็จ (คำนวณครั้งเดียวตอนชำระ)
 *   extendDueAtOnResubmit(dueAtIso, returnedAtIso, resubmittedAtIso, holidays) → ISO ใหม่ (หยุดนับ)
 *   pausedBusinessDays(returnedAtIso, resubmittedAtIso, holidays)
 *   remainingBusinessDays(nowMs, dueAtIso, holidays)       → วันคงเหลือ (ทำการหลังวันนี้ ถึงวันกำหนด รวมวันกำหนด)
 *   slaLevel({status, dueAt, nowMs, holidays})             → 'normal'|'near'|'overdue'|'paused'|'closed'|null
 *   SLA_LEVEL_TH · slaLevelTh(code) · fmtBaht(n) · fmtThaiDateTime(iso)
 *
 * BUG_MODE ที่ฝังไว้ที่นี่ (ฝั่งเซิร์ฟเวอร์ ใน "การคำนวณ" เท่านั้น ไม่กระทบ seed — BUGS ข้อ 1–2):
 *   B01  SV-03 พื้นที่ 101 คิด ฿1,000 (ใช้ `> 101` แทน `>= 101`)
 *   B03  วันทำการไม่ข้ามวันหยุดในตาราง (ข้ามแค่ ส-อา) · ใช้ทั้งกำหนดเสร็จ หยุดนับ และวันคงเหลือ
 *   B04  SLA ไม่หยุดนับระหว่างรอแก้ไข (กำหนดเสร็จไม่ขยาย)
 */
const clock = require('./clock');
const bug = require('./bugs');

// ---------------------------------------------------------------- ค่าคงที่ตามชุดโจทย์
const CUTOFF = { hh: 16, mm: 30, ss: 0 }; // A-03 · ยื่นตั้งแต่ 16:30:00 ขึ้นไป = วันทำการถัดไป
const SV01_MIN_QTY = 1, SV01_MAX_QTY = 5;
const SV03_MIN_AREA = 1, SV03_MAX_AREA = 500, SV03_BASE_AREA = 100;
const DEFAULT_QTY = 1; // A-56

const MSG = {
  INVALID_QTY: 'จำนวนฉบับต้อง 1–5 ฉบับ',
  INVALID_AREA: 'กรุณาระบุพื้นที่ 1–500 ตร.ม.',
  AREA_TOO_LARGE: 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน',
};

const SLA_LEVEL_TH = {
  normal: 'ปกติ', near: 'ใกล้ครบกำหนด', overdue: 'เกินกำหนด', paused: 'หยุดนับ', closed: 'ปิดแล้ว',
};
const slaLevelTh = (code) => SLA_LEVEL_TH[code] || '';

// ---------------------------------------------------------------- ค่าธรรมเนียม
const err = (code) => ({ ok: false, status: 400, code, message: MSG[code] });

/** แปลงค่าที่ผู้ใช้ส่งมาเป็นจำนวนเต็ม · ไม่ใช่จำนวนเต็ม (ทศนิยม, ข้อความ, null …) → null */
function toInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v)) {
    const n = parseInt(v, 10);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

const perSqmOf = (svc) => (svc.fee_per_sqm !== undefined ? svc.fee_per_sqm : svc.feePerSqm) || 0;

/** SV-01: fee ต่อฉบับ × qty (1–5) · qty ว่าง = 1 (A-56) */
function feeSv01(svc, qty) {
  const q = qty === undefined || qty === null || qty === '' ? DEFAULT_QTY : toInt(qty);
  if (q === null || q < SV01_MIN_QTY || q > SV01_MAX_QTY) return err('INVALID_QTY');
  return { ok: true, fee: svc.fee * q };
}

/** SV-02: เหมาจ่าย */
function feeSv02(svc) {
  return { ok: true, fee: svc.fee };
}

/** SV-03: 1–100 → ฐาน · 101–500 → ฐาน + ต่อตร.ม. × (พื้นที่ − 100) · นอกช่วงปฏิเสธ */
function feeSv03(svc, areaSqm) {
  const a = toInt(areaSqm);
  if (a === null || a < SV03_MIN_AREA) return err('INVALID_AREA');
  if (a > SV03_MAX_AREA) return err('AREA_TOO_LARGE');
  // B01: เงื่อนไขขอบผิด (`> 101` แทน `>= 101`) → พื้นที่ 101 คิดแค่ฐาน (102 ขึ้นไปยังถูกต้อง)
  const overBase = bug('B01') ? a > SV03_BASE_AREA + 1 : a > SV03_BASE_AREA;
  const fee = overBase ? svc.fee + perSqmOf(svc) * (a - SV03_BASE_AREA) : svc.fee;
  return { ok: true, fee };
}

/** ตัวกลาง: เลือกสูตรตามรหัสบริการ */
function calcFee(service, input = {}) {
  if (!service) return { ok: false, status: 404, code: 'NOT_FOUND', message: 'ไม่พบบริการ' };
  switch (service.id) {
    case 'SV-01': return feeSv01(service, input.qty);
    case 'SV-02': return feeSv02(service);
    case 'SV-03': return feeSv03(service, input.areaSqm !== undefined ? input.areaSqm : input.area);
    default: return { ok: false, status: 404, code: 'NOT_FOUND', message: 'ไม่พบบริการ' };
  }
}

// ---------------------------------------------------------------- วันทำการ
/** อ่านวันหยุดจากตาราง holidays → Set('YYYY-MM-DD') · ไม่ cache เพื่อให้ admin เพิ่ม/ลบแล้วมีผลทันที */
function loadHolidays(db) {
  return new Set(db.all('SELECT date FROM holidays').map((r) => r.date));
}

function toHolidaySet(h) {
  if (!h) return new Set();
  if (h instanceof Set) return h;
  return new Set(Array.from(h, (x) => (typeof x === 'string' ? x : x && x.date)));
}

/** จันทร์–ศุกร์ ที่ไม่อยู่ในตารางวันหยุด (A-02) · B03: ไม่สนตารางวันหยุด */
function isBusinessDay(date, holidays) {
  const dow = clock.parts(clock.atDate(date)).dow;
  if (dow === 0 || dow === 6) return false;
  if (bug('B03')) return true;
  return !toHolidaySet(holidays).has(date);
}

/** วันทำการถัดไป "หลัง" date (ไม่รวม date เอง) */
function nextBusinessDay(date, holidays) {
  let d = clock.addDays(date, 1);
  while (!isBusinessDay(d, holidays)) d = clock.addDays(d, 1);
  return d;
}

/** วันทำการที่ n หลัง date (n ≥ 0 · n = 0 → date เดิม ไม่ปรับ) */
function addBusinessDays(date, n, holidays) {
  let d = date;
  for (let i = 0; i < n; i++) d = nextBusinessDay(d, holidays);
  return d;
}

/** จำนวนวันทำการใน (from, to] — ไม่รวม from รวม to · to ≤ from → 0 */
function businessDaysBetween(from, to, holidays) {
  let count = 0;
  let d = clock.addDays(from, 1);
  while (d <= to) {
    if (isBusinessDay(d, holidays)) count++;
    d = clock.addDays(d, 1);
  }
  return count;
}

// ---------------------------------------------------------------- SLA
const dueIso = (date) => clock.toIso(clock.atDate(date, CUTOFF.hh, CUTOFF.mm, CUTOFF.ss));

function mustParse(iso) {
  const ms = clock.parseIso(iso);
  if (ms === null) throw new Error('rules: เวลาไม่ถูกต้อง ' + iso);
  return ms;
}

/**
 * BR-12 · D0 = วันที่ชำระ ถ้าเป็นวันทำการและก่อน 16:30:00 · ไม่เช่นนั้นวันทำการถัดไป
 * กำหนดเสร็จ = วันทำการที่ N หลัง D0 เวลา 16:30:00 → ISO +07:00
 */
function startDay(paidAtIso, holidays) {
  const p = clock.parts(mustParse(paidAtIso));
  const beforeCutoff = (p.hh * 3600 + p.mm * 60 + p.ss) < (CUTOFF.hh * 3600 + CUTOFF.mm * 60 + CUTOFF.ss);
  return isBusinessDay(p.date, holidays) && beforeCutoff ? p.date : nextBusinessDay(p.date, holidays);
}

function calcDueAt(paidAtIso, slaDays, holidays) {
  const d0 = startDay(paidAtIso, holidays);
  return dueIso(addBusinessDays(d0, slaDays, holidays));
}

/** BR-13 · จำนวนวันทำการที่หยุดนับ = วันทำการใน (วันที่ตีกลับ, วันที่ส่งแก้] (นับตามวันที่ ไม่ขึ้นกับเวลา) */
function pausedBusinessDays(returnedAtIso, resubmittedAtIso, holidays) {
  const from = clock.parts(mustParse(returnedAtIso)).date;
  const to = clock.parts(mustParse(resubmittedAtIso)).date;
  return businessDaysBetween(from, to, holidays);
}

/**
 * BR-13 · กำหนดเสร็จใหม่ = กำหนดเดิม + วันทำการที่หยุดนับ (เวลา 16:30 เหมือนเดิม)
 * holidays = ตารางวันหยุด ณ เวลาที่ส่งแก้ (A-42) · B04: ไม่หยุดนับ → คืนกำหนดเดิม
 */
function extendDueAtOnResubmit(dueAtIso, returnedAtIso, resubmittedAtIso, holidays) {
  if (bug('B04')) return dueAtIso;
  const n = pausedBusinessDays(returnedAtIso, resubmittedAtIso, holidays);
  if (n === 0) return dueAtIso;
  const dueDate = clock.parts(mustParse(dueAtIso)).date;
  return dueIso(addBusinessDays(dueDate, n, holidays));
}

/** วันคงเหลือ = จำนวนวันทำการใน (วันนี้, วันกำหนดเสร็จ] (รวมวันกำหนด) · วันนี้ ≥ วันกำหนด → 0 */
function remainingBusinessDays(nowMs, dueAtIso, holidays) {
  const today = clock.parts(nowMs).date;
  const dueDate = clock.parts(mustParse(dueAtIso)).date;
  return businessDaysBetween(today, dueDate, holidays);
}

const CLOSED_STATUSES = new Set(['COMPLETED', 'REJECTED', 'CANCELLED']);

/**
 * ระดับเตือน (DECISIONS §8 · CONTRACT §4.2)
 *   closed  : COMPLETED / REJECTED / CANCELLED
 *   paused  : NEED_FIX
 *   overdue : ตอนนี้ > กำหนดเสร็จ (เกิน 1 วินาทีก็เกิน)
 *   near    : วันคงเหลือ ≤ 1 และตอนนี้ ≤ กำหนดเสร็จ
 *   normal  : วันคงเหลือ ≥ 2
 * ไม่มีกำหนดเสร็จ (ร่าง / รอชำระ) → null
 */
function slaLevel({ status, dueAt, nowMs, holidays }) {
  if (CLOSED_STATUSES.has(status)) return 'closed';
  if (status === 'NEED_FIX') return 'paused';
  if (!dueAt) return null;
  const now = nowMs === undefined ? clock.now() : nowMs;
  if (now > mustParse(dueAt)) return 'overdue';
  return remainingBusinessDays(now, dueAt, holidays) <= 1 ? 'near' : 'normal';
}

// ---------------------------------------------------------------- รูปแบบแสดงผล (A-04)
/** 1010 → '฿1,010' · ค่าที่ไม่ใช่จำนวนเต็ม → '–' */
function fmtBaht(n) {
  return Number.isInteger(n) ? '฿' + n.toLocaleString('en-US') : '–';
}

const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

/** ISO → '4 ธ.ค. 2569 16:30' (พ.ศ. ย่อ ไม่มีวินาที) */
function fmtThaiDateTime(iso) {
  const ms = clock.parseIso(iso);
  if (ms === null) return '';
  const p = clock.parts(ms);
  return `${p.d} ${TH_MONTHS[p.m - 1]} ${p.be} ${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
}

module.exports = {
  // ค่าธรรมเนียม
  calcFee, feeSv01, feeSv02, feeSv03, FEE_MESSAGES: MSG,
  // วันทำการ
  loadHolidays, isBusinessDay, nextBusinessDay, addBusinessDays, businessDaysBetween,
  // SLA
  CUTOFF, startDay, calcDueAt, pausedBusinessDays, extendDueAtOnResubmit, remainingBusinessDays, slaLevel,
  SLA_LEVEL_TH, slaLevelTh,
  // แสดงผล
  fmtBaht, fmtThaiDateTime,
};
