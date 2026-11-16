'use strict';
/**
 * ที่เก็บไฟล์อัปโหลดบนดิสก์ (UPLOAD_DIR) · reset ลบทั้งโฟลเดอร์ (CONTRACT §0 ข้อ 9)
 *   storage.save(buffer, ext) → relPath (เก็บลงคอลัมน์ files.path)
 *   storage.read(relPath)     → Buffer
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');

function ensure() {
  fs.mkdirSync(cfg.UPLOAD_DIR, { recursive: true });
}
function reset() {
  fs.rmSync(cfg.UPLOAD_DIR, { recursive: true, force: true });
  ensure();
}
function save(buffer, ext = '') {
  ensure();
  const rel = crypto.randomBytes(12).toString('hex') + (ext ? '.' + String(ext).replace(/[^a-z0-9]/gi, '') : '');
  fs.writeFileSync(path.join(cfg.UPLOAD_DIR, rel), buffer);
  return rel;
}
function read(rel) {
  // กัน path traversal: เอาเฉพาะชื่อไฟล์
  return fs.readFileSync(path.join(cfg.UPLOAD_DIR, path.basename(rel)));
}

module.exports = { save, read, reset, ensure };
