'use strict';
/**
 * เครื่องมือความปลอดภัยกลาง (ตัวจำลองทั้งหมด · A-22 A-55)
 *  - เลขบัตร/เบอร์โทรเก็บเข้ารหัส AES-256-GCM (NFR-04) · ค้นหาด้วย HMAC (idHash) ห้ามเก็บเลขตรง ๆ ในฐานข้อมูล
 *  - รหัสผ่านเจ้าหน้าที่: scrypt
 *  - ลายเซ็นเอกสาร: HMAC-SHA256 ตามลำดับฟิลด์ใน CONTRACT §7
 */
const crypto = require('crypto');
const cfg = require('./config');

const piiKey = crypto.createHash('sha256').update(cfg.PII_KEY).digest();
const lookupKey = crypto.createHash('sha256').update('lookup|' + cfg.PII_KEY).digest();

/** AES-256-GCM · ผลลัพธ์ "v1:<iv>:<tag>:<ciphertext>" (base64url) · IV สุ่มทุกครั้ง */
function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', piiKey, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
}
function decrypt(blob) {
  if (!blob) return null;
  const [v, iv, tag, ct] = String(blob).split(':');
  if (v !== 'v1') throw new Error('unknown cipher format');
  const d = crypto.createDecipheriv('aes-256-gcm', piiKey, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
/** ดัชนีค้นหาเลขบัตร (HMAC-SHA256 hex) · ไม่ใช่เลขตรง ๆ */
function idHash(idNo) {
  return crypto.createHmac('sha256', lookupKey).update(String(idNo)).digest('hex');
}

/** เลขบัตร 13 หลัก + checksum (หลักที่ 13 = (11 − Σ(หลัก i × (14−i)) mod 11) mod 10) · BR-01 */
function validIdNo(idNo) {
  if (typeof idNo !== 'string' || !/^\d{13}$/.test(idNo)) return false;
  let s = 0;
  for (let i = 0; i < 12; i++) s += Number(idNo[i]) * (13 - i);
  return (11 - (s % 11)) % 10 === Number(idNo[12]);
}
/** 1101700123456 → 1-1017-00123-45-6 */
function formatId(idNo) {
  const s = String(idNo);
  return `${s[0]}-${s.slice(1, 5)}-${s.slice(5, 10)}-${s.slice(10, 12)}-${s[12]}`;
}
/** 1101700123456 → X-XXXX-XXXXX-45-6 (ที่เจ้าหน้าที่เห็น) */
function maskId(idNo) {
  const s = String(idNo);
  return `X-XXXX-XXXXX-${s.slice(10, 12)}-${s[12]}`;
}
/** ชื่อปิดบังหน้า verify: "สมชาย ใจดี" → "สมชาย ใ***" (A-54) */
function maskName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/);
  if (parts.length < 2) return parts[0] ? parts[0] + ' ***' : '***';
  const last = parts.slice(1).join(' ');
  return `${parts[0]} ${Array.from(last)[0]}***`;
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw + cfg.PASSWORD_PEPPER, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${h.toString('base64url')}`;
}
function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [alg, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const h = crypto.scryptSync(String(pw) + cfg.PASSWORD_PEPPER, Buffer.from(salt, 'base64url'), 32);
  const want = Buffer.from(hash, 'base64url');
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}

const token = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

const VERIFY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** รหัสตรวจสอบเอกสาร 8 ตัว (ไม่มี 0/O/1/I) */
function newVerifyCode() {
  const b = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += VERIFY_ALPHABET[b[i] % VERIFY_ALPHABET.length];
  return s;
}

/**
 * ลายเซ็นเอกสาร (CONTRACT §7): HMAC-SHA256 ของ docNo|caseNo|applicant|serviceId|issuedAt|validUntil|signer
 * ทั้งโมดูลออกเอกสาร (B07) และ seed ต้องใช้ฟังก์ชันนี้ตัวเดียว · doc = แถวจากตาราง documents
 *  applicant = ชื่อเต็มผู้ยื่น · issuedAt = ISO +07:00 · validUntil = 'YYYY-MM-DD' (วันสุดท้ายที่ใช้ได้)
 */
function signDocument(doc) {
  const msg = [doc.doc_no, doc.case_no, doc.applicant, doc.service_id, doc.issued_at, doc.valid_until, doc.signer].join('|');
  return crypto.createHmac('sha256', cfg.SIGN_KEY).update(msg).digest('hex');
}
function verifyDocumentSignature(doc) {
  const want = Buffer.from(signDocument(doc), 'hex');
  const got = Buffer.from(String(doc.signature || ''), 'hex');
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

module.exports = {
  encrypt, decrypt, idHash, validIdNo, formatId, maskId, maskName,
  hashPassword, verifyPassword, token, newVerifyCode, signDocument, verifyDocumentSignature,
};
