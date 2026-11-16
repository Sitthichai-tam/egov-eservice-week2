'use strict';
/**
 * B02 · ยืนยันตัวตน + ลงทะเบียน + RBAC
 *  - FR-01 ประชาชนล็อกอินด้วยเลขบัตร 13 หลัก (checksum) + OTP จำลอง `123456` · ผิดติดกัน 3 ครั้ง → ล็อกเลขบัตรนั้น 15 นาที (BR-02)
 *  - FR-02 ลงทะเบียนครั้งแรก: ชื่อจาก ThaiD (แก้ไม่ได้) · เบอร์ 10 หลักขึ้นต้น 0 · อีเมลไม่บังคับ · ยินยอม PDPA (BR-03)
 *  - FR-03 เจ้าหน้าที่/หัวหน้า/ผู้บริหาร/ผู้ตรวจสอบ/ผู้ดูแล: username + รหัสผ่าน · บันทึก Audit `STAFF_LOGIN` (A-36)
 *  - RBAC: ด่านกลาง (middleware) ตามคำนำหน้า path ของหน้า/API (A-39 · CONTRACT §1 · TEST-PLAN TC-RBAC-03)
 *      ยังไม่ล็อกอิน → หน้า redirect /login · API 401 | บทบาทไม่ตรง → หน้า 403 `forbidden-msg` · API 403 FORBIDDEN
 *    ด่านเฉพาะรายการ (เจ้าของคำขอ แผนก ผู้ถือเรื่อง) เป็นหน้าที่ของโมดูลเจ้าของ route นั้น
 *
 * API (CONTRACT §6.1): POST /api/auth/thaid/start · /thaid/verify · /register · /staff/login · /logout · GET /api/me
 * หน้า: GET /login · GET /register
 *
 * BUG_MODE ส่วนสิทธิ์ที่โมดูลอื่นเรียกใช้ผ่านฟังก์ชันที่ export จากไฟล์นี้ (ตัวเลือก ไม่บังคับ):
 *   B06  canViewCase(user, caseRow)   → เปิดบั๊ก = ประชาชนคนไหนก็เปิดคำขอคนอื่นได้ (IDOR)
 *   B09  officerIdFields(idNo)        → เปิดบั๊ก = response ของเจ้าหน้าที่มี `idNo` เลขเต็ม
 */
const bug = require('./bugs');
const security = require('./security');
const clock = require('./clock');
const view = require('./view');
const { db } = require('./db');
const audit = require('./audit');
const http = require('./http');
const config = require('./config');

const LOCK_FAILS = 3;
const LOCK_MINUTES = 15;

const MSG = {
  INVALID_ID: 'เลขบัตรประชาชนไม่ถูกต้อง',
  OTP_INVALID: 'รหัส OTP ไม่ถูกต้อง',
  LOCKED: 'ผิดเกินกำหนด เลขบัตรนี้ถูกล็อก 15 นาที',
  INVALID_CREDENTIALS: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
  INVALID_MOBILE: 'เบอร์มือถือต้องเป็นตัวเลข 10 หลักขึ้นต้นด้วย 0',
  CONSENT_REQUIRED: 'กรุณายินยอมการประมวลผลข้อมูลส่วนบุคคล (PDPA)',
  UNAUTHENTICATED: 'กรุณาเข้าสู่ระบบ',
};

const { apiError, wrap } = http;

/* ---------------------------------------------------------------- helpers สำหรับโมดูลอื่น */

/** B06: ประชาชนเปิดได้เฉพาะคำขอของตัวเอง · caseRow = แถวตาราง cases (หรือ object ที่มี applicant) */
function canViewCase(user, caseRow, scope) {
  if (!user || !caseRow) return false;
  if (user.role !== 'citizen') return true; // officer/head ฯลฯ ถูกจำกัดโดยด่านของโมดูลนั้น
  // BUG B06: IDOR เฉพาะหน้า /citizen/cases/:no และ GET /api/cases/:no (scope === 'case') ตาม BUGS.md ข้อ 1
  // จุดอื่นที่ใช้ฟังก์ชันนี้ (PDF เอกสาร · ไฟล์แนบ) ต้องตรวจเจ้าของเสมอแม้เปิดบั๊ก
  if (scope === 'case' && bug('B06')) return true;
  return caseRow.applicant === user.username;
}

