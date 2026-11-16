'use strict';
/**
 * นาฬิกาทดสอบ (Asia/Bangkok +07:00) — แหล่งเวลาเดียวของกฎธุรกิจ
 * ------------------------------------------------------------------
 * กติกา (README ข้อ 5, CONTRACT §8): ทุกกฎเวลา (SLA, QR อายุ, ล็อก OTP, หมดอายุเอกสาร, 168 ชม.,
 * เวลาใน Audit/ไทม์ไลน์) ต้องเรียก clock.now() / clock.nowIso() เท่านั้น
 * ห้ามเรียก Date.now() / new Date() ตรง ๆ ในกฎธุรกิจ (ไฟล์นี้เป็นที่เดียวที่แตะเวลาเครื่อง)
 *
 *  - TEST_MODE=1 → นาฬิกา "แช่แข็ง" เริ่มที่ 2026-12-01T09:00:00+07:00 และเปลี่ยนได้ด้วย PUT /api/test/clock
 *  - ไม่ตั้ง TEST_MODE → ใช้เวลาจริงของเครื่อง (อ่านผ่านไฟล์นี้เท่านั้น)
 * ประเทศไทยไม่มี DST → ใช้ offset คงที่ +07:00 คำนวณเอง ไม่พึ่ง tz database
 *
 * ข้อตกลงรูปแบบเวลา: เก็บ/ส่งออกเป็นสตริง ISO ความละเอียดวินาที offset +07:00 เสมอ
 * (เช่น 2026-12-04T16:30:00+07:00) → เรียงลำดับ/เทียบด้วย string ได้ตรง ๆ
 */
const { TEST_MODE, DEFAULT_NOW } = require('./config');

const OFFSET_MS = 7 * 3600 * 1000;
const DAY_MS = 86400000;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** แปลง ISO (ต้องมี offset) → epoch ms · ไม่ถูกต้อง → null */
function parseIso(s) {
  if (typeof s !== 'string') return null;
  const m = ISO_RE.exec(s.trim());
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S = '0', frac = '', off] = m;
  const y = +Y, mo = +Mo, d = +D, h = +H, mi = +Mi, sec = +S;
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || sec > 59) return null;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null; // เช่น 30 ก.พ.
  let offMin = 0;
  if (off !== 'Z') {
    const sign = off[0] === '-' ? -1 : 1;
    const oh = +off.slice(1, 3), om = +off.slice(4, 6);
    if (oh > 23 || om > 59) return null;
    offMin = sign * (oh * 60 + om);
  }
  const ms = Date.UTC(y, mo - 1, d, h, mi, sec) - offMin * 60000 + (frac ? Math.round(parseFloat('0' + frac) * 1000) : 0);
  return Number.isFinite(ms) ? ms : null;
}

/** epoch ms → "YYYY-MM-DDTHH:mm:ss+07:00" */
function toIso(ms) {
  const d = new Date(ms + OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+07:00`;
}

/** แยกส่วนประกอบเวลาไทย: {y, m, d, hh, mm, ss, dow(0=อา..6=ส), date:'YYYY-MM-DD', time:'HH:mm:ss', be(พ.ศ.)} */
function parts(ms) {
  const d = new Date(ms + OFFSET_MS);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, dd = d.getUTCDate();
  return {
    y, m, d: dd, hh: d.getUTCHours(), mm: d.getUTCMinutes(), ss: d.getUTCSeconds(),
    dow: d.getUTCDay(), date: `${y}-${pad(m)}-${pad(dd)}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
    be: y + 543,
  };
}

/** epoch ms ของเวลา HH:mm:ss (เวลาไทย) บนวันที่ 'YYYY-MM-DD' */
function atDate(dateStr, hh = 0, mm = 0, ss = 0) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm, ss) - OFFSET_MS;
}

/** บวก n วันปฏิทินให้ 'YYYY-MM-DD' */
function addDays(dateStr, n) {
  return parts(atDate(dateStr) + n * DAY_MS).date;
}

// ---------------------------------------------------------------- สถานะนาฬิกา
const defaultMs = parseIso(DEFAULT_NOW);
let frozenMs = defaultMs;

function realMs() {
  // ใช้เฉพาะงานโครงสร้างพื้นฐานที่ไม่ใช่กฎธุรกิจ (เช่น หมดอายุ session) และโหมดไม่ทดสอบ
  return Date.now();
}

/** เวลาปัจจุบัน (epoch ms) ตามนาฬิกาทดสอบ */
function now() {
  return TEST_MODE ? frozenMs : realMs();
}
const nowIso = () => toIso(now());
const nowDate = () => parts(now()).date;

/** PUT /api/test/clock · คืน null ถ้าไม่ถูกต้อง (→ 400 INVALID_TIME) · ต้องมี offset */
function set(iso) {
  const ms = parseIso(iso);
  if (ms === null) return null;
  frozenMs = ms;
  return nowIso();
}

/** POST /api/test/reset */
function reset() {
  frozenMs = defaultMs;
  return nowIso();
}

module.exports = {
  now, nowIso, nowDate, set, reset, parseIso, toIso, parts, atDate, addDays, realMs,
  DEFAULT_NOW, OFFSET_MS, DAY_MS,
};
