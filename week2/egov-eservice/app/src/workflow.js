'use strict';
/**
 * B06 · workflow เจ้าหน้าที่: คิว · รับเรื่อง · ตีกลับ · ส่งต่อ · อนุมัติ/ไม่อนุมัติ · ไฟล์แนบ · ส่งแก้ไข (FR-11..16 FR-29)
 * =====================================================================================
 * แหล่งกฎ: DECISIONS §5 §9 §10 §18 · CONTRACT §2.6 §2.7 §2.8 §6.2 §6.3 · TEST-DATA §9 · BUGS B07 B08 B12
 *
 * API (ทุกเส้นผ่านด่านบทบาทกลางของ auth.js แล้ว · ที่นี่ตรวจ "รายการ": แผนก/ผู้ถือเรื่อง/ผู้อนุมัติ)
 *   GET  /api/officer/queue?filter=all|unclaimed|mine       คิวแผนก (head เห็นทุกแผนก) เรียงกำหนดเสร็จ → เลขคำขอ
 *   POST /api/officer/cases/:caseNo/claim                   รับเรื่อง (สิทธิ์ → ALREADY_CLAIMED → WORKLOAD_LIMIT)
 *   POST /api/officer/cases/:caseNo/return {reason}         ตีกลับ (≤ 2 ครั้ง · เหตุผล ≥ 10 ตัวอักษร)
 *   POST /api/officer/cases/:caseNo/forward {note}          ส่งต่อตามเส้นทางของบริการ (ผู้ใช้เลือกปลายทางไม่ได้)
 *   POST /api/cases/:caseNo/approve | reject {reason}       SV-01 ผู้ถือเรื่อง · SV-02/03 หัวหน้า (PENDING_APPROVAL)
 *   GET  /api/cases/:caseNo                                 เจ้าหน้าที่/หัวหน้า (ประชาชนตอบโดย citizen.js)
 *   GET  /api/cases/:caseNo/files · GET /api/files/:fileId  ไฟล์แนบตามสิทธิ์ (FR-29)
 *   POST /api/cases/:caseNo/resubmit                        ประชาชนส่งแก้ไข (multipart ไม่บังคับ) ภายใน 168 ชม.
 * หน้า: /officer/queue · /officer/cases/:caseNo · /head/approvals
 * งานทุก request (A-46): คำขอ NEED_FIX ที่พ้นเส้นตาย (ตีกลับ + 168 ชม.) → CANCELLED ณ เวลาเส้นตาย
 *
 * ไม่ได้ทำที่นี่ (บล็อกอื่นเป็นเจ้าของ route · หน้า officer เรียกใช้เท่านั้น):
 *   POST /api/officer/cases/:caseNo/issue   (B07 documents.js · ตั้ง status=COMPLETED closed_at doc_no verify_code)
 *   POST /api/officer/cases/:caseNo/unmask  (B09 reporting.js · ตรวจเหตุผล + Audit UNMASK)
 *
 * BUG_MODE ที่ฝังไว้ (ฝั่ง API เท่านั้น):
 *   B07  เจ้าหน้าที่อนุมัติ SV-02/SV-03 ได้เองที่ API (ข้ามการตรวจ "ต้องเป็นหัวหน้า") แม้หน้าเว็บไม่มีปุ่ม
 *   B08  API รับเรื่องข้ามการตรวจว่ามีผู้ถือแล้ว → คนที่ 2 ได้ 200 และกลายเป็นผู้ถือแทน
 *   B12  ตีกลับครั้งที่ 3 ได้ (ข้ามการตรวจ RETURN_LIMIT ทั้งปุ่มและ API)
 */
const multer = require('multer');
const path = require('path');
const rules = require('./rules');
const auth = require('./auth');
const { actualType } = require('./citizen');

const MAX_WORKLOAD = 10;      // A-19
const MAX_RETURNS = 2;        // A-20
const FIX_WINDOW_MS = 168 * 3600 * 1000; // A-21
const MIN_REASON = 10;        // A-12
const MAX_BYTES = 5242880;
const NO_REFUND = 'ค่าธรรมเนียมที่ชำระแล้วไม่คืน';

const STATUS_TH = {
  DRAFT: 'ร่าง', PENDING_PAYMENT: 'รอชำระเงิน', SUBMITTED: 'ส่งคำขอแล้ว', IN_REVIEW: 'กำลังตรวจสอบ', NEED_FIX: 'รอแก้ไขเอกสาร',
  PENDING_APPROVAL: 'รออนุมัติ', APPROVED: 'อนุมัติ', COMPLETED: 'เสร็จสิ้น', REJECTED: 'ไม่อนุมัติ', CANCELLED: 'ยกเลิก',
};
const EVENT_TH = {
  PAID: 'ชำระเงินแล้ว', CLAIM: 'รับเรื่อง', RETURN: 'ตีกลับ', RESUBMIT: 'ส่งแก้ไข', FORWARD: 'ส่งต่อ',
  APPROVE: 'อนุมัติ', REJECT: 'ไม่อนุมัติ', ISSUE: 'ออกเอกสาร', CANCEL: 'ยกเลิก',
};
const SERVICE_NAME_FALLBACK = {};
const STEP_LABEL = ['', 'ฝ่ายทะเบียน', 'ฝ่ายโยธา', 'หัวหน้าฝ่าย'];
const ERR = {
  NOT_FOUND: 'ไม่พบคำขอ',
  FORBIDDEN: 'ไม่มีสิทธิ์ทำรายการนี้',
  INVALID_STATE: 'สถานะคำขอไม่ถูกต้องสำหรับรายการนี้',
  ALREADY_CLAIMED: 'มีเจ้าหน้าที่รับเรื่องนี้แล้ว',
  WORKLOAD_LIMIT: 'รับงานได้สูงสุด 10 เรื่อง',
  RETURN_LIMIT: 'ตีกลับได้สูงสุด 2 ครั้ง',
  REASON_TOO_SHORT: 'กรุณากรอกเหตุผลอย่างน้อย 10 ตัวอักษร',
  FIX_WINDOW_EXPIRED: 'หมดเวลาแก้ไขแล้ว คำขอถูกยกเลิก',
  FILE_TOO_LARGE: 'ไฟล์ใหญ่เกิน 5 MB',
  FILE_TYPE: 'รองรับเฉพาะไฟล์ PDF, JPG, PNG',
  FILE_COUNT: 'แนบได้สูงสุด 5 ไฟล์ต่อคำขอ',
  PLAN_NOT_PDF: 'แบบแปลนต้องเป็นไฟล์ PDF เท่านั้น',
};