/** B09: ฟิลด์เลขบัตรที่ response ฝั่งเจ้าหน้าที่ใส่ได้ · ปกติมีแต่ idMasked */
function officerIdFields(idNo) {
  const out = { idMasked: security.maskId(idNo) };
  if (bug('B09')) out.idNo = String(idNo); // BUG B09: ส่งเลขเต็มใน API คิว
  return out;
}

/* ---------------------------------------------------------------- ThaiD จำลอง */

const findCitizenByIdNo = (idNo) =>
  db.get(`SELECT * FROM users WHERE role = 'citizen' AND id_hash = ?`, security.idHash(idNo));

/** คืน {locked:true, until} ถ้ายังล็อก · ถ้าพ้นเวลาแล้วรีเซ็ตตัวนับเป็น 0 */
function lockState(idHash) {
  const row = db.get('SELECT * FROM otp_attempts WHERE id_hash = ?', idHash);
  if (!row || !row.locked_until) return { locked: false, fails: row ? row.fails : 0 };
  if (clock.nowIso() < row.locked_until) return { locked: true, until: row.locked_until };
  db.run('UPDATE otp_attempts SET fails = 0, locked_until = NULL WHERE id_hash = ?', idHash);
  return { locked: false, fails: 0 };
}

const lockedReply = (res, until) =>
  apiError(res, 423, 'LOCKED', MSG.LOCKED, { lockedUntil: until });

/** ตรวจเลขบัตร → แถวผู้ใช้ หรือ null (ส่ง 400 INVALID_ID ให้เอง) */
function citizenFromBody(req, res) {
  const idNo = req.body && req.body.idNo;
  if (!security.validIdNo(idNo)) { apiError(res, 400, 'INVALID_ID', MSG.INVALID_ID); return null; }
  const user = findCitizenByIdNo(idNo);
  // ThaiD จำลองไม่รู้จักเลขนี้ → ข้อความเดียวกับเลขผิด (A-45 ข้อความผิดเดียว ไม่เผยว่ามี/ไม่มีในระบบ)
  if (!user) { apiError(res, 400, 'INVALID_ID', MSG.INVALID_ID); return null; }
  return user;
}

function thaidStart(req, res) {
  const user = citizenFromBody(req, res);
  if (!user) return undefined;
  const st = lockState(user.id_hash);
  if (st.locked) return lockedReply(res, st.until);
  return res.json({ status: 'OTP_SENT' });
}

function thaidVerify(req, res) {
  const user = citizenFromBody(req, res);
  if (!user) return undefined;
  const st = lockState(user.id_hash);
  if (st.locked) return lockedReply(res, st.until); // ล็อกอยู่ แม้ OTP ถูกก็ยัง 423

  const otp = req.body.otp;
  if (typeof otp !== 'string' && typeof otp !== 'number') return otpFail(res, user.id_hash, st.fails);
  if (String(otp) !== config.OTP) return otpFail(res, user.id_hash, st.fails);

  // OTP ถูก: รีเซ็ตตัวนับ
  db.run('DELETE FROM otp_attempts WHERE id_hash = ?', user.id_hash);
  if (req.user) http.destroySession(req, res);
  const registered = user.registered === 1;
  http.createSession(res, user, registered ? 'full' : 'register');
  return res.json({ registered });
}

