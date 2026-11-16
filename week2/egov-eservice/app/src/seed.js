'use strict';
/**
 * Seed ตาม TEST-DATA.md (ตรงทุกค่า) · เรียกหลังสร้างฐานข้อมูลใหม่ทุกครั้ง (เริ่ม TEST_MODE / POST /api/test/reset)
 * กำหนดเสร็จ (due_at) ของ seed เก็บเป็นค่าตายตัวตามตาราง ไม่คำนวณใหม่ (A-35)
 * Audit Trail ว่าง · แจ้งเตือนว่าง (TEST-DATA §10) · session ว่าง
 */
const { db, ids } = require('./db');
const clock = require('./clock');
const security = require('./security');
const storage = require('./storage');
const audit = require('./audit');

/** '2026-11-23 10:00' → '2026-11-23T10:00:00+07:00' */
const T = (s) => {
  if (!s) return null;
  const [d, hm = '00:00'] = s.split(' ');
  const [h, m, sec = '00'] = hm.split(':');
  return `${d}T${h.padStart(2, '0')}:${m.padStart(2, '0')}:${sec.padStart(2, '0')}+07:00`;
};

// ---------------------------------------------------------------- บัญชี (TEST-DATA §1)
const CITIZENS = [
  { username: 'cit.somchai', name: 'สมชาย ใจดี', idNo: '1101700123456', mobile: '0812345678', registered: 1 },
  { username: 'cit.somying', name: 'สมหญิง รักไทย', idNo: '3100600987659', mobile: '0823456789', registered: 1 },
  { username: 'cit.mana', name: 'มานะ ตั้งใจ', idNo: '5500400111221', mobile: null, registered: 0 },
  { username: 'cit.piti', name: 'ปิติ มีสุข', idNo: '1909900555015', mobile: '0834567890', registered: 1 },
];
const STAFF = [
  { username: 'off.reg1', name: 'เจ้าหน้าที่ทะเบียน 1', role: 'officer', dept: 'registry' },
  { username: 'off.reg2', name: 'เจ้าหน้าที่ทะเบียน 2', role: 'officer', dept: 'registry' },
  { username: 'off.works1', name: 'เจ้าหน้าที่โยธา 1', role: 'officer', dept: 'works' },
  { username: 'head1', name: 'หัวหน้าฝ่าย', role: 'head', dept: '' },
  { username: 'exec1', name: 'ผู้บริหาร', role: 'executive', dept: '' },
  { username: 'audit1', name: 'ผู้ตรวจสอบภายใน', role: 'auditor', dept: '' },
  { username: 'admin1', name: 'ผู้ดูแลระบบ', role: 'admin', dept: '' },
];
const STAFF_PASSWORD = 'Test@1234';
const U = { // ชื่อย่อ → username
  สมชาย: 'cit.somchai', สมหญิง: 'cit.somying', ปิติ: 'cit.piti', มานะ: 'cit.mana',
};

// ---------------------------------------------------------------- บริการ + เอกสาร (TEST-DATA §2, CONTRACT §4.3)
const SERVICES = [
  { id: 'SV-01', name: 'ขอหนังสือรับรอง', fee: 20, per: 0, sla: 3 },
  { id: 'SV-02', name: 'ขออนุญาตประกอบกิจการ', fee: 500, per: 0, sla: 10 },
  { id: 'SV-03', name: 'ขออนุญาตก่อสร้าง/ต่อเติมอาคาร', fee: 1000, per: 10, sla: 15 },
];
const SERVICE_DOCS = {
  'SV-01': [['id-card', 'บัตรประชาชน', 1, 0]],
  'SV-02': [['id-card', 'บัตรประชาชน', 1, 0], ['map', 'แผนที่ตั้ง', 1, 0], ['site-photo', 'ภาพสถานที่', 0, 0]],
  'SV-03': [['id-card', 'บัตรประชาชน', 1, 0], ['plan', 'แบบแปลน', 1, 1], ['deed', 'โฉนด', 1, 0]],
};
const HOLIDAYS = [
  ['2026-12-07', 'ชดเชยวันหยุดทดสอบ (สมมติ)'],
  ['2026-12-10', 'วันรัฐธรรมนูญทดสอบ (สมมติ)'],
  ['2026-12-31', 'วันสิ้นปีทดสอบ (สมมติ)'],
  ['2027-01-01', 'วันขึ้นปีใหม่ทดสอบ (สมมติ)'],
];

