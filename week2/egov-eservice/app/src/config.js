'use strict';
// ค่าตั้งต้นทั้งหมดอ่านจากตัวแปรสภาพแวดล้อมที่นี่ที่เดียว (CONTRACT §0 ข้อ 8, 11 · README กติกา 4)
const path = require('path');
const env = process.env;

const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v || '').trim().toLowerCase());

const DB_PATH = env.DB_PATH || path.resolve(__dirname, '..', 'data', 'app.db');
const BUG_MODE = new Set(
  String(env.BUG_MODE || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
);

module.exports = {
  PORT: parseInt(env.PORT, 10) || 3000,
  // TEST_MODE=1 เปิด /api/test/* · ไม่ตั้ง = ปิด (ตอบ 404)
  TEST_MODE: truthy(env.TEST_MODE),
  // BUG_MODE=B03,B07 · ไม่ตั้ง = ถูกต้อง 100% (ใช้ผ่าน src/bugs.js)
  BUG_MODE,
  DB_PATH,
  UPLOAD_DIR: env.UPLOAD_DIR || path.join(path.dirname(DB_PATH), 'uploads'),
  // คีย์ทดสอบ (ตัวจำลอง ไม่ใช่ของจริง · A-22) แทนที่ได้ด้วย env
  PII_KEY: env.PII_KEY || 'egov-eservice-test-pii-key-aes256',
  SIGN_KEY: env.SIGN_KEY || 'egov-eservice-test-signing-key',
  PASSWORD_PEPPER: env.PASSWORD_PEPPER || '',
  // ค่าคงที่ตามชุดโจทย์
  DEFAULT_NOW: '2026-12-01T09:00:00+07:00', // DECISIONS §0 A-01
  OTP: '123456', // ตัวจำลอง ThaiD
  MAX_BODY: '10mb', // CONTRACT §0 ข้อ 10: รับ body ≥ 6 MB
  MAX_UPLOAD_BYTES: 5242880, // 5 MB = 5 × 1,048,576 (ใช้ตรวจ "≤" ในโมดูลอัปโหลด)
};