function otpFail(res, idHash, prevFails) {
  const fails = prevFails + 1;
  if (fails >= LOCK_FAILS) {
    const until = clock.toIso(clock.now() + LOCK_MINUTES * 60000);
    db.run(
      `INSERT INTO otp_attempts(id_hash, fails, locked_until) VALUES(?,?,?)
       ON CONFLICT(id_hash) DO UPDATE SET fails = excluded.fails, locked_until = excluded.locked_until`,
      idHash, fails, until
    );
    return lockedReply(res, until);
  }
  db.run(
    `INSERT INTO otp_attempts(id_hash, fails, locked_until) VALUES(?,?,NULL)
     ON CONFLICT(id_hash) DO UPDATE SET fails = excluded.fails, locked_until = NULL`,
    idHash, fails
  );
  return apiError(res, 401, 'OTP_INVALID', MSG.OTP_INVALID, { attemptsLeft: LOCK_FAILS - fails });
}

/* ---------------------------------------------------------------- ลงทะเบียน */

const MOBILE_RE = /^0\d{9}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function register(req, res) {
  if (!req.user) return apiError(res, 401, 'UNAUTHENTICATED', MSG.UNAUTHENTICATED);
  const row = db.get(`SELECT * FROM users WHERE username = ? AND role = 'citizen'`, req.user.username);
  if (!row) return apiError(res, 403, 'FORBIDDEN', 'ไม่มีสิทธิ์ทำรายการนี้');
  if (row.registered === 1) return apiError(res, 409, 'ALREADY_REGISTERED', 'ลงทะเบียนแล้ว');

  const body = req.body || {};
  const mobile = typeof body.mobile === 'string' ? body.mobile.trim() : '';
  if (!MOBILE_RE.test(mobile)) return apiError(res, 400, 'INVALID_MOBILE', MSG.INVALID_MOBILE);
  if (body.consent !== true) return apiError(res, 400, 'CONSENT_REQUIRED', MSG.CONSENT_REQUIRED);
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (email && (email.length > 254 || !EMAIL_RE.test(email))) {
    return apiError(res, 400, 'INVALID_EMAIL', 'รูปแบบอีเมลไม่ถูกต้อง');
  }

  db.run(
    'UPDATE users SET mobile_enc = ?, email = ?, registered = 1, consent_at = ? WHERE username = ?',
    security.encrypt(mobile), email, clock.nowIso(), row.username
  );
  // เปลี่ยนจาก session เฉพาะ /register เป็น session เต็ม → เข้า /citizen ได้ทันที
  http.destroySession(req, res);
  http.createSession(res, { ...row, registered: 1 }, 'full');
  return res.status(201).json({ registered: true, landing: view.LANDING.citizen });
}

/* ---------------------------------------------------------------- เจ้าหน้าที่ */

let dummyHash = null;

function staffLogin(req, res) {
  const body = req.body || {};
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const user = username
    ? db.get(`SELECT * FROM users WHERE username = ? AND role <> 'citizen'`, username)
    : null;
  let ok;
  if (user && user.pw_hash) {
    ok = security.verifyPassword(password, user.pw_hash);
  } else {
    if (!dummyHash) dummyHash = security.hashPassword('x');
    security.verifyPassword(password, dummyHash); // ใช้เวลาใกล้เคียงกัน ไม่เผยว่ามี username นี้
    ok = false;
  }
  if (!ok) return apiError(res, 401, 'INVALID_CREDENTIALS', MSG.INVALID_CREDENTIALS);

  if (req.user) http.destroySession(req, res);
  http.createSession(res, user, 'full');
  audit.log({ username: user.username, role: user.role }, { event: 'STAFF_LOGIN', detail: '' });
  return res.json({ role: user.role, dept: user.dept || '', landing: view.LANDING[user.role] });
}

/* ---------------------------------------------------------------- หน้าเว็บ */

const esc = view.esc;

