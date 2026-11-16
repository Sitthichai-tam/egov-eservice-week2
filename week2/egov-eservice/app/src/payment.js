'use strict';
/**
 * B05: ชำระเงิน PromptPay จำลอง + เลขคำขอ + ใบเสร็จ (FR-08 · DECISIONS §6 §7 · CONTRACT §6.2 §8)
 *   POST /api/drafts/:id/payment          สร้าง QR (ref ใหม่ทุกครั้ง · ยอดล็อกตอนเข้า PENDING_PAYMENT A-42)
 *   GET  /api/payments/:ref               สถานะ (PENDING/PAID/EXPIRED) · หมดอายุคำนวณตามนาฬิกาทดสอบ
 *   POST /api/test/payments/:ref/pay      ตัวแทนธนาคาร (เฉพาะ TEST_MODE · guard โดย server.js)
 * กติกา: QR ใช้ได้เมื่อ now < createdAt + 15:00 (15:00 พอดี = QR_EXPIRED) · ยอดต้องตรงพอดี · callback ซ้ำ = idempotent
 * เลขคำขอ/ใบเสร็จออกในธุรกรรมเดียว (ปี พ.ศ. ของเวลาชำระ ลำดับเริ่มใหม่ทุกปี) จึงไม่ซ้ำแม้ชำระพร้อมกัน
 * BUG_MODE B05: ใช้ `now > expires` แทน `now >= expires` (15:00 พอดียังจ่ายได้)
 */
const rules = require('./rules');

const QR_TTL_MS = 15 * 60 * 1000;
const EXPIRED_MSG = 'QR หมดอายุ กรุณาสร้าง QR ใหม่';
const AMOUNT_MSG = 'ยอดเงินไม่ตรงกับค่าธรรมเนียม';