/** ผลลัพธ์ภายในของ action: {ok:true, body} | {ok:false, status, code} */
const fail = (status, code) => ({ ok: false, status, code });

function register(app, ctx) {
  const { db, clock, http, view, audit, bug, security, storage } = ctx;
  const e = view.esc;
  const sendErr = (res, f) => http.apiError(res, f.status, f.code, ERR[f.code] || f.code);
  const send = (res, r, okStatus = 200) => (r.ok ? res.status(okStatus).json(r.body) : sendErr(res, r));

  // ---------------------------------------------------------------- ตัวช่วยข้อมูล
  const getCase = (caseNo) => db.get('SELECT * FROM cases WHERE case_no=?', caseNo);
  const getService = (id) => db.get('SELECT * FROM services WHERE id=?', id);
  const holidays = () => rules.loadHolidays(db);
  const levelOf = (c, hol) => rules.slaLevel({ status: c.status, dueAt: c.due_at, nowMs: clock.now(), holidays: hol || holidays() });
  const isOfficer = (u) => u.role === 'officer';
  const isHead = (u) => u.role === 'head';
  const reasonOk = (r) => typeof r === 'string' && Array.from(r.trim()).length >= MIN_REASON;
  const cleanText = (v) => (typeof v === 'string' ? v.trim() : '');
  const idNoOf = (applicant) => {
    const u = db.get('SELECT * FROM users WHERE username=?', applicant);
    return { user: u, idNo: u && u.id_enc ? security.decrypt(u.id_enc) : '' };
  };
  const stepOf = (c) => (c.service_id === 'SV-03' ? (c.step || 1) : null);

  function logEvent(actor, c, event, fromStatus, toStatus, detail) {
    audit.log(actor, { event, caseNo: c.case_no, fromStatus, toStatus, detail: detail || '' });
    audit.timeline(c.case_no, { username: actor.username, event, fromStatus, toStatus, detail: detail || '' });
  }

  // ---------------------------------------------------------------- งานทุก request: หมดเวลาแก้ไข → ยกเลิกเอง (A-46)
  function autoCancelExpired() {
    const nowIso = clock.nowIso();
    const due = db.all("SELECT case_no, fix_deadline FROM cases WHERE status='NEED_FIX' AND fix_deadline IS NOT NULL AND fix_deadline <= ?", nowIso);
    if (!due.length) return;
    db.tx(() => {
      for (const c of due) {
        // เวลายกเลิก = เส้นตาย (ไม่ขึ้นกับว่ามี request แรกหลังเส้นตายเมื่อไร) · คง fix_deadline ไว้เพื่อแยก "ยกเลิกเอง"
        const r = db.run("UPDATE cases SET status='CANCELLED', cancelled_at=?, dept='', owner=NULL WHERE case_no=? AND status='NEED_FIX'", c.fix_deadline, c.case_no);
        if (r.changes) {
          audit.timeline(c.case_no, { time: c.fix_deadline, username: '', event: 'CANCEL', fromStatus: 'NEED_FIX', toStatus: 'CANCELLED', detail: `หมดเวลาแก้ไข ${NO_REFUND}` });
        }
      }
    });
  }
  ctx.onRequest(autoCancelExpired);

  // ---------------------------------------------------------------- คิว (FR-12)
  const QUEUE_STATUSES = "('SUBMITTED','IN_REVIEW','APPROVED')";

  function queueRows(user) {
    const depts = isHead(user) ? ['registry', 'works'] : [user.dept];
    const marks = depts.map(() => '?').join(',');
    const rows = db.all(
      `SELECT * FROM cases WHERE dept IN (${marks}) AND status IN ${QUEUE_STATUSES} ORDER BY due_at ASC, case_no ASC`, ...depts);
    const hol = holidays();
    return rows.map((c) => {
      const { user: ap, idNo } = idNoOf(c.applicant);
      return {
        c,
        item: {
          caseNo: c.case_no, serviceId: c.service_id, applicantName: ap ? ap.name : '',
          ...auth.officerIdFields(idNo),
          status: c.status, step: stepOf(c), owner: c.owner || '', dueAt: c.due_at, slaLevel: levelOf(c, hol),
        },
        unclaimed: !c.owner && (c.status === 'SUBMITTED' || c.status === 'IN_REVIEW'),
        mine: c.status === 'IN_REVIEW' && c.owner === user.username,
        claimable: isOfficer(user) && c.dept === user.dept && !c.owner && (c.status === 'SUBMITTED' || c.status === 'IN_REVIEW'),
      };
    });
  }
  const workloadOf = (username) =>
    db.get("SELECT COUNT(*) AS n FROM cases WHERE status='IN_REVIEW' AND owner=?", username).n;

  app.get('/api/officer/queue', (req, res) => {
    const filter = ['unclaimed', 'mine'].includes(req.query.filter) ? req.query.filter : 'all';
    const items = queueRows(req.user)
      .filter((r) => filter === 'all' || (filter === 'unclaimed' ? r.unclaimed : r.mine))
      .map((r) => r.item);
    res.json({ items });
  });

  // ---------------------------------------------------------------- รับเรื่อง (FR-13)
  function claim(user, caseNo) {
    return db.tx(() => {
      const c = getCase(caseNo);
      if (!c) return fail(404, 'NOT_FOUND');
      // 1) สิทธิ์: เฉพาะเจ้าหน้าที่ (หัวหน้า/บทบาทอื่นไม่ได้) ของแผนกที่ถือเรื่องอยู่ (ข้ามแผนกไม่ได้)
      if (!isOfficer(user)) return fail(403, 'FORBIDDEN');
      if ((c.dept === 'registry' || c.dept === 'works') && c.dept !== user.dept) return fail(403, 'FORBIDDEN');
      const claimableStatus = c.status === 'SUBMITTED' || c.status === 'IN_REVIEW';
      // 2) มีผู้ถือแล้ว (B08: ข้ามการตรวจนี้ → คนที่ 2 ได้ 200 และเป็นผู้ถือแทน)
      if (claimableStatus && c.owner && !bug('B08')) return fail(409, 'ALREADY_CLAIMED');
      if (!claimableStatus || (c.dept !== user.dept)) return fail(409, 'INVALID_STATE');
      // 3) เพดานงานในมือ (ตรวจเฉพาะตอนรับเรื่อง · A-19)
      if (workloadOf(user.username) >= MAX_WORKLOAD) return fail(409, 'WORKLOAD_LIMIT');
      // ผู้ออกเอกสาร (A-27) = เจ้าหน้าที่ทะเบียนที่รับเรื่องขั้นแรก
      const firstStep = c.dept === 'registry' && (c.service_id !== 'SV-03' || (c.step || 1) === 1);
      db.run('UPDATE cases SET status=?, owner=?, issuer=? WHERE case_no=?', 'IN_REVIEW', user.username, firstStep ? user.username : c.issuer, c.case_no);
      logEvent(user, c, 'CLAIM', c.status, 'IN_REVIEW', '');
      return { ok: true, body: { owner: user.username } };
    });
  }
  app.post('/api/officer/cases/:caseNo/claim', (req, res) => send(res, claim(req.user, req.params.caseNo)));

  // ---------------------------------------------------------------- ตีกลับ (FR-14)
  function returnCase(user, caseNo, reason) {
    return db.tx(() => {
      const c = getCase(caseNo);
      if (!c) return fail(404, 'NOT_FOUND');
      if (!isOfficer(user) || c.owner !== user.username) return fail(403, 'FORBIDDEN');
      if (c.status !== 'IN_REVIEW') return fail(409, 'INVALID_STATE');
      if (c.return_count >= MAX_RETURNS && !bug('B12')) return fail(409, 'RETURN_LIMIT');
      if (!reasonOk(reason)) return fail(400, 'REASON_TOO_SHORT');
      const nowMs = clock.now();
      const nowIso = clock.toIso(nowMs);
      const n = c.return_count + 1;
      const fixDeadline = clock.toIso(nowMs + FIX_WINDOW_MS);
      db.run("UPDATE cases SET status='NEED_FIX', return_count=?, paused_at=?, fix_deadline=? WHERE case_no=?", n, nowIso, fixDeadline, c.case_no);
      db.run('INSERT INTO case_returns(case_no,n,returned_at,resubmitted_at,paused_workdays,reason,by_user) VALUES(?,?,?,?,?,?,?)',
        c.case_no, n, nowIso, null, null, reason.trim(), user.username);
      logEvent(user, c, 'RETURN', 'IN_REVIEW', 'NEED_FIX', reason.trim());
      return { ok: true, body: { status: 'NEED_FIX', returnCount: n } };
    });
  }
  app.post('/api/officer/cases/:caseNo/return', (req, res) =>
    send(res, returnCase(req.user, req.params.caseNo, (req.body || {}).reason)));

  // ---------------------------------------------------------------- ส่งต่ออัตโนมัติตามเส้นทาง (FR-15)
  //   SV-02: ทะเบียน → หัวหน้า · SV-03: ทะเบียน(1) → โยธา(2) → หัวหน้า(3) · SV-01 ไม่มีการส่งต่อ (เจ้าหน้าที่อนุมัติเอง)
  function forward(user, caseNo, note) {
    return db.tx(() => {
      const c = getCase(caseNo);
      if (!c) return fail(404, 'NOT_FOUND');
      if (!isOfficer(user) || c.owner !== user.username) return fail(403, 'FORBIDDEN');
      if (c.status !== 'IN_REVIEW' || c.service_id === 'SV-01') return fail(409, 'INVALID_STATE');
      let body;
      if (c.service_id === 'SV-02') {
        if (c.dept !== 'registry') return fail(409, 'INVALID_STATE');
        db.run("UPDATE cases SET status='PENDING_APPROVAL', dept='head', owner=NULL WHERE case_no=?", c.case_no);
        body = { status: 'PENDING_APPROVAL' };
      } else {
        const step = c.step || 1;
        if (step === 1 && c.dept === 'registry') {
          db.run("UPDATE cases SET step=2, dept='works', owner=NULL, status='IN_REVIEW' WHERE case_no=?", c.case_no);
          body = { status: 'IN_REVIEW', step: 2 };
        } else if (step === 2 && c.dept === 'works') {
          db.run("UPDATE cases SET step=3, status='PENDING_APPROVAL', dept='head', owner=NULL WHERE case_no=?", c.case_no);
          body = { status: 'PENDING_APPROVAL', step: 3 };
        } else {
          return fail(409, 'INVALID_STATE');
        }
      }
      logEvent(user, c, 'FORWARD', 'IN_REVIEW', body.status, cleanText(note));
      return { ok: true, body };
    });
  }
  app.post('/api/officer/cases/:caseNo/forward', (req, res) =>
    send(res, forward(req.user, req.params.caseNo, (req.body || {}).note)));

  // ---------------------------------------------------------------- อนุมัติ / ไม่อนุมัติตามอำนาจ (FR-16)
  /** ผู้อนุมัติ: SV-01 = เจ้าหน้าที่ผู้ถือเรื่อง · SV-02/03 = หัวหน้า (B07: approve ข้ามการตรวจนี้สำหรับเจ้าหน้าที่) */
  function decide(kind, user, caseNo, reason) {
    return db.tx(() => {
      const c = getCase(caseNo);
      if (!c) return fail(404, 'NOT_FOUND');
      const sv01 = c.service_id === 'SV-01';
      let allowed;
      if (sv01) allowed = isOfficer(user);
      else allowed = isHead(user) || (kind === 'approve' && bug('B07') && isOfficer(user));
      if (!allowed) return fail(403, 'FORBIDDEN');
      if (sv01 && c.owner && c.owner !== user.username) return fail(403, 'FORBIDDEN');
      const needStatus = sv01 ? 'IN_REVIEW' : 'PENDING_APPROVAL';
      if (c.status !== needStatus) return fail(409, 'INVALID_STATE');
      if (sv01 && c.owner !== user.username) return fail(403, 'FORBIDDEN');
      const nowIso = clock.nowIso();
      if (kind === 'approve') {
        // APPROVED: ว่างผู้ถือ · ค้างที่ทะเบียนรอผู้ออกเอกสาร (A-27) · ผู้ลงนาม = approver
        db.run("UPDATE cases SET status='APPROVED', dept='registry', owner=NULL, approver=?, approved_at=?, issuer=COALESCE(issuer, ?) WHERE case_no=?",
          user.username, nowIso, sv01 ? user.username : null, c.case_no);
        logEvent(user, c, 'APPROVE', c.status, 'APPROVED', '');
        return { ok: true, body: { status: 'APPROVED' } };
      }
      if (!reasonOk(reason)) return fail(400, 'REASON_TOO_SHORT');
      db.run("UPDATE cases SET status='REJECTED', dept='', owner=NULL, approver=?, closed_at=?, reject_reason=? WHERE case_no=?",
        user.username, nowIso, reason.trim(), c.case_no);
      logEvent(user, c, 'REJECT', c.status, 'REJECTED', reason.trim());
      return { ok: true, body: { status: 'REJECTED', closedAt: nowIso } };
    });
  }
  app.post('/api/cases/:caseNo/approve', (req, res) => send(res, decide('approve', req.user, req.params.caseNo)));
  app.post('/api/cases/:caseNo/reject', (req, res) =>
    send(res, decide('reject', req.user, req.params.caseNo, (req.body || {}).reason)));

  // ---------------------------------------------------------------- รายละเอียดคำขอสำหรับเจ้าหน้าที่/หัวหน้า
  function caseJson(c) {
    const { user: ap, idNo } = idNoOf(c.applicant);
    return {
      caseNo: c.case_no, serviceId: c.service_id, status: c.status, step: stepOf(c), fee: c.fee,
      paidAt: c.paid_at, dueAt: c.due_at, slaLevel: levelOf(c), owner: c.owner || null, returnCount: c.return_count,
      closedAt: c.closed_at || null, applicantName: ap ? ap.name : '', ...auth.officerIdFields(idNo),
      fixDeadline: c.status === 'NEED_FIX' ? c.fix_deadline : null, docNo: c.doc_no || null, verifyCode: c.verify_code || null,
    };
  }
  app.get('/api/cases/:caseNo', (req, res, next) => {
    if (!isOfficer(req.user) && !isHead(req.user)) return next(); // citizen: citizen.js · อื่น ๆ ถูกด่านกลางตอบ 403 แล้ว
    const c = getCase(req.params.caseNo);
    if (!c) return http.apiError(res, 404, 'NOT_FOUND', ERR.NOT_FOUND);
    res.json(caseJson(c));
  });

  // ---------------------------------------------------------------- ไฟล์แนบตามสิทธิ์ (FR-29 · DECISIONS §18)
  const fileJson = (f) => ({ fileId: f.file_id, name: f.name, docKey: f.doc_key, size: f.size });
  /** officer: แผนกตนเองขั้นปัจจุบันหรือเคยผ่าน (ทะเบียนเป็นขั้นแรกของทุกคำขอ · โยธาเฉพาะ SV-03 ที่ถึงขั้น 2 แล้ว) · head: ทุกแผนก */
  function staffMayOpen(user, c) {
    if (isHead(user)) return true;
    if (!isOfficer(user)) return false;
    if (user.dept === 'registry') return true;
    if (user.dept === 'works') return c.service_id === 'SV-03' && (c.step == null || c.step >= 2);
    return false;
  }
  /** คืน null = เปิดได้ · หรือ {status,code} */
  function fileAccess(user, c) {
    if (user.role === 'citizen') return auth.canViewCase(user, c) ? null : { status: 404, code: 'NOT_FOUND' };
    return staffMayOpen(user, c) ? null : { status: 403, code: 'FORBIDDEN' };
  }

  app.get('/api/cases/:caseNo/files', (req, res) => {
    const c = getCase(req.params.caseNo);
    if (!c) {
      // ไม่มีคำขอ: ประชาชนแยกไม่ออกว่ามีหรือไม่ (404) · เจ้าหน้าที่ 404 ปกติ
      return http.apiError(res, 404, 'NOT_FOUND', ERR.NOT_FOUND);
    }
    const denied = fileAccess(req.user, c);
    if (denied) return http.apiError(res, denied.status, denied.code, ERR[denied.code]);
    const items = db.all('SELECT * FROM files WHERE case_no=? ORDER BY created_at, file_id', c.case_no).map(fileJson);
    res.json({ items });
  });

  app.get('/api/files/:fileId', (req, res) => {
    const f = db.get('SELECT * FROM files WHERE file_id=?', req.params.fileId);
    if (!f) return http.apiError(res, 404, 'NOT_FOUND', 'ไม่พบไฟล์');
    if (f.case_no) {
      const c = getCase(f.case_no);
      if (!c) return http.apiError(res, 404, 'NOT_FOUND', 'ไม่พบไฟล์');
      const denied = fileAccess(req.user, c);
      if (denied) return http.apiError(res, denied.status, denied.code, denied.status === 404 ? 'ไม่พบไฟล์' : ERR[denied.code]);
    } else {
      // ไฟล์ของร่างที่ยังไม่ชำระ: เจ้าของร่างเท่านั้น
      const d = db.get('SELECT username FROM drafts WHERE draft_id=?', f.draft_id);
      if (req.user.role !== 'citizen' || !d || d.username !== req.user.username) {
        return http.apiError(res, 404, 'NOT_FOUND', 'ไม่พบไฟล์');
      }
    }
    let data;
    try { data = storage.read(f.path); } catch (_) { return http.apiError(res, 404, 'NOT_FOUND', 'ไม่พบไฟล์'); }
    res.set('Content-Type', f.mime);
    res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(f.name)}"; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    res.set('Cache-Control', 'private, no-store');
    res.send(data);
  });

  // ---------------------------------------------------------------- ประชาชนส่งแก้ไข (FR-11)
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 2, fields: 10 } });
  const citizenOnly = (req, res, next) => (req.user.role === 'citizen' ? next() : http.apiError(res, 403, 'FORBIDDEN', ERR.FORBIDDEN));
  const parseFix = (req, res, next) => upload.single('file')(req, res, (err) => {
    if (!err) return next();
    const code = err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : err.code === 'LIMIT_FILE_COUNT' ? 'FILE_COUNT' : 'FILE_TYPE';
    return http.apiError(res, 400, code, ERR[code]);
  });

  function checkFixFile(f, docKey, c) {
    if (bug('B02') ? f.size >= MAX_BYTES : f.size > MAX_BYTES) return 'FILE_TOO_LARGE';
    const type = actualType(f.buffer);
    if (!type) return 'FILE_TYPE';
    const docs = db.all('SELECT * FROM service_docs WHERE service_id=?', c.service_id);
    if (docKey !== 'extra' && !docs.some((d) => d.doc_key === docKey)) return 'FILE_TYPE';
    if (docs.some((d) => d.doc_key === docKey && d.pdf_only) && type[0] !== 'application/pdf') return 'PLAN_NOT_PDF';
    return null;
  }

  app.post('/api/cases/:caseNo/resubmit', citizenOnly, parseFix, (req, res) => {
    const c0 = db.get('SELECT * FROM cases WHERE case_no=? AND applicant=?', req.params.caseNo, req.user.username);
    if (!c0) return http.apiError(res, 404, 'NOT_FOUND', ERR.NOT_FOUND);
    const file = req.file;
    const docKey = cleanText((req.body || {}).docKey) || 'extra';
    const r = db.tx(() => {
      const c = getCase(c0.case_no);
      // ถูกยกเลิกเพราะหมดเวลาแก้ไข (autoCancelExpired คง fix_deadline ไว้) → FIX_WINDOW_EXPIRED
      if (c.status === 'CANCELLED' && c.fix_deadline) return fail(409, 'FIX_WINDOW_EXPIRED');
      if (c.status !== 'NEED_FIX') return fail(409, 'INVALID_STATE');
      const nowMs = clock.now();
      if (nowMs >= clock.parseIso(c.fix_deadline)) { // 168:00 พอดี = หมดเวลา (167:59 ยังส่งได้)
        autoCancelExpired();
        return fail(409, 'FIX_WINDOW_EXPIRED');
      }
      if (file) {
        const bad = checkFixFile(file, docKey, c);
        if (bad) return fail(400, bad);
        const count = db.get('SELECT COUNT(*) AS n FROM files WHERE case_no=?', c.case_no).n;
        if (count >= 5) return fail(400, 'FILE_COUNT');
      }
      const nowIso = clock.toIso(nowMs);
      const hol = holidays();
      const newDue = rules.extendDueAtOnResubmit(c.due_at, c.paused_at, nowIso, hol);
      const paused = rules.pausedBusinessDays(c.paused_at, nowIso, hol);
      db.run("UPDATE cases SET status='IN_REVIEW', due_at=?, paused_at=NULL, fix_deadline=NULL WHERE case_no=?", newDue, c.case_no);
      db.run(`UPDATE case_returns SET resubmitted_at=?, paused_workdays=?
              WHERE id=(SELECT id FROM case_returns WHERE case_no=? AND resubmitted_at IS NULL ORDER BY n DESC LIMIT 1)`,
        nowIso, paused, c.case_no);
      if (file) {
        const type = actualType(file.buffer);
        const rel = storage.save(file.buffer, type[1]);
        const name = path.basename(String(file.originalname).replace(/\\/g, '/'));
        db.run('INSERT INTO files(file_id,draft_id,case_no,doc_key,name,size,mime,path,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
          ctx.ids.nextFileId(), null, c.case_no, docKey, name, file.size, type[0], rel, nowIso);
      }
      audit.timeline(c.case_no, { time: nowIso, username: req.user.username, event: 'RESUBMIT', fromStatus: 'NEED_FIX', toStatus: 'IN_REVIEW', detail: file ? `แนบไฟล์ ${path.basename(String(file.originalname))}` : '' });
      return { ok: true, body: { status: 'IN_REVIEW', dueAt: newDue } };
    });
    send(res, r);
  });

  // =================================================================== หน้าเว็บ
  const slaCell = (c, hol) => {
    const lv = levelOf(c, hol);
    return `<td data-testid="row-sla-level" data-level="${e(lv || '')}">${e(rules.slaLevelTh(lv))}</td>`;
  };

  // ---------------------------------------------------------------- /officer/queue (CONTRACT §2.7)
  app.get('/officer/queue', (req, res) => {
    const user = req.user;
    const rows = queueRows(user);
    const hol = holidays();
    const filter = ['unclaimed', 'mine'].includes(req.query.filter) ? req.query.filter : 'all';
    const body = rows.map(({ c, item, unclaimed, mine, claimable }) => {
      const svc = getService(c.service_id);
      return `<tr data-testid="queue-row" data-case-no="${e(c.case_no)}" data-owner="${e(c.owner || '')}" data-status="${e(c.status)}" data-sla-level="${e(item.slaLevel || '')}" data-unclaimed="${unclaimed ? 1 : 0}" data-mine="${mine ? 1 : 0}">
<td><a data-testid="row-case-no" href="/officer/cases/${e(c.case_no)}">${e(c.case_no)}</a></td>
<td data-testid="row-service">${e(c.service_id)}${svc ? ' ' + e(svc.name) : ''}${c.service_id === 'SV-03' ? ` · ขั้นตอน ${c.step || 1}/3` : ''}</td>
<td data-testid="row-applicant">${e(item.applicantName)}</td>
<td data-testid="row-id-masked">${e(item.idMasked)}</td>
<td data-testid="row-status">${e(STATUS_TH[c.status])}</td>
<td>${view.dt(c.due_at, 'data-testid="row-due"')}</td>
${slaCell(c, hol)}
<td data-testid="row-owner">${e(c.owner || '')}</td>
<td>${claimable ? '<button type="button" data-testid="claim-btn">รับเรื่อง</button>' : ''}</td>
</tr>`;
    }).join('\n');
    const workload = isOfficer(user)
      ? `<p>งานในมือของฉัน <strong data-testid="workload-count">${workloadOf(user.username)}</strong> / ${MAX_WORKLOAD}</p>` : '';
    const sel = (v, t) => `<option value="${v}"${filter === v ? ' selected' : ''}>${t}</option>`;
    view.page(req, res, {
      title: 'คิวงาน',
      body: `<h1>คิวงาน${isOfficer(user) ? (user.dept === 'works' ? ' ฝ่ายโยธา' : ' ฝ่ายทะเบียน') : ' ทุกแผนก'}</h1>
${workload}
<div class="field"><label for="queue-filter">แสดง</label>
<select id="queue-filter" data-testid="queue-filter">${sel('all', 'ทั้งหมด')}${sel('unclaimed', 'ยังไม่มีผู้รับ')}${sel('mine', 'ของฉัน')}</select></div>
<div class="table-wrap"><table data-testid="queue-table">
<thead><tr><th>เลขคำขอ</th><th>บริการ</th><th>ผู้ยื่น</th><th>เลขบัตร</th><th>สถานะ</th><th>กำหนดเสร็จ</th><th>ระดับเตือน</th><th>ผู้ถือเรื่อง</th><th>การทำงาน</th></tr></thead>
<tbody id="queue-body">
${body}
</tbody></table></div>
<div id="queue-empty-slot"></div>
<script>(${queueClient.toString()})();</script>`,
    });
  });

  // ---------------------------------------------------------------- /head/approvals (CONTRACT §2.8)
  app.get('/head/approvals', (req, res) => {
    const rows = db.all("SELECT * FROM cases WHERE status='PENDING_APPROVAL' ORDER BY due_at ASC, case_no ASC");
    const body = rows.map((c) => {
      const svc = getService(c.service_id);
      const ap = db.get('SELECT name FROM users WHERE username=?', c.applicant);
      return `<tr data-testid="approval-row" data-case-no="${e(c.case_no)}">
<td data-testid="row-case-no">${e(c.case_no)}</td>
<td data-testid="row-service">${e(c.service_id)}${svc ? ' ' + e(svc.name) : ''}</td>
<td data-testid="row-applicant">${e(ap ? ap.name : '')}</td>
<td>${view.dt(c.due_at, 'data-testid="row-due"')}</td>
<td><a data-testid="approval-open" href="/officer/cases/${e(c.case_no)}">เปิดคำขอ</a></td></tr>`;
    }).join('\n');
    view.page(req, res, {
      title: 'รออนุมัติ',
      body: `<h1>รออนุมัติ</h1>
<div class="table-wrap"><table data-testid="approval-table"><thead><tr><th>เลขคำขอ</th><th>บริการ</th><th>ผู้ยื่น</th><th>กำหนดเสร็จ</th><th></th></tr></thead>
<tbody>${body}</tbody></table></div>
${rows.length ? '' : '<p data-testid="approval-empty">ไม่มีรายการรออนุมัติ</p>'}`,
    });
  });

  // ---------------------------------------------------------------- /officer/cases/:caseNo (CONTRACT §2.6 ฝั่งเจ้าหน้าที่)
  app.get('/officer/cases/:caseNo', (req, res) => {
    const user = req.user;
    const c = getCase(req.params.caseNo);
    if (!c) return view.notFound(req, res);
    const svc = getService(c.service_id);
    const { user: ap, idNo } = idNoOf(c.applicant);
    const masked = auth.officerIdFields(idNo).idMasked; // เลขเต็มไม่อยู่ใน HTML เด็ดขาด (BR-24)
    const lv = levelOf(c);
    const timeline = db.all('SELECT * FROM case_timeline WHERE case_no=? ORDER BY time, id', c.case_no);
    const attached = db.all('SELECT * FROM files WHERE case_no=? ORDER BY created_at, file_id', c.case_no);
    const doc = c.doc_no ? db.get('SELECT * FROM documents WHERE doc_no=?', c.doc_no) : null;

    const mine = isOfficer(user) && c.owner === user.username;
    const canClaim = isOfficer(user) && c.dept === user.dept && !c.owner && (c.status === 'SUBMITTED' || c.status === 'IN_REVIEW');
    const inReview = c.status === 'IN_REVIEW';
    const sv01 = c.service_id === 'SV-01';
    const canReturn = mine && inReview && (c.return_count < MAX_RETURNS || bug('B12'));
    const canForward = mine && inReview && !sv01;
    const canDecideSv01 = mine && inReview && sv01;
    const canDecideHead = isHead(user) && c.status === 'PENDING_APPROVAL' && !sv01;
    const canApprove = canDecideSv01 || canDecideHead;
    const canReject = canApprove;
    const canIssue = isOfficer(user) && c.status === 'APPROVED' && c.issuer === user.username;
    const canUnmask = isOfficer(user) || isHead(user);

    const step = c.service_id === 'SV-03' ? `<p data-testid="case-step">ขั้นตอน ${c.step || 1}/3 · ${STEP_LABEL[c.step || 1]}</p>` : '';
    const reasonForm = (kind, label, btnTestid) => `
<div id="${kind}-form" class="card" hidden>
<label for="${kind}-reason">เหตุผล${label}</label>
<textarea id="${kind}-reason" data-testid="${kind}-reason" rows="3"></textarea>
<p data-testid="${kind}-reason-error" class="msg msg-error" role="alert"></p>
<button type="button" data-testid="${kind}-submit" id="${kind}-submit">ยืนยัน${label}</button>
</div>`;
    const actions = [
      canClaim ? '<button type="button" data-testid="claim-btn" id="claim-btn">รับเรื่อง</button>' : '',
      canReturn ? '<button type="button" data-testid="return-btn" id="return-btn">ตีกลับ</button>' : '',
      canForward ? '<label for="forward-note">หมายเหตุส่งต่อ (ไม่บังคับ)</label><input type="text" id="forward-note" data-testid="forward-note"><button type="button" data-testid="forward-btn" id="forward-btn">ผ่าน/ส่งต่อ</button>' : '',
      canApprove ? '<button type="button" data-testid="approve-btn" id="approve-btn">อนุมัติ</button>' : '',
      canReject ? '<button type="button" data-testid="reject-btn" id="reject-btn">ไม่อนุมัติ</button>' : '',
      canIssue ? '<button type="button" data-testid="issue-btn" id="issue-btn">ออกเอกสาร</button>' : '',
    ].join('\n');

    view.page(req, res, {
      title: c.case_no,
      body: `<h1 data-testid="case-no">${e(c.case_no)}</h1>
<p data-testid="case-service">${e(c.service_id)} ${e(svc ? svc.name : '')}</p>
<p>สถานะ <strong data-testid="case-status" data-status="${e(c.status)}">${e(STATUS_TH[c.status])}</strong></p>
${step}
<p>ผู้ยื่น <span data-testid="applicant-name">${e(ap ? ap.name : '')}</span></p>
<p>เลขบัตรประชาชน <span data-testid="applicant-id">${e(masked)}</span>
${canUnmask ? '<button type="button" data-testid="show-full-id-btn" id="show-full-id-btn">แสดงเลขเต็ม</button>' : ''}</p>
${canUnmask ? `<div id="unmask-form" class="card" hidden>
<label for="unmask-reason">เหตุผลที่ขอดูเลขเต็ม</label>
<input type="text" id="unmask-reason" data-testid="unmask-reason">
<button type="button" data-testid="unmask-submit" id="unmask-submit">ยืนยัน</button>
<p data-testid="unmask-error" class="msg msg-error" role="alert"></p>
<div id="unmask-result"></div></div>` : ''}
<p>ค่าธรรมเนียม <strong data-testid="case-fee">${e(rules.fmtBaht(c.fee))}</strong></p>
<p>กำหนดเสร็จ ${view.dt(c.due_at, 'data-testid="sla-due"')}</p>
<p>ระดับเตือน <strong data-testid="sla-level" data-level="${e(lv || '')}">${e(rules.slaLevelTh(lv))}</strong></p>
${c.closed_at ? `<p>ปิดงาน ${view.dt(c.closed_at, 'data-testid="closed-at"')}</p>` : ''}
<p>ผู้ถือเรื่อง <strong data-testid="case-owner">${e(c.owner || 'ยังไม่มีผู้รับ')}</strong></p>
<p>ตีกลับแล้ว <strong data-testid="return-count">${c.return_count}</strong> ครั้ง</p>
${['REJECTED', 'CANCELLED'].includes(c.status) ? `<p data-testid="no-refund-note">${NO_REFUND}</p>` : ''}
${c.reject_reason ? `<p>เหตุผล: ${e(c.reject_reason)}</p>` : ''}
<section class="card"><h2>เอกสารแนบ</h2>
<ul>${attached.map((f) => `<li data-testid="doc-item" data-name="${e(f.name)}" data-file-id="${e(f.file_id)}"><a data-testid="doc-download-link" href="/api/files/${e(f.file_id)}">${e(f.name)}</a></li>`).join('')}</ul></section>
${doc ? `<section class="card"><h2>เอกสารดิจิทัล</h2>
<p>เลขเอกสาร <span data-testid="doc-no">${e(c.doc_no)}</span></p>
<p>รหัสตรวจสอบ <span data-testid="verify-code">${e(c.verify_code)}</span></p>
<p data-testid="doc-qr" data-url="${e(req.protocol + '://' + req.get('host') + '/verify/' + c.verify_code)}">QR ตรวจสอบเอกสาร: <a href="/verify/${e(c.verify_code)}">/verify/${e(c.verify_code)}</a></p></section>` : ''}
<section class="card" aria-label="การดำเนินการ"><h2>การดำเนินการ</h2>
<div class="actions">${actions}</div>
${canReturn ? reasonForm('return', 'ตีกลับ') : ''}
${canReject ? reasonForm('reject', 'ไม่อนุมัติ') : ''}
</section>
<h2>ประวัติคำขอ</h2>
<ol data-testid="case-timeline">${timeline.map((t) => `<li data-testid="timeline-item" data-iso="${e(t.time)}">${view.dt(t.time)} · ${e(EVENT_TH[t.event] || t.event)}${t.username ? ' · ' + e(t.username) : ''}${t.to_status ? ' → ' + e(STATUS_TH[t.to_status] || t.to_status) : ''}${t.detail ? ' · ' + e(t.detail) : ''}</li>`).join('')}</ol>
<script>(${caseClient.toString()})(${JSON.stringify(c.case_no)});</script>`,
    });
  });
}

