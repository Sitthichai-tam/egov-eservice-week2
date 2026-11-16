'use strict';
/**
 * ฐานข้อมูล SQLite (node:sqlite ในตัว Node 22) · ไฟล์อยู่ที่ DB_PATH (CONTRACT §0 ข้อ 11)
 * ------------------------------------------------------------------
 * ทุกโมดูลใช้อ็อบเจ็กต์ `db` ตัวเดียวกัน (wrapper คงที่ ถือไว้ได้ ไม่ต้องกลัว reset)
 *   db.run(sql, ...params)  → {changes, lastInsertRowid}
 *   db.get(sql, ...params)  → แถวเดียว | undefined
 *   db.all(sql, ...params)  → แถวทั้งหมด
 *   db.exec(sql)            → รันหลายคำสั่ง
 *   db.tx(fn)               → ธุรกรรมแบบ "ซิงก์" (BEGIN IMMEDIATE…COMMIT) · fn ห้าม await · ซ้อนได้ (ร่วมธุรกรรมนอกสุด)
 *   db.nextSeq(name)        → เลขลำดับถัดไปแบบ atomic (ตาราง counters) ใช้กับเลขคำขอ/ใบเสร็จ/เอกสาร/ร่าง/ref ชำระ
 * พารามิเตอร์ undefined → NULL · boolean → 1/0
 *
 * ข้อตกลงข้อมูล
 *  - เวลาเก็บเป็นสตริง ISO "YYYY-MM-DDTHH:mm:ss+07:00" (สร้างด้วย clock.toIso/nowIso เท่านั้น) → เรียง/เทียบ string ได้
 *  - ห้ามเก็บเลขบัตร/เบอร์โทรตรง ๆ ที่ใด (ใช้ security.encrypt/idHash) รวมถึง audit detail และ log
 *  - โมดูลอื่นเพิ่มตารางของตัวเองได้โดย export `schema` (SQL) จากไฟล์ของโมดูล · server.js จะรันหลัง schema หลักทุกครั้งที่ DB ถูกสร้าง
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const cfg = require('./config');

const SCHEMA_VERSION = 1;

const CORE_SCHEMA = `
CREATE TABLE users (
  username    TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('citizen','officer','head','executive','auditor','admin')),
  dept        TEXT NOT NULL DEFAULT '',          -- officer: registry | works · อื่น ๆ ''
  pw_hash     TEXT,                              -- เจ้าหน้าที่ (scrypt) · citizen NULL
  id_hash     TEXT UNIQUE,                       -- citizen: HMAC ของเลขบัตร (ไว้ค้นหา)
  id_enc      TEXT,                              -- citizen: เลขบัตร AES-256-GCM
  mobile_enc  TEXT,                              -- citizen: เบอร์โทร AES-256-GCM
  email       TEXT NOT NULL DEFAULT '',
  registered  INTEGER NOT NULL DEFAULT 0,        -- citizen: 1 = ลงทะเบียนแล้ว
  consent_at  TEXT,                              -- ยอมรับ PDPA เมื่อ
  created_at  TEXT NOT NULL
);

-- session ของทุกคน (reset ลบทั้งไฟล์ DB → ล็อกอินใหม่ตาม CONTRACT §0 ข้อ 9)
CREATE TABLE sessions (
  token       TEXT PRIMARY KEY,
  username    TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'full',      -- full | register (citizen ที่ยังไม่ลงทะเบียน เข้าได้เฉพาะ /register)
  role        TEXT NOT NULL,                     -- สแนปช็อตตอนล็อกอิน (แก้บทบาทมีผลตอนล็อกอินครั้งถัดไป)
  dept        TEXT NOT NULL DEFAULT '',
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_real INTEGER NOT NULL                  -- epoch ms เวลาจริง (ไม่ผูกนาฬิกาทดสอบ)
);

-- ตัวนับ OTP ผิด / การล็อก (ผูกกับ id_hash)
CREATE TABLE otp_attempts (
  id_hash      TEXT PRIMARY KEY,
  fails        INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT                              -- ISO +07:00
);

CREATE TABLE services (
  id          TEXT PRIMARY KEY,                  -- SV-01 SV-02 SV-03
  name        TEXT NOT NULL,
  fee         INTEGER NOT NULL,                  -- SV-01 ต่อฉบับ · SV-02 เหมา · SV-03 = feeBase (1,000)
  fee_per_sqm INTEGER NOT NULL DEFAULT 0,        -- SV-03 เท่านั้น (10)
  sla         INTEGER NOT NULL,                  -- วันทำการ
  sort        INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE service_docs (
  service_id  TEXT NOT NULL,
  doc_key     TEXT NOT NULL,                     -- id-card map site-photo plan deed
  label       TEXT NOT NULL,
  required    INTEGER NOT NULL DEFAULT 0,
  pdf_only    INTEGER NOT NULL DEFAULT 0,
  sort        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (service_id, doc_key)
);
CREATE TABLE holidays (
  date        TEXT PRIMARY KEY,                  -- YYYY-MM-DD (ค.ศ.)
  name        TEXT NOT NULL
);

-- ร่าง (DR-0001…) = DRAFT | PENDING_PAYMENT (ยังไม่ชำระ) · ชำระแล้วกลายเป็น cases
CREATE TABLE drafts (
  draft_id    TEXT PRIMARY KEY,
  username    TEXT NOT NULL,
  service_id  TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('DRAFT','PENDING_PAYMENT','PAID')),
  qty         INTEGER,                           -- SV-01
  area_sqm    INTEGER,                           -- SV-03
  fee         INTEGER NOT NULL,                  -- ยอดที่คิด/ล็อก (A-42: ล็อกตอนเข้า PENDING_PAYMENT)
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE payments (
  ref           TEXT PRIMARY KEY,                -- PP-0001…
  draft_id      TEXT,
  case_no       TEXT,
  amount        INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('PENDING','PAID','EXPIRED')),
  qr_created_at TEXT NOT NULL,
  qr_expires_at TEXT NOT NULL,                   -- = created + 15:00 · ชำระได้ถ้า now < expires (15:00 พอดี = หมดอายุ)
  paid_at       TEXT,
  receipt_no    TEXT
);

-- คำขอที่มีเลขแล้ว (ชำระสำเร็จ)
--   status : SUBMITTED IN_REVIEW NEED_FIX PENDING_APPROVAL APPROVED COMPLETED REJECTED CANCELLED (CONTRACT §4.1)
--   step   : 1–3 เฉพาะ SV-03 (อื่น ๆ NULL)
--   dept   : หน่วยที่รับผิดชอบตอนนี้ registry | works | head (PENDING_APPROVAL) · ปิดแล้ว ''
--   owner  : ผู้ถือเรื่อง (IN_REVIEW/NEED_FIX) · NULL = ไม่มีผู้รับ (คิวแผนก) · PENDING_APPROVAL/APPROVED = NULL
--   issuer : ผู้ออกเอกสาร (A-27 = เจ้าหน้าที่ทะเบียนที่รับเรื่องขั้นแรก) · ตั้งค่าตอน claim ขั้นแรก
--   due_at : กำหนดเสร็จ (คำนวณครั้งเดียวตอนชำระ · ขยายตอนส่งแก้ A-42) · seed เก็บค่าตายตัว
--   paused_at  : เวลาที่ตีกลับล่าสุด (NEED_FIX) · fix_deadline = paused_at + 168 ชม.
--   closed_at  : COMPLETED/REJECTED เท่านั้น (นิยาม "ทันกำหนด" DECISIONS §18) · CANCELLED ใช้ cancelled_at
CREATE TABLE cases (
  case_no      TEXT PRIMARY KEY,                 -- EG-2569-000001
  draft_id     TEXT,
  applicant    TEXT NOT NULL,                    -- users.username ของผู้ยื่น
  service_id   TEXT NOT NULL,
  status       TEXT NOT NULL,
  step         INTEGER,
  dept         TEXT NOT NULL DEFAULT 'registry',
  owner        TEXT,
  issuer       TEXT,
  approver     TEXT,
  approved_at  TEXT,
  qty          INTEGER,
  area_sqm     INTEGER,
  fee          INTEGER NOT NULL,
  paid_at      TEXT NOT NULL,
  due_at       TEXT NOT NULL,
  return_count INTEGER NOT NULL DEFAULT 0,
  paused_at    TEXT,
  fix_deadline TEXT,
  closed_at    TEXT,
  cancelled_at TEXT,
  reject_reason TEXT,
  doc_no       TEXT,
  verify_code  TEXT,
  receipt_no   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_cases_status ON cases(status);
CREATE INDEX idx_cases_applicant ON cases(applicant);
CREATE INDEX idx_cases_due ON cases(due_at, case_no);

-- ประวัติตีกลับ (ไว้คำนวณหยุดนับ SLA และแสดงไทม์ไลน์) · TEST-DATA §4.4
CREATE TABLE case_returns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no         TEXT NOT NULL,
  n               INTEGER NOT NULL,              -- ครั้งที่ 1, 2
  returned_at     TEXT NOT NULL,
  resubmitted_at  TEXT,                          -- NULL = ยังไม่ส่งแก้
  paused_workdays INTEGER,                       -- วันทำการที่หยุดนับ (ตอนส่งแก้)
  reason          TEXT NOT NULL,
  by_user         TEXT NOT NULL
);

-- ไทม์ไลน์ของคำขอ (ที่ประชาชน/เจ้าหน้าที่เห็นในหน้ารายละเอียด) · แยกจาก audit_log
--   event: PAID CLAIM RETURN RESUBMIT FORWARD APPROVE REJECT ISSUE CANCEL
CREATE TABLE case_timeline (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no     TEXT NOT NULL,
  time        TEXT NOT NULL,
  username    TEXT NOT NULL DEFAULT '',
  event       TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  detail      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_timeline_case ON case_timeline(case_no, id);

-- ไฟล์แนบ: เนื้อไฟล์อยู่บนดิสก์ (UPLOAD_DIR/<path>) · ผูกกับร่าง (draft_id) แล้วเมื่อชำระ ตั้ง case_no เพิ่ม
CREATE TABLE files (
  file_id     TEXT PRIMARY KEY,
  draft_id    TEXT,
  case_no     TEXT,
  doc_key     TEXT NOT NULL,
  name        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  mime        TEXT NOT NULL,                     -- ชนิดจริงจาก magic bytes
  path        TEXT NOT NULL,                     -- สัมพัทธ์กับ UPLOAD_DIR
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_files_case ON files(case_no);
CREATE INDEX idx_files_draft ON files(draft_id);

-- เอกสารดิจิทัลที่ออกแล้ว · signature = security.signDocument(row)
CREATE TABLE documents (
  doc_no      TEXT PRIMARY KEY,                  -- DOC-2569-000001
  case_no     TEXT NOT NULL UNIQUE,
  verify_code TEXT NOT NULL UNIQUE,              -- 8 ตัว
  service_id  TEXT NOT NULL,
  applicant   TEXT NOT NULL,                     -- ชื่อเต็มผู้ยื่น (tamper แก้ฟิลด์นี้ได้)
  issued_at   TEXT NOT NULL,
  valid_until TEXT NOT NULL,                     -- 'YYYY-MM-DD' วันสุดท้ายที่ใช้ได้ (หมดอายุ 00:00 วันถัดไป)
  signer      TEXT NOT NULL,                     -- ชื่อแสดงของผู้ลงนาม (ผู้อนุมัติ)
  signature   TEXT NOT NULL
);

-- Audit Trail: เพิ่มได้อย่างเดียว (ไม่มี UPDATE/DELETE ที่ใดในโค้ด) · เขียนผ่าน src/audit.js
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  time        TEXT NOT NULL,
  username    TEXT NOT NULL,
  role        TEXT NOT NULL,
  event       TEXT NOT NULL,
  case_no     TEXT NOT NULL DEFAULT '',
  from_status TEXT NOT NULL DEFAULT '',
  to_status   TEXT NOT NULL DEFAULT '',
  detail      TEXT NOT NULL DEFAULT ''
);

-- แจ้งเตือนกระดิ่ง · UNIQUE(username, dedupe_key) กันแจ้งซ้ำ (เช่น "<caseNo>|near")
CREATE TABLE notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT NOT NULL,
  case_no     TEXT NOT NULL,
  level       TEXT NOT NULL CHECK (level IN ('near','overdue')),
  text        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  dedupe_key  TEXT NOT NULL,
  UNIQUE (username, dedupe_key)
);

CREATE TABLE counters (
  name        TEXT PRIMARY KEY,                  -- case:2569 receipt:2569 doc:2569 draft payref file
  value       INTEGER NOT NULL
);
CREATE TABLE kv (
  key         TEXT PRIMARY KEY,
  value       TEXT
);
`;

// ---------------------------------------------------------------- handle + wrapper
let handle = null;
let depth = 0;
const stmtCache = new Map();
const extraSchemas = []; // SQL จากโมดูลอื่น (ลงทะเบียนโดย server.js)

const norm = (p) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
function stmt(sql) {
  let s = stmtCache.get(sql);
  if (!s) {
    s = handle.prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

const db = {
  run: (sql, ...p) => stmt(sql).run(...norm(p)),
  get: (sql, ...p) => stmt(sql).get(...norm(p)),
  all: (sql, ...p) => stmt(sql).all(...norm(p)),
  exec: (sql) => handle.exec(sql),
  tx(fn) {
    if (depth > 0) return fn();
    handle.exec('BEGIN IMMEDIATE');
    depth++;
    try {
      const r = fn();
      handle.exec('COMMIT');
      return r;
    } catch (e) {
      try { handle.exec('ROLLBACK'); } catch (_) { /* ignore */ }
      throw e;
    } finally {
      depth--;
    }
  },
  nextSeq(name) {
    return db.tx(() => {
      db.run('INSERT INTO counters(name,value) VALUES(?,0) ON CONFLICT(name) DO NOTHING', name);
      db.run('UPDATE counters SET value = value + 1 WHERE name = ?', name);
      return db.get('SELECT value FROM counters WHERE name = ?', name).value;
    });
  },
  /** อ่านเลขล่าสุดที่ออกไปแล้ว (ไม่เพิ่ม) */
  peekSeq(name) {
    const r = db.get('SELECT value FROM counters WHERE name = ?', name);
    return r ? r.value : 0;
  },
};