function register(app, ctx) {
  const { db, clock, ids, http, bug } = ctx;
  const audit = ctx.audit;

  /** QR หมดอายุหรือยัง (ณ นาฬิกาปัจจุบัน) */
  function isExpired(p) {
    const exp = clock.parseIso(p.qr_expires_at);
    const now = clock.now();
    return bug('B05') ? now > exp : now >= exp;
  }

  const ownDraft = (req) => db.get('SELECT * FROM drafts WHERE draft_id=? AND username=?', req.params.id, req.user.username);

  // ---------------------------------------------------------------- สร้าง QR
  // (citizen.js ตรวจ 404 / PAID / MISSING_DOCS มาก่อนแล้วจึง next() มาที่นี่ · ตรวจซ้ำเพื่อความปลอดภัย)
  app.post('/api/drafts/:id/payment', http.requireApi('citizen'), (req, res) => {
    const d = ownDraft(req);
    if (!d) return http.apiError(res, 404, 'NOT_FOUND', 'ไม่พบคำขอ');
    if (d.status === 'PAID') return http.apiError(res, 409, 'INVALID_STATE', 'สถานะคำขอไม่ถูกต้องสำหรับรายการนี้');
    const out = db.tx(() => {
      const nowMs = clock.now();
      const nowIso = clock.nowIso();
      let fee = d.fee;
      if (d.status === 'DRAFT') {
        // เข้า PENDING_PAYMENT ครั้งแรก → ล็อกยอดตามค่าธรรมเนียม ณ ตอนนี้ (A-42) · ครั้งต่อไปใช้ยอดที่ล็อกไว้
        const s = db.get('SELECT * FROM services WHERE id=?', d.service_id);
        const r = s && rules.calcFee(s, { qty: d.qty == null ? undefined : d.qty, areaSqm: d.area_sqm == null ? undefined : d.area_sqm });
        if (r && r.ok) fee = r.fee;
        db.run("UPDATE drafts SET status='PENDING_PAYMENT', fee=?, updated_at=? WHERE draft_id=?", fee, nowIso, d.draft_id);
      }
      const ref = ids.nextPayRef();
      const expiresIso = clock.toIso(nowMs + QR_TTL_MS);
      db.run("INSERT INTO payments(ref,draft_id,case_no,amount,status,qr_created_at,qr_expires_at,paid_at,receipt_no) VALUES(?,?,?,?,?,?,?,?,?)",
        ref, d.draft_id, null, fee, 'PENDING', nowIso, expiresIso, null, null);
      return { ref, amount: fee, qrCreatedAt: nowIso, qrExpiresAt: expiresIso };
    });
    res.status(201).json(out);
  });

  // ---------------------------------------------------------------- อ่านสถานะ
  app.get('/api/payments/:ref', http.requireApi('citizen'), (req, res) => {
    let p = db.get('SELECT p.* FROM payments p JOIN drafts d ON d.draft_id=p.draft_id WHERE p.ref=? AND d.username=?', req.params.ref, req.user.username);
    if (!p) return http.apiError(res, 404, 'NOT_FOUND', 'ไม่พบรายการชำระเงิน');
    if (p.status === 'PENDING' && isExpired(p)) {
      db.run("UPDATE payments SET status='EXPIRED' WHERE ref=? AND status='PENDING'", p.ref);
      p = db.get('SELECT * FROM payments WHERE ref=?', p.ref);
    }
    res.json({
      ref: p.ref, amount: p.amount, status: p.status,
      qrCreatedAt: p.qr_created_at, qrExpiresAt: p.qr_expires_at,
      caseNo: p.case_no || null, receiptNo: p.receipt_no || null, paidAt: p.paid_at || null,
    });
  });

  // ---------------------------------------------------------------- ตัวแทนธนาคาร (callback ชำระ)
  app.post('/api/test/payments/:ref/pay', (req, res) => {
    const result = db.tx(() => {
      const p = db.get('SELECT * FROM payments WHERE ref=?', req.params.ref);
      if (!p) return { status: 404, code: 'NOT_FOUND', message: 'ไม่พบรายการชำระเงิน' };

      // callback ซ้ำ: ไม่สร้างรายการใหม่ ไม่เปลี่ยนเลข
      if (p.status === 'PAID') {
        return { status: 200, body: { status: 'PAID', caseNo: p.case_no, receiptNo: p.receipt_no, duplicate: true } };
      }
      if (isExpired(p)) {
        if (p.status === 'PENDING') db.run("UPDATE payments SET status='EXPIRED' WHERE ref=?", p.ref);
        return { status: 410, code: 'QR_EXPIRED', message: EXPIRED_MSG };
      }
      if (p.status === 'EXPIRED') return { status: 410, code: 'QR_EXPIRED', message: EXPIRED_MSG };

      const amount = req.body ? req.body.amount : undefined;
      if (typeof amount !== 'number' || !Number.isInteger(amount) || amount !== p.amount) {
        return { status: 422, code: 'AMOUNT_MISMATCH', message: AMOUNT_MSG };
      }

      const d = db.get('SELECT * FROM drafts WHERE draft_id=?', p.draft_id);
      if (!d) return { status: 404, code: 'NOT_FOUND', message: 'ไม่พบรายการชำระเงิน' };
      if (d.status === 'PAID') return { status: 409, code: 'INVALID_STATE', message: 'คำขอนี้ชำระแล้ว' };
      const svc = db.get('SELECT * FROM services WHERE id=?', d.service_id);

      const paidAt = clock.nowIso();
      const be = clock.parts(clock.now()).be; // ปี พ.ศ. ของเวลาชำระ
      const caseNo = ids.nextCaseNo(be);
      const receiptNo = ids.nextReceiptNo(be);
      const dueAt = rules.calcDueAt(paidAt, svc.sla, rules.loadHolidays(db));

      db.run(
        `INSERT INTO cases(case_no,draft_id,applicant,service_id,status,step,dept,owner,issuer,approver,approved_at,qty,area_sqm,fee,
                           paid_at,due_at,return_count,paused_at,fix_deadline,closed_at,cancelled_at,reject_reason,doc_no,verify_code,receipt_no,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        caseNo, d.draft_id, d.username, d.service_id, 'SUBMITTED', d.service_id === 'SV-03' ? 1 : null, 'registry',
        null, null, null, null, d.qty, d.area_sqm, p.amount,
        paidAt, dueAt, 0, null, null, null, null, null, null, null, receiptNo, paidAt);
      db.run("UPDATE payments SET status='PAID', paid_at=?, case_no=?, receipt_no=? WHERE ref=?", paidAt, caseNo, receiptNo, p.ref);
      db.run("UPDATE drafts SET status='PAID', updated_at=? WHERE draft_id=?", paidAt, d.draft_id);
      db.run('UPDATE files SET case_no=? WHERE draft_id=?', caseNo, d.draft_id);
      audit.timeline(caseNo, { time: paidAt, username: d.username, event: 'PAID', toStatus: 'SUBMITTED', detail: receiptNo });

      return { status: 200, body: { status: 'PAID', caseNo, receiptNo, duplicate: false } };
    });
    if (result.body) return res.status(result.status).json(result.body);
    return http.apiError(res, result.status, result.code, result.message);
  });
}

module.exports = { register };
