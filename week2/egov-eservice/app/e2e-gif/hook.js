// ตัวครอบสำหรับเก็บวิดีโอ (ไม่แก้ไฟล์เทสต์): ฉีด recordVideo ให้ทุก browser.newContext() ที่เทสต์สร้างเอง
// ใช้: GIF_DIR=<โฟลเดอร์> NODE_OPTIONS="--require ./e2e-gif/hook.js" npx playwright test -g "TC-XXX"
const dir = process.env.GIF_DIR;
if (dir) {
  const pw = require('playwright-core');
  const bt = pw.chromium;
  const launch = bt.launch.bind(bt);
  bt.launch = async (...args) => {
    const browser = await launch(...args);
    const nc = browser.newContext.bind(browser);
    browser.newContext = (opts = {}) => nc({ ...opts, recordVideo: { dir, size: { width: 800, height: 600 } } });
    return browser;
  };
}
