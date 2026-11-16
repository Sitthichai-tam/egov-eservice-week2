// เรนเดอร์บันทึกการเรียก API จริงของ TC (จาก DEBUG=pw:api) เป็นเฟรม PNG: node render-api-gif.js <api.json> <outdir>
const { chromium } = require('playwright-core');
const fs = require('fs');
const [,, src, outdir] = process.argv;
const { tc, lines } = JSON.parse(fs.readFileSync(src, 'utf8'));
const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;');
const cls = t => /passed/.test(t) ? 'ok' : /failed/.test(t) ? 'bad' : t.startsWith('→') ? 'req' : /^← [45]/.test(t) ? 'warn' : 'res';
const html = (shown) => `<html><body style="margin:0;background:#0f172a;color:#e2e8f0;font:15px/1.5 'DejaVu Sans Mono',monospace;width:800px;height:520px;overflow:hidden">
<div style="background:#1e293b;padding:8px 14px;color:#94a3b8">${esc(tc)} · playwright test (บันทึกการเรียก API จริง)</div>
<div style="padding:12px 14px">${shown.map(l=>`<div class="${cls(l[1])}">${esc(l[1])}</div>`).join('')}</div>
<style>.req{color:#7dd3fc}.res{color:#86efac}.warn{color:#fdba74}.ok{color:#4ade80;font-weight:bold;margin-top:8px}.bad{color:#f87171;font-weight:bold}</style></body></html>`;
(async () => {
  fs.mkdirSync(outdir, { recursive: true });
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const pg = await b.newPage({ viewport: { width: 800, height: 520 } });
  const maxRows = 20; let n = 0;
  for (let k = 1; k <= lines.length; k++) {
    await pg.setContent(html(lines.slice(Math.max(0, k - maxRows), k)));
    await pg.screenshot({ path: `${outdir}/f${String(++n).padStart(3,'0')}.png` });
  }
  for (let i = 0; i < 8; i++) fs.copyFileSync(`${outdir}/f${String(n).padStart(3,'0')}.png`, `${outdir}/f${String(++n).padStart(3,'0')}.png`);
  await b.close(); console.log(tc, 'frames', n);
})();