// ---------------------------------------------------------------- คำขอ 30 ใบ (TEST-DATA §4.1)
// [no, svc, qty|area, fee, ผู้ยื่น, status, step, dept, owner, issuer, paid, due, closed, approver, approvedAt]
// SV-01 → qty · SV-03 → area · SV-02 → null
const C = (no, svc, n, fee, who, status, step, dept, owner, issuer, paid, due, extra = {}) =>
  ({ no, svc, n, fee, who, status, step, dept, owner, issuer, paid, due, ...extra });
const CASES = [
  C(1, 'SV-01', 1, 20, 'สมหญิง', 'COMPLETED', null, '', null, 'off.reg1', '2026-10-14 10:00', '2026-10-19 16:30', { closed: '2026-10-16 14:00', approver: 'off.reg1' }),
  C(2, 'SV-03', 120, 1200, 'ปิติ', 'COMPLETED', null, '', null, 'off.reg1', '2026-11-02 09:00', '2026-11-23 16:30', { closed: '2026-11-20 11:00', approver: 'head1' }),
  C(3, 'SV-01', 2, 40, 'ปิติ', 'COMPLETED', null, '', null, 'off.reg1', '2026-11-02 09:30', '2026-11-05 16:30', { closed: '2026-11-04 15:00', approver: 'off.reg1' }),
  C(4, 'SV-02', null, 500, 'สมชาย', 'COMPLETED', null, '', null, 'off.reg1', '2026-11-02 14:00', '2026-11-16 16:30', { closed: '2026-11-13 15:00', approver: 'head1' }),
  C(5, 'SV-01', 1, 20, 'สมชาย', 'COMPLETED', null, '', null, 'off.reg1', '2026-11-03 11:00', '2026-11-06 16:30', { closed: '2026-11-05 10:00', approver: 'off.reg1', doc: true }),
  C(6, 'SV-02', null, 500, 'ปิติ', 'COMPLETED', null, '', null, 'off.reg1', '2026-11-03 15:00', '2026-11-17 16:30', { closed: '2026-11-19 10:00', approver: 'head1' }),
  C(7, 'SV-02', null, 500, 'สมหญิง', 'COMPLETED', null, '', null, 'off.reg1', '2026-11-04 10:00', '2026-11-18 16:30', { closed: '2026-11-18 16:00', approver: 'head1' }),
  C(8, 'SV-01', 1, 20, 'สมหญิง', 'REJECTED', null, '', null, 'off.reg1', '2026-11-09 10:00', '2026-11-12 16:30', { closed: '2026-11-11 09:00', approver: 'off.reg1', reason: 'เอกสารไม่ถูกต้องตามที่กำหนด' }),
  C(9, 'SV-01', 1, 20, 'สมชาย', 'CANCELLED', null, '', null, null, '2026-11-09 14:30', '2026-11-12 16:30', { cancelled: '2026-11-09 15:00' }),
  C(10, 'SV-03', 80, 1000, 'สมหญิง', 'IN_REVIEW', 2, 'works', null, 'off.reg1', '2026-11-12 10:00', '2026-12-03 16:30'),
  C(11, 'SV-03', 150, 1500, 'สมชาย', 'PENDING_APPROVAL', 3, 'head', null, 'off.reg1', '2026-11-16 10:00', '2026-12-08 16:30'),
  C(12, 'SV-03', 101, 1010, 'ปิติ', 'IN_REVIEW', 1, 'registry', 'off.reg2', 'off.reg2', '2026-11-18 10:00', '2026-12-11 16:30'),
  C(13, 'SV-02', null, 500, 'สมชาย', 'IN_REVIEW', null, 'registry', 'off.reg2', 'off.reg2', '2026-11-20 10:00', '2026-12-04 16:30'),
  C(14, 'SV-02', null, 500, 'ปิติ', 'PENDING_APPROVAL', null, 'head', null, 'off.reg1', '2026-11-20 11:00', '2026-12-04 16:30'),
  C(15, 'SV-02', null, 500, 'สมหญิง', 'IN_REVIEW', null, 'registry', 'off.reg2', 'off.reg2', '2026-11-20 15:00', '2026-12-04 16:30'),
  C(16, 'SV-02', null, 500, 'ปิติ', 'IN_REVIEW', null, 'registry', 'off.reg2', 'off.reg2', '2026-11-23 09:00', '2026-12-08 16:30'),
  C(17, 'SV-01', 1, 20, 'สมชาย', 'NEED_FIX', null, 'registry', 'off.reg1', 'off.reg1', '2026-11-23 10:00', '2026-11-27 16:30',
    { returnCount: 2, pausedAt: '2026-11-27 14:00', fixDeadline: '2026-12-04 14:00' }),
  C(18, 'SV-02', null, 500, 'สมชาย', 'IN_REVIEW', null, 'registry', 'off.reg2', 'off.reg2', '2026-11-24 10:00', '2026-12-09 16:30'),
  C(19, 'SV-02', null, 500, 'สมหญิง', 'APPROVED', null, 'registry', null, 'off.reg1', '2026-11-24 14:00', '2026-12-09 16:30',
    { approver: 'head1', approvedAt: '2026-11-30 15:00' }),
  C(20, 'SV-01', 1, 20, 'สมชาย', 'IN_REVIEW', null, 'registry', 'off.reg1', 'off.reg1', '2026-11-25 10:00', '2026-11-30 16:30'),
  C(21, 'SV-02', null, 500, 'สมหญิง', 'IN_REVIEW', null, 'registry', 'off.reg2', 'off.reg2', '2026-11-25 12:00', '2026-12-11 16:30'),
  C(22, 'SV-01', 2, 40, 'สมหญิง', 'IN_REVIEW', null, 'registry', 'off.reg1', 'off.reg1', '2026-11-26 10:00', '2026-12-01 16:30'),
  C(23, 'SV-01', 1, 20, 'สมหญิง', 'IN_REVIEW', null, 'registry', 'off.reg1', 'off.reg1', '2026-11-26 10:30', '2026-12-03 16:30', { returnCount: 2 }),
  C(24, 'SV-01', 1, 20, 'ปิติ', 'SUBMITTED', null, 'registry', null, null, '2026-11-27 11:00', '2026-12-02 16:30'),
  C(25, 'SV-01', 3, 60, 'สมหญิง', 'IN_REVIEW', null, 'registry', 'off.reg2', 'off.reg2', '2026-11-30 10:00', '2026-12-03 16:30'),
  C(26, 'SV-01', 5, 100, 'สมชาย', 'IN_REVIEW', null, 'registry', 'off.reg2', 'off.reg2', '2026-11-30 16:29', '2026-12-03 16:30'),
  C(27, 'SV-01', 1, 20, 'ปิติ', 'IN_REVIEW', null, 'registry', 'off.reg2', 'off.reg2', '2026-11-30 16:30', '2026-12-04 16:30'),
  C(28, 'SV-01', 1, 20, 'สมหญิง', 'SUBMITTED', null, 'registry', null, null, '2026-12-01 08:10', '2026-12-04 16:30'),
  C(29, 'SV-01', 1, 20, 'ปิติ', 'SUBMITTED', null, 'registry', null, null, '2026-12-01 08:20', '2026-12-04 16:30'),
  C(30, 'SV-01', 1, 20, 'สมชาย', 'SUBMITTED', null, 'registry', null, null, '2026-12-01 08:30', '2026-12-04 16:30'),
];

