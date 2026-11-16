'use strict';
/**
 * ตัวช่วย HTTP กลาง: คุกกี้ · session · การตรวจสิทธิ์ · รูปแบบ error (CONTRACT §0 ข้อ 6)
 *  - error API: {"code":"...","message":"..."} (+ฟิลด์เพิ่ม)
 *  - session cookie `sid` HttpOnly · ข้อมูล role/dept เป็นสแนปช็อตตอนล็อกอิน
 *  - หน้า (HTML): ยังไม่ล็อกอิน → redirect /login · บทบาทไม่ตรง → 403 พร้อม forbidden-msg
 *  - API: ยังไม่ล็อกอิน → 401 UNAUTHENTICATED · บทบาทไม่ตรง → 403 FORBIDDEN
 */
const { db } = require('./db');
const clock = require('./clock');
const security = require('./security');

const COOKIE = 'sid';
const SESSION_TTL_MS = 12 * 3600 * 1000; // เวลาจริง (โครงสร้างพื้นฐาน ไม่ใช่กฎธุรกิจ)

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}

/** ส่ง error JSON ตามสัญญา: apiError(res, 409, 'ALREADY_CLAIMED', 'ข้อความ', {…}) */
function apiError(res, status, code, message, extra) {
  return res.status(status).json({ code, message: message || code, ...(extra || {}) });
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** middleware: ใส่ req.user = {username,name,role,dept,kind,token} หรือ null */
function sessionMiddleware(req, _res, next) {
  req.user = null;
  const tok = parseCookies(req)[COOKIE];
  if (tok) {
    const s = db.get('SELECT * FROM sessions WHERE token = ?', tok);
    if (s && s.expires_real > clock.realMs()) {
      req.user = { username: s.username, name: s.name, role: s.role, dept: s.dept, kind: s.kind, token: s.token };
    } else if (s) {
      db.run('DELETE FROM sessions WHERE token = ?', tok);
    }
  }
  next();
}

/** สร้าง session + ตั้งคุกกี้ · user = แถว users · kind: 'full' | 'register' */
function createSession(res, user, kind = 'full') {
  const tok = security.token();
  db.run(
    `INSERT INTO sessions(token, username, kind, role, dept, name, created_at, expires_real) VALUES(?,?,?,?,?,?,?,?)`,
    tok, user.username, kind, user.role, user.dept || '', user.name, clock.nowIso(), clock.realMs() + SESSION_TTL_MS
  );
  res.append('Set-Cookie', `${COOKIE}=${tok}; Path=/; HttpOnly; SameSite=Lax`);
  return tok;
}

function destroySession(req, res) {
  const tok = req.user ? req.user.token : parseCookies(req)[COOKIE];
  if (tok) db.run('DELETE FROM sessions WHERE token = ?', tok);
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Guard ของ API: requireApi('officer','head') · ไม่ใส่บทบาท = แค่ล็อกอิน */
function requireApi(...roles) {
  return (req, res, next) => {
    if (!req.user) return apiError(res, 401, 'UNAUTHENTICATED', 'กรุณาเข้าสู่ระบบ');
    if (req.user.kind !== 'full') return apiError(res, 403, 'NOT_REGISTERED', 'กรุณาลงทะเบียนก่อนใช้งาน');
    if (roles.length && !roles.includes(req.user.role)) return apiError(res, 403, 'FORBIDDEN', 'ไม่มีสิทธิ์');
    next();
  };
}

/** Guard ของหน้า: requirePage('citizen') */
function requirePage(...roles) {
  return (req, res, next) => {
    const view = require('./view');
    if (!req.user) return res.redirect('/login');
    if (req.user.kind !== 'full') return res.redirect('/register');
    if (roles.length && !roles.includes(req.user.role)) return view.forbidden(req, res);
    next();
  };
}

module.exports = {
  HttpError, apiError, wrap, parseCookies, sessionMiddleware, createSession, destroySession,
  requireApi, requirePage, COOKIE,
};