// =====================================================================================
// สคริปต์ฝั่งเบราว์เซอร์ (ฝังด้วย Function.toString · ใช้ window.EG จาก /static/app.js ตอนกดปุ่มเท่านั้น)
// =====================================================================================

/** หน้าคิว: กรองแบบซิงก์ในเบราว์เซอร์ (เปลี่ยนตัวกรองแล้วจำนวนแถวเปลี่ยนทันที) · กดรับเรื่อง → POST claim */
function queueClient() {
  var body = document.getElementById('queue-body');
  var select = document.querySelector('[data-testid="queue-filter"]');
  var slot = document.getElementById('queue-empty-slot');
  var all = Array.prototype.slice.call(body.children);
  function apply() {
    var f = select.value;
    while (body.firstChild) body.removeChild(body.firstChild);
    var shown = 0;
    all.forEach(function (tr) {
      var ok = f === 'all' || (f === 'unclaimed' && tr.getAttribute('data-unclaimed') === '1') || (f === 'mine' && tr.getAttribute('data-mine') === '1');
      if (ok) { body.appendChild(tr); shown++; }
    });
    slot.innerHTML = shown ? '' : '<p data-testid="queue-empty">ไม่มีงานในคิว</p>';
    try {
      var url = new URL(location.href);
      if (f === 'all') url.searchParams.delete('filter'); else url.searchParams.set('filter', f);
      history.replaceState(null, '', url.toString());
    } catch (err) { /* ไม่เป็นไร */ }
  }
  select.addEventListener('change', apply);
  apply();
  body.addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('[data-testid="claim-btn"]') : null;
    if (!btn) return;
    var tr = btn.closest('tr');
    btn.disabled = true;
    window.EG.api('POST', '/api/officer/cases/' + encodeURIComponent(tr.getAttribute('data-case-no')) + '/claim').then(function (r) {
      if (r.ok) { location.reload(); return; }
      btn.disabled = false;
      window.EG.error((r.data && r.data.message) || 'เกิดข้อผิดพลาด');
    });
  });
}