// ประวัติตีกลับ (TEST-DATA §4.4) [caseNo, n, returnedAt, resubmittedAt, pausedWorkdays, reason]
const RETURNS = [
  [17, 1, '2026-11-24 11:00', '2026-11-25 10:00', 1, 'ภาพบัตรประชาชนไม่ชัด กรุณาถ่ายใหม่'],
  [17, 2, '2026-11-27 14:00', null, null, 'ชื่อในเอกสารไม่ตรงกับบัตร กรุณาแก้ไข'],
  [23, 1, '2026-11-27 10:00', '2026-11-30 10:00', 1, 'ภาพเอกสารเบลอ อ่านเลขไม่ได้'],
  [23, 2, '2026-11-30 14:00', '2026-12-01 08:30', 1, 'ข้อมูลในแบบฟอร์มไม่ครบถ้วน'],
];

const FILE_NAME = { 'id-card': 'id-card.pdf', map: 'map.pdf', 'site-photo': 'site-photo.pdf', plan: 'plan.pdf', deed: 'deed.pdf' };
const SEED_DOC_KEYS = { 'SV-01': ['id-card'], 'SV-02': ['id-card', 'map'], 'SV-03': ['id-card', 'plan', 'deed'] };

/** PDF จริงขนาดเล็ก (ไฟล์แนบของ seed) */
function tinyPdf(label) {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\n% seed ${label}\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
    'latin1'
  );
}

