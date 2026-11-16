'use strict';
/**
 * Audit Trail + ไทม์ไลน์คำขอ · เวลาอ่านจากนาฬิกาทดสอบเสมอ (CONTRACT §0 ข้อ 3, §8)
 * audit_log เพิ่มได้อย่างเดียว · ห้ามใส่เลขบัตร/เบอร์โทรใน detail
 *
 *   audit.log(actor, { event, caseNo, fromStatus, toStatus, detail })
 *     actor = { username, role }  (เช่น req.user)
 *     event = STAFF_LOGIN CLAIM RETURN FORWARD APPROVE REJECT ISSUE UNMASK EXPORT ADMIN_CHANGE …
 *   audit.timeline(caseNo, { username, event, fromStatus, toStatus, detail, time? })
 */
const { db } = require('./db');
const clock = require('./clock');

function log(actor, ev = {}) {
  const a = actor || {};
  return db.run(
    `INSERT INTO audit_log(time, username, role, event, case_no, from_status, to_status, detail)
     VALUES(?,?,?,?,?,?,?,?)`,
    ev.time || clock.nowIso(),
    a.username || '',
    a.role || '',
    ev.event || '',
    ev.caseNo || '',
    ev.fromStatus || '',
    ev.toStatus || '',
    ev.detail || ''
  );
}

function timeline(caseNo, ev = {}) {
  return db.run(
    `INSERT INTO case_timeline(case_no, time, username, event, from_status, to_status, detail)
     VALUES(?,?,?,?,?,?,?)`,
    caseNo,
    ev.time || clock.nowIso(),
    ev.username || '',
    ev.event || '',
    ev.fromStatus || null,
    ev.toStatus || null,
    ev.detail || ''
  );
}

module.exports = { log, timeline };