// ---------------------------------------------------------------- เลขที่เอกสารต่าง ๆ (DECISIONS §6 §7 §10, TEST-DATA §12)
const p6 = (n) => String(n).padStart(6, '0');
const p4 = (n) => String(n).padStart(4, '0');
const ids = {
  caseNo: (be, n) => `EG-${be}-${p6(n)}`,
  receiptNo: (be, n) => `RC-${be}-${p6(n)}`,
  docNo: (be, n) => `DOC-${be}-${p6(n)}`,
  draftId: (n) => `DR-${p4(n)}`,
  payRef: (n) => `PP-${p4(n)}`,
  fileId: (n) => `FL-${p6(n)}`,
  /** ปีใน counter = พ.ศ. ของเวลาที่ออกเลข (ลำดับเริ่มใหม่ทุกปี) */
  nextCaseNo: (be) => ids.caseNo(be, db.nextSeq(`case:${be}`)),
  nextReceiptNo: (be) => ids.receiptNo(be, db.nextSeq(`receipt:${be}`)),
  nextDocNo: (be) => ids.docNo(be, db.nextSeq(`doc:${be}`)),
  nextDraftId: () => ids.draftId(db.nextSeq('draft')),
  nextPayRef: () => ids.payRef(db.nextSeq('payref')),
  nextFileId: () => ids.fileId(db.nextSeq('file')),
};