/** อายุเอกสาร: SV-01 ออก + 89 วัน = วันสุดท้ายที่ใช้ได้ (ออก 5 พ.ย. → 2 ก.พ. 2570 ตาม TEST-DATA §5) */
function seedAll() {
  const nowIso = clock.nowIso(); // = 2026-12-01T09:00:00+07:00 (หลัง clock.reset())
  storage.reset();

  db.tx(() => {
    // --- users
    const insUser = `INSERT INTO users(username,name,role,dept,pw_hash,id_hash,id_enc,mobile_enc,email,registered,consent_at,created_at)
                     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`;
    for (const c of CITIZENS) {
      db.run(insUser, c.username, c.name, 'citizen', '', null, security.idHash(c.idNo), security.encrypt(c.idNo),
        security.encrypt(c.mobile), '', c.registered, c.registered ? T('2026-10-01 09:00') : null, T('2026-10-01 09:00'));
    }
    const pw = security.hashPassword(STAFF_PASSWORD);
    for (const s of STAFF) {
      db.run(insUser, s.username, s.name, s.role, s.dept, pw, null, null, null, '', 1, null, T('2026-10-01 09:00'));
    }

    // --- services / docs / holidays
    for (const [i, s] of SERVICES.entries()) {
      db.run('INSERT INTO services(id,name,fee,fee_per_sqm,sla,sort) VALUES(?,?,?,?,?,?)', s.id, s.name, s.fee, s.per, s.sla, i + 1);
      for (const [j, d] of SERVICE_DOCS[s.id].entries()) {
        db.run('INSERT INTO service_docs(service_id,doc_key,label,required,pdf_only,sort) VALUES(?,?,?,?,?,?)', s.id, d[0], d[1], d[2], d[3], j + 1);
      }
    }
    for (const [date, name] of HOLIDAYS) db.run('INSERT INTO holidays(date,name) VALUES(?,?)', date, name);

    // --- cases + ไฟล์แนบ + ไทม์ไลน์
    const insCase = `INSERT INTO cases(case_no,draft_id,applicant,service_id,status,step,dept,owner,issuer,approver,approved_at,qty,area_sqm,fee,
                       paid_at,due_at,return_count,paused_at,fix_deadline,closed_at,cancelled_at,reject_reason,doc_no,verify_code,receipt_no,created_at)
                     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
    const insFile = 'INSERT INTO files(file_id,draft_id,case_no,doc_key,name,size,mime,path,created_at) VALUES(?,?,?,?,?,?,?,?,?)';
    const names = Object.fromEntries(CITIZENS.map((c) => [c.username, c.name]));
    let maxFile = 0;

    for (const c of CASES) {
      const caseNo = ids.caseNo(2569, c.no);
      const rcpt = ids.receiptNo(2569, c.no);
      const paid = T(c.paid);
      db.run(insCase,
        caseNo, null, U[c.who], c.svc, c.status, c.step, c.dept, c.owner, c.issuer, c.approver || null, T(c.approvedAt),
        c.svc === 'SV-01' ? c.n : null, c.svc === 'SV-03' ? c.n : null, c.fee,
        paid, T(c.due), c.returnCount || 0, T(c.pausedAt), T(c.fixDeadline), T(c.closed), T(c.cancelled), c.reason || null,
        c.doc ? 'DOC-2569-000001' : null, c.doc ? 'K7M2Q9XA' : null, rcpt, paid);

      for (const key of SEED_DOC_KEYS[c.svc]) {
        const data = tinyPdf(`${caseNo} ${key}`);
        const fid = ids.fileId(++maxFile);
        db.run(insFile, fid, null, caseNo, key, FILE_NAME[key], data.length, 'application/pdf', storage.save(data, 'pdf'), paid);
      }

      // ไทม์ไลน์ขั้นต่ำ (ไม่ใช่ Audit · Audit ว่างตาม TEST-DATA §10)
      audit.timeline(caseNo, { time: paid, username: U[c.who], event: 'PAID', toStatus: 'SUBMITTED', detail: rcpt });
      if (c.owner && c.status !== 'SUBMITTED') {
        audit.timeline(caseNo, { time: paid, username: c.owner, event: 'CLAIM', fromStatus: 'SUBMITTED', toStatus: 'IN_REVIEW' });
      }
      if (c.approvedAt) audit.timeline(caseNo, { time: T(c.approvedAt), username: c.approver, event: 'APPROVE', fromStatus: 'PENDING_APPROVAL', toStatus: 'APPROVED' });
      if (c.status === 'COMPLETED') audit.timeline(caseNo, { time: T(c.closed), username: c.issuer, event: 'ISSUE', fromStatus: 'APPROVED', toStatus: 'COMPLETED' });
      if (c.status === 'REJECTED') audit.timeline(caseNo, { time: T(c.closed), username: c.approver, event: 'REJECT', fromStatus: 'IN_REVIEW', toStatus: 'REJECTED', detail: c.reason });
      if (c.status === 'CANCELLED') audit.timeline(caseNo, { time: T(c.cancelled), username: U[c.who], event: 'CANCEL', fromStatus: 'SUBMITTED', toStatus: 'CANCELLED' });
    }

    for (const [no, n, ret, resub, paused, reason] of RETURNS) {
      const caseNo = ids.caseNo(2569, no);
      db.run('INSERT INTO case_returns(case_no,n,returned_at,resubmitted_at,paused_workdays,reason,by_user) VALUES(?,?,?,?,?,?,?)',
        caseNo, n, T(ret), T(resub), paused, reason, 'off.reg1');
      audit.timeline(caseNo, { time: T(ret), username: 'off.reg1', event: 'RETURN', fromStatus: 'IN_REVIEW', toStatus: 'NEED_FIX', detail: reason });
      if (resub) audit.timeline(caseNo, { time: T(resub), username: U[no === 17 ? 'สมชาย' : 'สมหญิง'], event: 'RESUBMIT', fromStatus: 'NEED_FIX', toStatus: 'IN_REVIEW' });
    }

    // --- เอกสารที่ออกแล้ว 1 ใบ (TEST-DATA §5) · ลายเซ็นคำนวณจริงด้วย security.signDocument
    const doc = {
      doc_no: 'DOC-2569-000001', case_no: ids.caseNo(2569, 5), verify_code: 'K7M2Q9XA', service_id: 'SV-01',
      applicant: names['cit.somchai'], issued_at: T('2026-11-05 10:00'), valid_until: '2027-02-02', signer: 'เจ้าหน้าที่ทะเบียน 1',
    };
    doc.signature = security.signDocument(doc);
    db.run('INSERT INTO documents(doc_no,case_no,verify_code,service_id,applicant,issued_at,valid_until,signer,signature) VALUES(?,?,?,?,?,?,?,?,?)',
      doc.doc_no, doc.case_no, doc.verify_code, doc.service_id, doc.applicant, doc.issued_at, doc.valid_until, doc.signer, doc.signature);

    // --- ร่างของสมชาย (TEST-DATA §4.2)
    db.run('INSERT INTO drafts(draft_id,username,service_id,status,qty,area_sqm,fee,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      'DR-0001', 'cit.somchai', 'SV-01', 'DRAFT', 2, null, 40, T('2026-11-30 17:00'), T('2026-11-30 17:00'));
    db.run('INSERT INTO drafts(draft_id,username,service_id,status,qty,area_sqm,fee,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      'DR-0002', 'cit.somchai', 'SV-02', 'PENDING_PAYMENT', null, null, 500, T('2026-12-01 08:50'), T('2026-12-01 08:55'));
    for (const key of ['id-card', 'map']) {
      const data = tinyPdf(`DR-0002 ${key}`);
      db.run(insFile, ids.fileId(++maxFile), 'DR-0002', null, key, FILE_NAME[key], data.length, 'application/pdf', storage.save(data, 'pdf'), T('2026-12-01 08:52'));
    }
    db.run('INSERT INTO payments(ref,draft_id,case_no,amount,status,qr_created_at,qr_expires_at,paid_at,receipt_no) VALUES(?,?,?,?,?,?,?,?,?)',
      'PP-0001', 'DR-0002', null, 500, 'PENDING', T('2026-12-01 08:55:00'), T('2026-12-01 09:10:00'), null, null);

    // --- ตัวนับ (TEST-DATA §12): ถัดไป EG-2569-000031 · RC-2569-000031 · DOC-2569-000002 · DR-0003 · PP-0002
    const setCounter = (name, v) => db.run('INSERT INTO counters(name,value) VALUES(?,?)', name, v);
    setCounter('case:2569', 30);
    setCounter('receipt:2569', 30);
    setCounter('doc:2569', 1);
    setCounter('draft', 2);
    setCounter('payref', 1);
    setCounter('file', maxFile);
    db.run('INSERT INTO kv(key,value) VALUES(?,?)', 'seeded_at', nowIso);
  });
}

module.exports = { seedAll, T, CITIZENS, STAFF, STAFF_PASSWORD };