function loginPage(req, res) {
  const body = `
<h1>เข้าสู่ระบบ</h1>
<div role="tablist" aria-label="ประเภทผู้ใช้" class="tabs">
  <button type="button" role="tab" id="tab-citizen" aria-controls="panel-citizen" aria-selected="true" data-testid="login-tab-citizen">ประชาชน</button>
  <button type="button" role="tab" id="tab-staff" aria-controls="panel-staff" aria-selected="false" tabindex="-1" data-testid="login-tab-staff">เจ้าหน้าที่</button>
</div>

<section role="tabpanel" id="panel-citizen" aria-labelledby="tab-citizen" class="card">
  <h2>ประชาชน</h2>
  <form id="thaid-form" novalidate>
    <div class="field">
      <label for="thaid-id">เลขบัตรประชาชน 13 หลัก</label>
      <input id="thaid-id" name="idNo" type="text" inputmode="numeric" autocomplete="off" data-testid="thaid-id-input">
    </div>
    <div id="thaid-msg"></div>
    <button type="submit" data-testid="thaid-submit">เข้าสู่ระบบด้วย ThaiD (จำลอง)</button>
  </form>
  <div id="otp-slot"></div>
</section>

<section role="tabpanel" id="panel-staff" aria-labelledby="tab-staff" class="card" hidden>
  <h2>เจ้าหน้าที่</h2>
  <form id="staff-form" novalidate>
    <div class="field">
      <label for="staff-user">ชื่อผู้ใช้</label>
      <input id="staff-user" name="username" type="text" autocomplete="username" data-testid="staff-username">
    </div>
    <div class="field">
      <label for="staff-pass">รหัสผ่าน</label>
      <input id="staff-pass" name="password" type="password" autocomplete="current-password" data-testid="staff-password">
    </div>
    <div id="staff-msg"></div>
    <button type="submit" data-testid="staff-submit">เข้าสู่ระบบเจ้าหน้าที่ (SSO ภาครัฐ จำลอง)</button>
  </form>
</section>

<script>
(function () {
  var MSG = ${JSON.stringify(MSG)};
  var MONTHS = ${JSON.stringify(view.MONTHS)};
  function $(id) { return document.getElementById(id); }
  function escH(s) { return String(s).replace(/[&<>"']/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function fmt(iso) {
    var m = /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})/.exec(iso);
    return m ? (+m[3]) + ' ' + MONTHS[+m[2] - 1] + ' ' + (+m[1] + 543) + ' ' + m[4] + ':' + m[5] : iso;
  }
  async function post(url, body) {
    var r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    var data = null; try { data = await r.json(); } catch (e) {}
    return { status: r.status, data: data || {} };
  }

  // แท็บ
  var tabs = [['tab-citizen', 'panel-citizen'], ['tab-staff', 'panel-staff']];
  function select(i) {
    tabs.forEach(function (t, j) {
      $(t[0]).setAttribute('aria-selected', j === i ? 'true' : 'false');
      $(t[0]).tabIndex = j === i ? 0 : -1;
      $(t[1]).hidden = j !== i;
    });
  }
  tabs.forEach(function (t, i) {
    $(t[0]).addEventListener('click', function () { select(i); });
    $(t[0]).addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { var n = 1 - i; select(n); $(tabs[n][0]).focus(); }
    });
  });

  // ประชาชน: ขั้นเลขบัตร
  var idNoSent = '';
  function thaidMsg(html) { $('thaid-msg').innerHTML = html; }
  function lockHtml(until) {
    return '<p role="alert" class="msg msg-error" data-testid="lock-message">' + escH(MSG.LOCKED) + '</p>' +
      '<p>ปลดล็อกเมื่อ <time data-testid="lock-until" data-iso="' + escH(until) + '">' + escH(fmt(until)) + '</time></p>';
  }
  $('thaid-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var idNo = $('thaid-id').value.trim();
    thaidMsg(''); $('otp-slot').innerHTML = '';
    var r = await post('/api/auth/thaid/start', { idNo: idNo });
    if (r.status === 200) { idNoSent = idNo; showOtp(); return; }
    if (r.status === 423) { thaidMsg(lockHtml(r.data.lockedUntil)); return; }
    thaidMsg('<p role="alert" class="msg msg-error" data-testid="thaid-error">' + escH(r.data.message || MSG.INVALID_ID) + '</p>');
  });

  function showOtp() {
    $('otp-slot').innerHTML =
      '<form id="otp-form" novalidate data-testid="otp-step">' +
      '<div class="field"><label for="otp-field">รหัส OTP</label>' +
      '<input id="otp-field" name="otp" type="text" inputmode="numeric" autocomplete="one-time-code" data-testid="otp-input"></div>' +
      '<div id="otp-msg"></div>' +
      '<button type="submit" data-testid="otp-submit">ยืนยัน OTP</button></form>';
    $('otp-field').focus();
    $('otp-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      $('otp-msg').innerHTML = '';
      var r = await post('/api/auth/thaid/verify', { idNo: idNoSent, otp: $('otp-field').value.trim() });
      if (r.status === 200) { location.href = r.data.registered ? '/citizen' : '/register'; return; }
      if (r.status === 401) {
        $('otp-msg').innerHTML = '<p role="alert" class="msg msg-error" data-testid="otp-error">' + escH(MSG.OTP_INVALID) + '</p>' +
          '<p data-testid="otp-attempts-left">เหลือ ' + escH(r.data.attemptsLeft) + ' ครั้ง</p>';
        return;
      }
      if (r.status === 423) { $('otp-msg').innerHTML = lockHtml(r.data.lockedUntil); return; }
      $('otp-msg').innerHTML = '<p role="alert" class="msg msg-error" data-testid="thaid-error">' + escH(r.data.message || MSG.INVALID_ID) + '</p>';
    });
  }

  // เจ้าหน้าที่
  $('staff-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    $('staff-msg').innerHTML = '';
    var r = await post('/api/auth/staff/login', { username: $('staff-user').value, password: $('staff-pass').value });
    if (r.status === 200) { location.href = r.data.landing; return; }
    $('staff-msg').innerHTML = '<p role="alert" class="msg msg-error" data-testid="staff-error">' + escH(r.data.message || MSG.INVALID_CREDENTIALS) + '</p>';
  });
})();
</script>`;
  view.page(req, res, { title: 'เข้าสู่ระบบ', body });
}

