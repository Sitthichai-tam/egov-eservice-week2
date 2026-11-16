// Playwright config · รันชุดเต็ม 51 TC กับเว็บที่เปิดไว้แล้ว (BASE_URL, ค่าเริ่มต้น http://localhost:3000)
// ทุก test เรียก POST /api/test/reset ล้างทั้งระบบ → ต้อง workers = 1 และไม่ retry
const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './e2e',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60000,
  reporter: [['list']],
  use: { baseURL: process.env.BASE_URL || 'http://localhost:3000' },
});
