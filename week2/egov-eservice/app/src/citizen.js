'use strict';
/** B04: citizen catalogue, draft wizard, attachments, own cases and cancellation.
 * Payment creation/callbacks belong to payment.js. Staff case operations belong to workflow.js.
 * Extra editing API: PUT /api/drafts/:id and DELETE /api/drafts/:id/files/:fileId.
 */
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const rules = require('./rules');
const auth = require('./auth');

const STATUS = { DRAFT: 'ร่าง', PENDING_PAYMENT: 'รอชำระเงิน', SUBMITTED: 'ส่งคำขอแล้ว', IN_REVIEW: 'กำลังตรวจสอบ', NEED_FIX: 'รอแก้ไขเอกสาร', PENDING_APPROVAL: 'รออนุมัติ', APPROVED: 'อนุมัติ', COMPLETED: 'เสร็จสิ้น', REJECTED: 'ไม่อนุมัติ', CANCELLED: 'ยกเลิก' };
const MESSAGES = { NOT_FOUND: 'ไม่พบคำขอ', INVALID_STATE: 'สถานะคำขอไม่ถูกต้องสำหรับรายการนี้', FILE_TOO_LARGE: 'ไฟล์ใหญ่เกิน 5 MB', FILE_TYPE: 'รองรับเฉพาะไฟล์ PDF, JPG, PNG', FILE_COUNT: 'แนบได้สูงสุด 5 ไฟล์ต่อคำขอ', PLAN_NOT_PDF: 'แบบแปลนต้องเป็นไฟล์ PDF เท่านั้น', CANNOT_CANCEL: 'ยกเลิกไม่ได้ คำขอมีเจ้าหน้าที่รับเรื่องแล้ว', FIX_WINDOW_EXPIRED: 'หมดเวลาแก้ไขแล้ว คำขอถูกยกเลิก', FORBIDDEN: 'ไม่มีสิทธิ์ทำรายการนี้' };
const MAX_BYTES = 5242880;
const NO_REFUND = 'ค่าธรรมเนียมที่ชำระแล้วไม่คืน';
const json = (x) => JSON.stringify(x).replace(/</g, '\\u003c');

function actualType(bytes) {
  if (bytes.subarray(0, 4).equals(Buffer.from('%PDF'))) return ['application/pdf', 'pdf'];
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return ['image/jpeg', 'jpg'];
  if (bytes.subarray(0, 4).equals(Buffer.from([137, 80, 78, 71]))) return ['image/png', 'png'];
  return null;
}