function registerPage(req, res) {
  if (!req.user) return res.redirect('/login');
  if (req.user.kind === 'full') return res.redirect(view.LANDING[req.user.role] || '/login');
  const body = `
<h1>ลงทะเบียนใช้งานครั้งแรก</h1>
<section class="card">
  <form id="reg-form" novalidate>
    <div class="field">
      <label for="reg-name">ชื่อ-สกุล (จาก ThaiD)</label>
      <input id="reg-name" name="name" type="text" value="${esc(req.user.name)}" readonly data-testid="reg-name">
    </div>
    <div class="field">
      <label for="reg-mobile">เบอร์มือถือ (บังคับ)</label>
      <input id="reg-mobile" name="mobile" type="tel" inputmode="numeric" autocomplete="tel" data-testid="reg-mobile">
      <div id="reg-mobile-msg"></div>
    </div>
    <div class="field">
      <label for="reg-email">อีเมล (ไม่บังคับ)</label>
      <input id="reg-email" name="email" type="email" autocomplete="email" data-testid="reg-email">
      <div id="reg-email-msg"></div>
    </div>
    <div class="field">
      <input id="reg-consent" name="consent" type="checkbox" data-testid="reg-consent">
      <label for="reg-consent">ข้าพเจ้ายินยอมให้เทศบาลนครตัวอย่างเก็บและประมวลผลข้อมูลส่วนบุคคลเพื่อให้บริการ e-Service ตามพระราชบัญญัติคุ้มครองข้อมูลส่วนบุคคล (PDPA)</label>
      <div id="reg-consent-msg"></div>
    </div>
    <button type="submit" data-testid="reg-submit">ลงทะเบียน</button>
  </form>
</section>
<script>
(function () {
  function $(id) { return document.getElementById(id); }
  function escH(s) { return String(s).replace(/[&<>"']/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function err(slot, testid, text) {
    $(slot).innerHTML = '<p role="alert" class="msg msg-error" data-testid="' + testid + '">' + escH(text) + '</p>';
  }
  $('reg-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    ['reg-mobile-msg', 'reg-email-msg', 'reg-consent-msg'].forEach(function (id) { $(id).innerHTML = ''; });
    var r = await fetch('/api/auth/register', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile: $('reg-mobile').value.trim(), email: $('reg-email').value.trim(), consent: $('reg-consent').checked })
    });
    var d = {}; try { d = await r.json(); } catch (x) {}
    if (r.status === 201) { location.href = '/citizen'; return; }
    if (d.code === 'INVALID_MOBILE') return err('reg-mobile-msg', 'reg-error-mobile', d.message);
    if (d.code === 'CONSENT_REQUIRED') return err('reg-consent-msg', 'reg-error-consent', d.message);
    if (d.code === 'INVALID_EMAIL') return err('reg-email-msg', 'reg-error-email', d.message);
    if (r.status === 401) { location.href = '/login'; return; }
    if (r.status === 409) { location.href = '/citizen'; return; }
    if (window.EG) window.EG.error(d.message || 'เกิดข้อผิดพลาด');
  });
})();
</script>`;
  view.page(req, res, { title: 'ลงทะเบียน', body });
}