// ---------------------------------------------------------------- เปิด/สร้าง/ล้าง
function removeDbFiles() {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.rmSync(cfg.DB_PATH + suffix, { force: true }); } catch (_) { /* ignore */ }
  }
}

function open() {
  fs.mkdirSync(path.dirname(cfg.DB_PATH), { recursive: true });
  handle = new DatabaseSync(cfg.DB_PATH);
  handle.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
  stmtCache.clear();
}

function createSchema() {
  handle.exec(CORE_SCHEMA);
  for (const sql of extraSchemas) handle.exec(sql);
  handle.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/** โมดูลอื่นลงทะเบียน SQL ของตัวเอง (ก่อน init) */
function addSchema(sql) {
  if (sql) extraSchemas.push(sql);
}

/** ฐานข้อมูลที่มีอยู่ใช้ต่อได้ไหม (schema ตรงเวอร์ชันและมีตาราง users) */
function usable() {
  try {
    const v = handle.prepare('PRAGMA user_version').get().user_version;
    if (v !== SCHEMA_VERSION) return false;
    handle.prepare('SELECT 1 FROM users LIMIT 1').get();
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * เปิดฐานข้อมูล · คืน true ถ้า "ต้อง seed" (สร้างใหม่)
 * @param {{fresh?: boolean}} opt fresh=true → ลบแล้วสร้างใหม่เสมอ (reset / เริ่ม TEST_MODE)
 */
function init({ fresh = false } = {}) {
  if (handle) { try { handle.close(); } catch (_) { /* ignore */ } handle = null; }
  if (fresh) removeDbFiles();
  open();
  if (!fresh && usable()) return false;
  // ไม่มีไฟล์/เวอร์ชันไม่ตรง → สร้างใหม่
  handle.close(); handle = null;
  removeDbFiles();
  open();
  createSchema();
  return true;
}

module.exports = { db, ids, init, addSchema, SCHEMA_VERSION };
