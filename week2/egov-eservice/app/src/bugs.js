'use strict';
// BUG_MODE: bug('B03') → true เมื่อเปิดบั๊กนั้น · ไม่ตั้ง BUG_MODE = ถูกต้อง 100%
// ข้อควรจำ (CONTRACT §8 A-35): บั๊กกระทบเฉพาะ "การคำนวณ/ตรวจสิทธิ์" ไม่กระทบข้อมูล seed
const { BUG_MODE } = require('./config');

function bug(code) {
  return BUG_MODE.has(String(code).toUpperCase());
}
bug.active = () => [...BUG_MODE];
module.exports = bug;