/* ---------------------------------------------------------------- RBAC กลาง (A-39) */

// คำนำหน้า path → บทบาทที่เข้าได้ (ตรวจก่อนถึง route ของโมดูลอื่น)
const PAGE_RULES = [
  ['/citizen', ['citizen']],
  ['/officer', ['officer', 'head']],
  ['/head', ['head']],
  ['/dashboard', ['executive']],
  ['/audit', ['auditor']],
  ['/admin', ['admin']],
  ['/notifications', ['officer', 'head']],
];
const API_RULES = [
  ['/api/officer', ['officer', 'head']],
  ['/api/notifications', ['officer', 'head']],
  ['/api/dashboard', ['executive']],
  ['/api/audit', ['auditor']],
  ['/api/admin', ['admin']],
  ['/api/drafts', ['citizen']],
  ['/api/payments', ['citizen']],
  // เส้นร่วมของประชาชน/เจ้าหน้าที่/หัวหน้า: executive · auditor · admin → 403 (CONTRACT §6.2, DECISIONS §18)
  ['/api/cases', ['citizen', 'officer', 'head']],
  ['/api/documents', ['citizen', 'officer', 'head']],
  ['/api/files', ['citizen', 'officer', 'head']],
];

function installRbac(app) {
  // Audit แก้/ลบไม่ได้: PUT/PATCH/DELETE ที่ /api/audit[/…] → 405 ทุกบทบาท (CONTRACT §6.4) ตรวจก่อนสิทธิ์
  app.use('/api/audit', (req, res, next) => {
    if (['PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method Not Allowed');
    }
    return next();
  });
  for (const [prefix, roles] of PAGE_RULES) app.use(prefix, http.requirePage(...roles));
  for (const [prefix, roles] of API_RULES) app.use(prefix, http.requireApi(...roles));
}

/* ---------------------------------------------------------------- ลงทะเบียน route */

module.exports = {
  register(app) {
    installRbac(app);

    app.get('/login', loginPage);
    app.get('/register', registerPage);

    app.post('/api/auth/thaid/start', wrap(thaidStart));
    app.post('/api/auth/thaid/verify', wrap(thaidVerify));
    app.post('/api/auth/register', wrap(register));
    app.post('/api/auth/staff/login', wrap(staffLogin));
    app.post('/api/auth/logout', (req, res) => {
      http.destroySession(req, res);
      res.status(204).end();
    });
    app.get('/api/me', http.requireApi(), (req, res) => {
      const u = req.user;
      res.json({ username: u.username, name: u.name, role: u.role, dept: u.dept || '' });
    });
    // เมธอดอื่นบนเส้น auth → 405 ตามรูปแบบ error กลาง
    app.all(['/api/auth/thaid/start', '/api/auth/thaid/verify', '/api/auth/register', '/api/auth/staff/login', '/api/auth/logout'],
      (_req, res) => apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method Not Allowed'));
  },

  // สำหรับโมดูลอื่น (ดูหัวไฟล์)
  canViewCase,
  officerIdFields,
  LOCK_FAILS,
  LOCK_MINUTES,
};
