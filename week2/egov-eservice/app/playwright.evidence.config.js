// config สำหรับเก็บหลักฐาน LAB 4 (ผลเดียวกับ playwright.config.js แต่เพิ่ม JSON + HTML + วิดีโอ) ไม่เปลี่ยนตัวเทสต์
const base = require('./playwright.config.js');
module.exports = {
  ...base,
  reporter: [['list'], ['json', { outputFile: '/workspace/plans/egov-eservice/test-report/results.json' }],
             ['html', { outputFolder: '/workspace/plans/egov-eservice/test-report/html', open: 'never' }]],
  outputDir: '/workspace/plans/egov-eservice/test-report/artifacts',
  use: { ...base.use, video: 'on' },
};