/** หน้าคำขอฝั่งเจ้าหน้าที่: ปุ่มดำเนินการทั้งหมด · สำเร็จ → โหลดหน้าใหม่ (สถานะ/ปุ่มมาจากเซิร์ฟเวอร์) */
function caseClient(caseNo) {
  var base = '/api/officer/cases/' + encodeURIComponent(caseNo);
  var apiCase = '/api/cases/' + encodeURIComponent(caseNo);
  function $(id) { return document.getElementById(id); }
  function q(testid) { return document.querySelector('[data-testid="' + testid + '"]'); }
  function msg(r) { return (r.data && r.data.message) || 'เกิดข้อผิดพลาด'; }
  function act(btn, method, url, payload, onFail) {
    if (btn) btn.disabled = true;
    window.EG.api(method, url, payload).then(function (r) {
      if (r.ok) { location.reload(); return; }
      if (btn) btn.disabled = false;
      if (onFail) onFail(r); else window.EG.error(msg(r));
    });
  }
  function toggle(formId, focusId) {
    var f = $(formId);
    f.hidden = !f.hidden;
    if (!f.hidden && $(focusId)) $(focusId).focus();
  }
  if ($('claim-btn')) $('claim-btn').onclick = function () { act($('claim-btn'), 'POST', base + '/claim'); };
  if ($('forward-btn')) $('forward-btn').onclick = function () {
    act($('forward-btn'), 'POST', base + '/forward', { note: $('forward-note').value });
  };
  if ($('approve-btn')) $('approve-btn').onclick = function () { act($('approve-btn'), 'POST', apiCase + '/approve'); };
  if ($('issue-btn')) $('issue-btn').onclick = function () { act($('issue-btn'), 'POST', base + '/issue'); };
  if ($('return-btn')) {
    $('return-btn').onclick = function () { toggle('return-form', 'return-reason'); };
    $('return-submit').onclick = function () {
      var err = q('return-reason-error');
      err.textContent = '';
      act($('return-submit'), 'POST', base + '/return', { reason: $('return-reason').value }, function (r) {
        if (r.data && r.data.code === 'REASON_TOO_SHORT') err.textContent = msg(r); else window.EG.error(msg(r));
      });
    };
  }
  if ($('reject-btn')) {
    $('reject-btn').onclick = function () { toggle('reject-form', 'reject-reason'); };
    $('reject-submit').onclick = function () {
      var err = q('reject-reason-error');
      err.textContent = '';
      act($('reject-submit'), 'POST', apiCase + '/reject', { reason: $('reject-reason').value }, function (r) {
        if (r.data && r.data.code === 'REASON_TOO_SHORT') err.textContent = msg(r); else window.EG.error(msg(r));
      });
    };
  }
  if ($('show-full-id-btn')) {
    $('show-full-id-btn').onclick = function () { toggle('unmask-form', 'unmask-reason'); };
    $('unmask-submit').onclick = function () {
      var err = q('unmask-error');
      var reason = $('unmask-reason').value;
      err.textContent = '';
      if (!reason.trim()) { err.textContent = 'กรุณากรอกเหตุผล'; return; }
      window.EG.api('POST', base + '/unmask', { reason: reason }).then(function (r) {
        if (!r.ok) { err.textContent = (r.data && r.data.code === 'REASON_REQUIRED') ? msg(r) : msg(r); return; }
        var s = String(r.data.idNo || '');
        var shown = s.length === 13 ? s[0] + '-' + s.slice(1, 5) + '-' + s.slice(5, 10) + '-' + s.slice(10, 12) + '-' + s[12] : s;
        var out = $('unmask-result');
        out.innerHTML = '';
        var span = document.createElement('strong');
        span.setAttribute('data-testid', 'full-id');
        span.textContent = shown;
        out.appendChild(span);
      });
    };
  }
}

module.exports = { register };