function register(app, ctx) {
  const { db, clock, ids, view, storage, http } = ctx;
  const e = view.esc;
  const fail = (res, status, code, extra) => http.apiError(res, status, code, MESSAGES[code] || code, extra);
  const service = (id) => db.get('SELECT * FROM services WHERE id=?', id);
  const docs = (id) => db.all('SELECT * FROM service_docs WHERE service_id=? ORDER BY sort, rowid', id);
  const files = (draftId) => db.all('SELECT * FROM files WHERE draft_id=? ORDER BY created_at,file_id', draftId);
  const fileJson = (f) => ({ fileId: f.file_id, name: f.name, docKey: f.doc_key, size: f.size });
  const draftJson = (d) => ({ draftId: d.draft_id, serviceId: d.service_id, status: d.status, qty: d.qty, areaSqm: d.area_sqm, fee: d.fee });
  const ownDraft = (req) => db.get('SELECT * FROM drafts WHERE draft_id=? AND username=?', req.params.id, req.user.username);
  const level = (c) => rules.slaLevel({ status: c.status, dueAt: c.due_at, nowMs: clock.now(), holidays: rules.loadHolidays(db) });
  const missingDocs = (d) => {
    const attached = files(d.draft_id);
    return docs(d.service_id).filter((doc) => doc.required && !attached.some((f) => f.doc_key === doc.doc_key && (!doc.pdf_only || f.mime === 'application/pdf'))).map((doc) => doc.label);
  };
  const unlink = (row) => {
    try { fs.unlinkSync(path.join(ctx.config.UPLOAD_DIR, path.basename(row.path))); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  };

  // Memory parser deliberately accepts more than 6 MB; the application returns the contract's 400.
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 6, fields: 10 } });
  const parseUpload = (req, res, next) => upload.single('file')(req, res, (err) => {
    if (!err) return next();
    return fail(res, 400, err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : err.code === 'LIMIT_FILE_COUNT' ? 'FILE_COUNT' : 'FILE_TYPE');
  });
  function checkedFile(f, docKey, serviceId) {
    if (!f) return 'FILE_TYPE';
    if (ctx.bug('B02') ? f.size >= MAX_BYTES : f.size > MAX_BYTES) return 'FILE_TOO_LARGE';
    const type = actualType(f.buffer);
    if (!type) return 'FILE_TYPE';
    if (docKey !== 'extra' && !docs(serviceId).some((d) => d.doc_key === docKey)) return 'FILE_TYPE';
    if (docs(serviceId).some((d) => d.doc_key === docKey && d.pdf_only) && type[0] !== 'application/pdf') return 'PLAN_NOT_PDF';
    return null;
  }
  function persistFile(f, docKey, draftId, caseNo) {
    const type = actualType(f.buffer);
    const fileId = ids.nextFileId();
    const filename = path.basename(String(f.originalname).replace(/\\/g, '/'));
    const rel = storage.save(f.buffer, type[1]);
    db.run('INSERT INTO files(file_id,draft_id,case_no,doc_key,name,size,mime,path,created_at) VALUES(?,?,?,?,?,?,?,?,?)', fileId, draftId, caseNo, docKey, filename, f.size, type[0], rel, clock.nowIso());
    return { fileId, name: filename, docKey, size: f.size };
  }

  // The same synchronous DB transaction used by claim prevents cancellation/claim races.
  app.post('/api/drafts', (req, res) => {
    const s = service(req.body.serviceId);
    const fee = rules.calcFee(s, req.body);
    if (!fee.ok) return http.apiError(res, fee.status, fee.code, fee.message);
    const draftId = db.tx(() => {
      const id = ids.nextDraftId();
      const now = clock.nowIso();
      db.run('INSERT INTO drafts(draft_id,username,service_id,status,qty,area_sqm,fee,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', id, req.user.username, s.id, 'DRAFT', s.id === 'SV-01' ? Number(req.body.qty || 1) : null, s.id === 'SV-03' ? Number(req.body.areaSqm) : null, fee.fee, now, now);
      return id;
    });
    res.status(201).json({ draftId, fee: fee.fee });
  });
  app.get('/api/drafts', (req, res) => res.json({ items: db.all("SELECT * FROM drafts WHERE username=? AND status!='PAID' ORDER BY draft_id DESC", req.user.username).map(draftJson) }));
  app.get('/api/drafts/:id', (req, res) => {
    const d = ownDraft(req);
    if (!d) return fail(res, 404, 'NOT_FOUND');
    const payment = db.get('SELECT ref FROM payments WHERE draft_id=? ORDER BY rowid DESC LIMIT 1', d.draft_id);
    res.json({ ...draftJson(d), files: files(d.draft_id).map(fileJson), paymentRef: payment ? payment.ref : null });
  });
  app.put('/api/drafts/:id', (req, res) => {
    const d = ownDraft(req);
    if (!d) return fail(res, 404, 'NOT_FOUND');
    if (d.status !== 'DRAFT') return fail(res, 409, 'INVALID_STATE');
    const result = rules.calcFee(service(d.service_id), req.body);
    if (!result.ok) return http.apiError(res, result.status, result.code, result.message);
    db.run('UPDATE drafts SET qty=?,area_sqm=?,fee=?,updated_at=? WHERE draft_id=?', d.service_id === 'SV-01' ? Number(req.body.qty || 1) : null, d.service_id === 'SV-03' ? Number(req.body.areaSqm) : null, result.fee, clock.nowIso(), d.draft_id);
    res.json({ draftId: d.draft_id, fee: result.fee });
  });
  app.delete('/api/drafts/:id', (req, res) => {
    const d = ownDraft(req);
    if (!d) return fail(res, 404, 'NOT_FOUND');
    if (d.status === 'PAID' || db.get("SELECT ref FROM payments WHERE draft_id=? AND status='PAID'", d.draft_id)) return fail(res, 409, 'INVALID_STATE');
    const removed = files(d.draft_id);
    db.tx(() => {
      db.run('DELETE FROM payments WHERE draft_id=?', d.draft_id);
      db.run('DELETE FROM files WHERE draft_id=?', d.draft_id);
      db.run('DELETE FROM drafts WHERE draft_id=?', d.draft_id);
    });
    removed.forEach(unlink);
    res.status(204).end();
  });
  app.post('/api/drafts/:id/files', parseUpload, (req, res) => {
    const d = ownDraft(req);
    if (!d) return fail(res, 404, 'NOT_FOUND');
    if (d.status === 'PAID') return fail(res, 409, 'INVALID_STATE');
    const invalid = checkedFile(req.file, req.body.docKey, d.service_id);
    if (invalid) return fail(res, 400, invalid);
    if (files(d.draft_id).length >= 5) return fail(res, 400, 'FILE_COUNT');
    res.status(201).json(persistFile(req.file, req.body.docKey, d.draft_id, null));
  });
  app.delete('/api/drafts/:id/files/:fileId', (req, res) => {
    const d = ownDraft(req);
    if (!d) return fail(res, 404, 'NOT_FOUND');
    if (d.status === 'PAID') return fail(res, 409, 'INVALID_STATE');
    const f = db.get('SELECT * FROM files WHERE draft_id=? AND file_id=?', d.draft_id, req.params.fileId);
    if (!f) return fail(res, 404, 'NOT_FOUND');
    db.run('DELETE FROM files WHERE file_id=?', f.file_id);
    unlink(f);
    res.status(204).end();
  });
  // Run before payment.js: required documents cannot be bypassed through the API.
  app.post('/api/drafts/:id/payment', (req, res, next) => {
    const d = ownDraft(req);
    if (!d) return fail(res, 404, 'NOT_FOUND');
    if (d.status === 'PAID') return fail(res, 409, 'INVALID_STATE');
    const missing = missingDocs(d);
    if (missing.length) return http.apiError(res, 409, 'MISSING_DOCS', 'ยังขาดเอกสาร: ' + missing.join(', '), { missing });
    next();
  });

  app.get('/api/cases', http.requireApi('citizen'), (req, res) => res.json({ items: db.all('SELECT * FROM cases WHERE applicant=? ORDER BY case_no DESC', req.user.username).map((c) => ({ caseNo: c.case_no, serviceId: c.service_id, status: c.status, dueAt: c.due_at, slaLevel: level(c) })) }));
  app.get('/api/cases/:caseNo', (req, res, next) => {
    if (req.user.role !== 'citizen') return next();
    const c = db.get('SELECT * FROM cases WHERE case_no=?', req.params.caseNo);
    if (!auth.canViewCase(req.user, c, 'case')) return fail(res, 404, 'NOT_FOUND');
    const u = db.get('SELECT * FROM users WHERE username=?', c.applicant);
    res.json({ caseNo: c.case_no, serviceId: c.service_id, status: c.status, step: c.step, fee: c.fee, paidAt: c.paid_at, dueAt: c.due_at, slaLevel: level(c), owner: c.owner, returnCount: c.return_count, closedAt: c.closed_at, applicantName: u.name, idNo: ctx.security.decrypt(u.id_enc), fixDeadline: c.fix_deadline, docNo: c.doc_no, verifyCode: c.verify_code });
  });
  app.post('/api/cases/:caseNo/cancel', http.requireApi('citizen'), (req, res) => {
    const c = db.get('SELECT * FROM cases WHERE case_no=? AND applicant=?', req.params.caseNo, req.user.username);
    if (!c) return fail(res, 404, 'NOT_FOUND');
    const changed = db.tx(() => {
      const result = db.run("UPDATE cases SET status='CANCELLED',cancelled_at=?,dept='',owner=NULL WHERE case_no=? AND status='SUBMITTED' AND owner IS NULL", clock.nowIso(), c.case_no);
      if (result.changes) db.run("INSERT INTO case_timeline(case_no,time,username,event,from_status,to_status,detail) VALUES(?,?,?,'CANCEL','SUBMITTED','CANCELLED',?)", c.case_no, clock.nowIso(), req.user.username, NO_REFUND);
      return result.changes;
    });
    if (!changed) return fail(res, 409, 'CANNOT_CANCEL');
    res.json({ status: 'CANCELLED' });
  });

  app.get('/citizen', (req, res) => {
    const catalogue = db.all('SELECT * FROM services ORDER BY sort,id').map((s) => `<article class="card"><h2>${e(s.name)}</h2><p>${e(s.id)} · ระยะเวลาดำเนินการ ${s.sla} วันทำการ</p><p>${e(rules.fmtBaht(s.fee))}${s.id === 'SV-01' ? ' ต่อฉบับ' : s.id === 'SV-03' ? ' เริ่มต้น' : ''}</p><a class="button" data-testid="start-service-${e(s.id)}" href="/citizen/new/${e(s.id)}">เริ่มบริการ</a></article>`).join('');
    const cases = db.all('SELECT c.*,s.name FROM cases c JOIN services s ON s.id=c.service_id WHERE c.applicant=? ORDER BY c.case_no DESC', req.user.username);
    const drafts = db.all("SELECT d.*,s.name FROM drafts d JOIN services s ON s.id=d.service_id WHERE d.username=? AND d.status!='PAID' ORDER BY d.draft_id DESC", req.user.username);
    view.page(req, res, { title: 'คำขอของฉัน', body: `<h1 data-testid="citizen-welcome">สวัสดี ${e(req.user.name)}</h1><section aria-label="บริการของเทศบาล" class="grid">${catalogue}</section><h2>คำขอของฉัน</h2><div class="table-wrap"><table><thead><tr><th>เลขคำขอ</th><th>บริการ</th><th>สถานะ</th><th>กำหนดเสร็จ</th><th>ระดับเตือน</th></tr></thead><tbody>${cases.map((c) => `<tr data-testid="my-case-row" data-case-no="${e(c.case_no)}" data-status="${e(c.status)}"><td><a data-testid="row-case-no" href="/citizen/cases/${e(c.case_no)}">${e(c.case_no)}</a></td><td data-testid="row-service">${e(c.name)}</td><td data-testid="row-status">${STATUS[c.status]}</td><td>${view.dt(c.due_at, 'data-testid="row-due"')}</td><td data-testid="row-sla-level" data-level="${level(c)}">${rules.slaLevelTh(level(c))}</td></tr>`).join('')}</tbody></table></div><h2>ร่างและรอชำระเงิน</h2><div class="stack">${drafts.map((d) => `<article class="card" data-testid="my-draft-row" data-draft-id="${e(d.draft_id)}" data-status="${e(d.status)}"><strong data-testid="row-draft-id">${e(d.draft_id)}</strong><p data-testid="row-service">${e(d.name)}</p><p data-testid="row-status">${STATUS[d.status]}</p><a data-testid="open-draft-btn" href="/citizen/new/${e(d.service_id)}?draft=${e(d.draft_id)}">เปิดร่าง</a> <button type="button" data-testid="delete-draft-btn" data-delete-draft="${e(d.draft_id)}">ลบร่าง</button></article>`).join('')}</div><script>document.querySelectorAll('[data-delete-draft]').forEach(function(b){b.onclick=async function(){var r=await fetch('/api/drafts/'+b.dataset.deleteDraft,{method:'DELETE'});if(r.ok)location.reload();else{var d=await r.json();var a=document.querySelector('[data-testid="action-error"]');a.hidden=false;a.textContent=d.message;}}});</script>` });
  });

  app.get('/citizen/new/:service', (req, res) => {
    const s = service(req.params.service);
    if (!s) return view.notFound(req, res);
    let d = null;
    if (req.query.draft) {
      d = db.get('SELECT * FROM drafts WHERE draft_id=? AND username=? AND service_id=?', String(req.query.draft), req.user.username, s.id);
      if (!d) return view.notFound(req, res);
    }
    const feeTable = {};
    for (let n = 0; n <= (s.id === 'SV-03' ? 501 : 6); n++) feeTable[n] = rules.calcFee(s, { qty: n, areaSqm: n });
    const data = { service: s, docs: docs(s.id), draft: d ? draftJson(d) : null, files: d ? files(d.draft_id).map(fileJson) : [], feeTable };
    const p = d && db.get('SELECT ref FROM payments WHERE draft_id=? ORDER BY rowid DESC LIMIT 1', d.draft_id);
    data.paymentRef = p ? p.ref : null;
    const qty = d ? d.qty : 1;
    const initialFee = rules.calcFee(s, { qty, areaSqm: d ? d.area_sqm : '' });
    view.page(req, res, { title: s.name, body: `<h1 data-testid="service-name">${e(s.name)}</h1><p data-testid="wizard-step" id="wizard-step">1/3 กรอกข้อมูล</p><section id="citizen-info" class="card" aria-label="กรอกข้อมูล"><h2>ข้อมูลคำขอ</h2>${s.id === 'SV-01' ? `<label for="qty-input">จำนวนฉบับ</label><input type="number" step="1" id="qty-input" data-testid="qty-input" value="${e(qty)}">` : s.id === 'SV-03' ? `<label for="area-input">พื้นที่ (ตร.ม.)</label><input type="number" step="1" id="area-input" data-testid="area-input" value="${e(d ? d.area_sqm : '')}">` : '<p>ค่าธรรมเนียมเหมาจ่าย</p>'}<p>ค่าธรรมเนียม <strong data-testid="fee-total" id="fee-total">${initialFee.ok ? rules.fmtBaht(initialFee.fee) : '–'}</strong></p><div id="fee-error-slot" aria-live="polite"></div><div id="draft-id-slot">${d ? `<p data-testid="draft-id">${e(d.draft_id)}</p>` : ''}</div><div class="actions"><button type="button" data-testid="save-draft-btn" id="save-draft-btn">บันทึกร่าง</button><button type="button" data-testid="to-upload-btn" id="to-upload-btn"${initialFee.ok ? '' : ' disabled'}>แนบเอกสาร</button></div></section><section id="citizen-upload" class="card" aria-label="แนบเอกสาร" hidden><h2>เอกสารประกอบ</h2><p>PDF, JPG, PNG ไม่เกิน 5 MB ต่อไฟล์ รวมไม่เกิน 5 ไฟล์</p>${docs(s.id).map((doc) => `<div class="field"><label for="upload-${e(doc.doc_key)}">${e(doc.label)}${doc.required ? ' (บังคับ)' : ''}${doc.pdf_only ? ' (PDF เท่านั้น)' : ''}</label><input type="file" id="upload-${e(doc.doc_key)}" data-testid="upload-input-${e(doc.doc_key)}" data-doc-key="${e(doc.doc_key)}"></div>`).join('')}<label for="upload-extra">เอกสารเพิ่มเติม</label><input type="file" id="upload-extra" data-testid="upload-input-extra" data-doc-key="extra" multiple><div id="upload-error-slot" role="alert"></div><ul id="citizen-files"></ul><div id="missing-docs-slot" aria-live="polite"></div><button type="button" id="back-info">แก้ไขข้อมูล</button> <button type="button" data-testid="to-payment-btn" id="to-payment-btn" disabled>ไปชำระเงิน</button></section><section id="citizen-payment" class="card" aria-label="ชำระเงิน" hidden><h2>ชำระเงินจำลอง</h2><p>ยอดที่ต้องชำระ <strong data-testid="payment-amount" id="payment-amount"></strong></p><div id="payment-body"></div></section><script>(${wizardClient.toString()})(${json(data)});</script>` });
  });

  app.get('/citizen/cases/:caseNo', (req, res) => {
    const c = db.get('SELECT * FROM cases WHERE case_no=?', req.params.caseNo);
    if (!auth.canViewCase(req.user, c, 'case')) return view.notFound(req, res);
    const s = service(c.service_id);
    const u = db.get('SELECT * FROM users WHERE username=?', c.applicant);
    const timeline = db.all('SELECT * FROM case_timeline WHERE case_no=? ORDER BY time,id', c.case_no);
    const attached = db.all('SELECT * FROM files WHERE case_no=? ORDER BY created_at,file_id', c.case_no);
    const returned = db.get('SELECT * FROM case_returns WHERE case_no=? ORDER BY n DESC LIMIT 1', c.case_no);
    const doc = c.doc_no && db.get('SELECT * FROM documents WHERE doc_no=?', c.doc_no);
    const idNo = ctx.security.decrypt(u.id_enc);
    const formattedId = idNo.replace(/^(\d)(\d{4})(\d{5})(\d{2})(\d)$/, '$1-$2-$3-$4-$5');
    const step = c.service_id === 'SV-03' ? `<p data-testid="case-step">ขั้นตอน ${c.step || 1}/3 · ${['', 'ฝ่ายทะเบียน', 'ฝ่ายโยธา', 'หัวหน้าฝ่าย'][c.step || 1]}</p>` : '';
    const canFix = c.status === 'NEED_FIX' && clock.nowIso() <= c.fix_deadline;
    view.page(req, res, { title: c.case_no, body: `<h1 data-testid="case-no">${e(c.case_no)}</h1><p data-testid="case-service">${e(c.service_id)} ${e(s.name)}</p><p data-testid="case-status" data-status="${e(c.status)}">${STATUS[c.status]}</p>${step}<p>เลขบัตรประชาชน <span data-testid="case-id-full">${e(formattedId)}</span></p><p>ค่าธรรมเนียม <strong data-testid="case-fee">${rules.fmtBaht(c.fee)}</strong></p><p>กำหนดเสร็จ ${view.dt(c.due_at, 'data-testid="sla-due"')}</p><p data-testid="sla-level" data-level="${level(c)}">${rules.slaLevelTh(level(c))}</p>${c.closed_at ? `<p>ปิดงาน ${view.dt(c.closed_at, 'data-testid="closed-at"')}</p>` : ''}${['REJECTED', 'CANCELLED'].includes(c.status) ? `<p data-testid="no-refund-note">${NO_REFUND}</p>` : ''}${c.reject_reason ? `<p>${e(c.reject_reason)}</p>` : ''}${c.status === 'SUBMITTED' && !c.owner ? `<button type="button" data-testid="cancel-case-btn" id="cancel-case-btn">ยกเลิกคำขอ</button><div id="cancel-confirm" hidden><p data-testid="cancel-confirm-text">${NO_REFUND}</p><button type="button" data-testid="confirm-cancel-btn" id="confirm-cancel-btn">ยืนยันยกเลิก</button><button type="button" id="keep-case-btn">กลับ</button></div>` : ''}${c.status === 'NEED_FIX' ? `<section class="card"><h2>แก้ไขเอกสาร</h2><p data-testid="return-reason-display">${e(returned ? returned.reason : '')}</p><p>แก้ไขภายใน ${view.dt(c.fix_deadline, 'data-testid="fix-deadline"')}</p>${canFix ? `<label for="fix-upload-input">แนบไฟล์ใหม่ (ไม่บังคับ)</label><input type="file" data-testid="fix-upload-input" id="fix-upload-input"><button type="button" data-testid="submit-fix-btn" id="submit-fix-btn">ส่งแก้ไข</button>` : ''}</section>` : ''}<section><h2>เอกสารแนบ</h2><ul>${attached.map((f) => `<li data-testid="doc-item" data-name="${e(f.name)}" data-file-id="${e(f.file_id)}"><a data-testid="doc-download-link" href="/api/files/${e(f.file_id)}">${e(f.name)}</a></li>`).join('')}</ul></section>${doc ? `<section class="card"><h2>เอกสารดิจิทัล</h2><p data-testid="doc-no">${e(c.doc_no)}</p><p data-testid="verify-code">${e(c.verify_code)}</p><img width="160" height="160" alt="QR ตรวจสอบเอกสาร" data-testid="doc-qr" data-url="${e(req.protocol + '://' + req.get('host') + '/verify/' + c.verify_code)}" src="/citizen/document-qr/${e(c.verify_code)}"><a data-testid="download-doc-btn" href="/api/documents/${e(c.doc_no)}/pdf">ดาวน์โหลดเอกสาร</a></section>` : ''}<h2>ประวัติคำขอ</h2><ol data-testid="case-timeline">${timeline.map((t) => `<li data-testid="timeline-item" data-iso="${e(t.time)}">${view.dt(t.time)} · ${e(STATUS[t.to_status] || t.event)}${t.detail ? ' · ' + e(t.detail) : ''}</li>`).join('')}</ol><script>(${caseClient.toString()})(${json(c.case_no)});</script>` });
  });
  app.get('/citizen/payment-qr/:ref', http.wrap(async (req, res) => {
    const p = db.get('SELECT p.* FROM payments p JOIN drafts d ON d.draft_id=p.draft_id WHERE p.ref=? AND d.username=?', req.params.ref, req.user.username);
    if (!p) return view.notFound(req, res);
    res.type('png').send(await require('qrcode').toBuffer('SIMULATED-PROMPTPAY|' + p.ref + '|' + p.amount));
  }));
  app.get('/citizen/document-qr/:code', http.wrap(async (req, res) => {
    const c = db.get('SELECT * FROM cases WHERE verify_code=? AND applicant=?', req.params.code, req.user.username);
    if (!c) return view.notFound(req, res);
    res.type('png').send(await require('qrcode').toBuffer(req.protocol + '://' + req.get('host') + '/verify/' + c.verify_code));
  }));
}

/** Browser code is embedded from this function, so this block writes no other module's files. */
function wizardClient(data) {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => '฿' + Number(n).toLocaleString('en-US');
  const fmt = (iso) => { if (!iso) return ''; const v = iso.slice(0, 16).split(/[-T:]/).map(Number); return v[2] + ' ' + ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'][v[1] - 1] + ' ' + (v[0] + 543) + ' ' + String(v[3]).padStart(2, '0') + ':' + String(v[4]).padStart(2, '0'); };
  let draftId = data.draft && data.draft.draftId;
  let attached = data.files;
  let payRef = data.paymentRef;
  let feeResult;
  let saving = null;
  let uploading = false;
  const input = $('qty-input') || $('area-input');
  const actionError = (text) => { const a = document.querySelector('[data-testid="action-error"]'); a.textContent = text; a.hidden = !text; };
  async function request(method, url, body) {
    const opt = { method, credentials: 'same-origin', headers: {} };
    if (body instanceof FormData) opt.body = body;
    else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
    const r = await fetch(url, opt);
    const d = r.status === 204 ? {} : await r.json();
    if (!r.ok) throw d;
    return d;
  }
  function fee() {
    const n = input ? Number(input.value) : 1;
    const valid = input ? input.value.trim() !== '' && Number.isInteger(n) : true;
    feeResult = valid ? data.feeTable[n] : null;
    if (!feeResult) feeResult = { ok: false, message: data.service.id === 'SV-01' ? 'จำนวนฉบับต้อง 1–5 ฉบับ' : n > 500 ? 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน' : 'กรุณาระบุพื้นที่ 1–500 ตร.ม.' };
    $('fee-total').textContent = feeResult.ok ? money(feeResult.fee) : '–';
    $('fee-error-slot').innerHTML = feeResult.ok ? '' : '<p role="alert" data-testid="fee-error">' + esc(feeResult.message) + '</p>';
    $('to-upload-btn').disabled = !feeResult.ok;
    $('save-draft-btn').disabled = !feeResult.ok;
  }
  if (input) input.addEventListener('input', fee);
  fee();
  function setStep(step) {
    ['citizen-info', 'citizen-upload', 'citizen-payment'].forEach((id, i) => { $(id).hidden = step !== i + 1; });
    $('wizard-step').textContent = ['', '1/3 กรอกข้อมูล', '2/3 แนบเอกสาร', '3/3 ชำระเงิน'][step];
    if (step === 3) $('payment-amount').textContent = money(data.draft ? data.draft.fee : feeResult.fee);
  }
  async function save() {
    if (!feeResult.ok) throw feeResult;
    if (saving) return saving;
    saving = (async () => {
      const body = { serviceId: data.service.id };
      if (data.service.id === 'SV-01') body.qty = Number(input.value);
      if (data.service.id === 'SV-03') body.areaSqm = Number(input.value);
      let d;
      if (draftId && data.draft && data.draft.status !== 'DRAFT') return data.draft;
      if (draftId) d = await request('PUT', '/api/drafts/' + draftId, body);
      else d = await request('POST', '/api/drafts', body);
      draftId = d.draftId;
      data.draft = { ...body, ...d, status: 'DRAFT' };
      $('draft-id-slot').innerHTML = '<p data-testid="draft-id">' + esc(draftId) + '</p>';
      history.replaceState(null, '', '/citizen/new/' + data.service.id + '?draft=' + draftId);
      return d;
    })();
    try { return await saving; } finally { saving = null; }
  }
  function renderFiles() {
    $('citizen-files').innerHTML = attached.map((f) => '<li data-testid="file-item" data-name="' + esc(f.name) + '" data-doc-key="' + esc(f.docKey) + '">' + esc(f.name) + ' <button type="button" data-testid="file-remove-btn" data-file="' + esc(f.fileId) + '" aria-label="ลบไฟล์ ' + esc(f.name) + '">ลบไฟล์</button></li>').join('');
    document.querySelectorAll('[data-file]').forEach((b) => { b.onclick = async () => { try { await request('DELETE', '/api/drafts/' + draftId + '/files/' + b.dataset.file); attached = attached.filter((f) => f.fileId !== b.dataset.file); renderFiles(); } catch (err) { uploadError(err.message); } }; });
    const missing = data.docs.filter((d) => d.required && !attached.some((f) => f.docKey === d.doc_key)).map((d) => d.label);
    $('missing-docs-slot').innerHTML = missing.length ? '<p data-testid="missing-docs">ยังขาดเอกสาร: ' + missing.map(esc).join(', ') + '</p>' : '';
    $('to-payment-btn').disabled = missing.length > 0 || uploading;
  }
  function uploadError(msg) { $('upload-error-slot').innerHTML = msg ? '<p data-testid="upload-error">' + esc(msg) + '</p>' : ''; }
  document.querySelectorAll('[data-doc-key][type="file"]').forEach((el) => {
    el.onchange = async () => {
      uploadError(''); uploading = true; renderFiles();
      try {
        if (!draftId) await save(); // ผู้ใช้/สคริปต์เลือกไฟล์ทันทีหลังกด "ถัดไป" ขณะร่างยังสร้างไม่เสร็จ
        for (const f of Array.from(el.files)) {
          const form = new FormData(); form.append('docKey', el.dataset.docKey); form.append('file', f);
          try { const saved = await request('POST', '/api/drafts/' + draftId + '/files', form); attached.push(saved); } catch (err) { uploadError(err.message); }
        }
      } catch (err) { uploadError(err.message); }
      finally { uploading = false; el.value = ''; renderFiles(); }
    };
  });
  $('save-draft-btn').onclick = async () => { try { await save(); actionError(''); } catch (err) { actionError(err.message); } };
  $('to-upload-btn').onclick = async () => { try { await save(); renderFiles(); setStep(2); } catch (err) { actionError(err.message); } };
  $('back-info').onclick = () => setStep(1);
  $('to-payment-btn').onclick = () => { setStep(3); renderPayment(null); if (payRef) refresh(); };
  function renderPayment(p) {
    let html = '';
    if (p) {
      html += '<p data-testid="payment-status" data-status="' + esc(p.status) + '">' + ({ PENDING: 'รอชำระ', PAID: 'ชำระแล้ว', EXPIRED: 'QR หมดอายุ' }[p.status]) + '</p>';
      html += '<p data-testid="qr-ref">' + esc(p.ref) + '</p><time data-testid="qr-expires" data-iso="' + esc(p.qrExpiresAt) + '">หมดอายุ ' + fmt(p.qrExpiresAt) + '</time>';
      if (p.status === 'PAID') html += '<p data-testid="submitted-case-no">' + esc(p.caseNo) + '</p><p data-testid="receipt-no">' + esc(p.receiptNo) + '</p><p data-testid="receipt-amount">' + money(p.amount) + '</p><time data-testid="receipt-paid-at" data-iso="' + esc(p.paidAt) + '">' + fmt(p.paidAt) + '</time><p><a data-testid="go-case-btn" href="/citizen/cases/' + esc(p.caseNo) + '">ดูคำขอ</a></p>';
      else if (p.status === 'EXPIRED') html += '<p data-testid="qr-expired-msg">QR หมดอายุ กรุณาสร้าง QR ใหม่</p><button type="button" data-testid="regenerate-qr-btn" id="create-qr">สร้าง QR ใหม่</button>';
      else html += '<img data-testid="qr-image" alt="QR ชำระเงินจำลอง" width="160" height="160" src="/citizen/payment-qr/' + encodeURIComponent(p.ref) + '">';
      html += '<button type="button" data-testid="refresh-payment-btn" id="refresh-payment">ตรวจสอบการชำระเงิน</button>';
    } else html = '<button type="button" data-testid="create-qr-btn" id="create-qr">สร้าง QR</button>';
    $('payment-body').innerHTML = html;
    if ($('create-qr')) $('create-qr').onclick = createQr;
    if ($('refresh-payment')) $('refresh-payment').onclick = refresh;
  }
  async function refresh() {
    try { const p = await request('GET', '/api/payments/' + payRef); renderPayment(p); } catch (err) { actionError(err.message); }
  }
  async function createQr() {
    try { const p = await request('POST', '/api/drafts/' + draftId + '/payment'); payRef = p.ref; await refresh(); } catch (err) { actionError(err.message); }
  }
  if (data.draft && ['PENDING_PAYMENT', 'PAID'].includes(data.draft.status)) { setStep(3); renderPayment(null); if (payRef) refresh(); }
  renderFiles();
}

function caseClient(caseNo) {
  const $ = (id) => document.getElementById(id);
  const showError = (message) => { const a = document.querySelector('[data-testid="action-error"]'); a.hidden = false; a.textContent = message; };
  if ($('cancel-case-btn')) {
    $('cancel-case-btn').onclick = () => { $('cancel-confirm').hidden = false; $('confirm-cancel-btn').focus(); };
    $('keep-case-btn').onclick = () => { $('cancel-confirm').hidden = true; $('cancel-case-btn').focus(); };
    $('confirm-cancel-btn').onclick = async () => {
      const r = await fetch('/api/cases/' + caseNo + '/cancel', { method: 'POST' });
      if (r.ok) location.reload(); else showError((await r.json()).message);
    };
  }
  if ($('submit-fix-btn')) $('submit-fix-btn').onclick = async () => {
    const form = new FormData();
    const file = $('fix-upload-input').files[0];
    if (file) { form.append('file', file); form.append('docKey', 'id-card'); }
    const r = await fetch('/api/cases/' + caseNo + '/resubmit', { method: 'POST', body: form });
    if (r.ok) location.reload(); else showError((await r.json()).message);
  };
}

module.exports = { register, actualType };
