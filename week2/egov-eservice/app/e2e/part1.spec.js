// part1.spec.js — Playwright ชุดที่ 1 (B12): AUTH · FEE · SUBMIT · UPLOAD · PAY · QUEUE · SLA
// ผลที่คาดหวังทั้งหมดคิดจาก TEST-PLAN.md / CONTRACT.md / TEST-DATA.md (ไม่ได้อ่านจากหน้าจอเว็บ)
// ตัวแปรสภาพแวดล้อม: BASE_URL (ค่าเริ่มต้น http://localhost:3000)
// หมายเหตุ: ทุก test ใช้ POST /api/test/reset ซึ่งล้างสถานะทั้งระบบ → ต้องรันด้วย workers = 1
const { test, expect, request } = require('@playwright/test');
const zlib = require('zlib');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
test.use({ baseURL: BASE_URL });

// ---------------------------------------------------------------- ค่าคงที่
const SOMCHAI = '1101700123456';
const SOMYING = '3100600987659';
const MANA = '5500400111221';
const PITI = '1909900555015';
const OTP = '123456';
const PASS = 'Test@1234';
const T0 = '2026-12-01T09:00:00+07:00';

const EG = (n) => 'EG-2569-' + String(n).padStart(6, '0');
const baht = (n) => '฿' + n.toLocaleString('en-US');
const TH_M = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
// '2026-12-04T16:30:00+07:00' → '4 ธ.ค. 2569 16:30'
function thDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  return `${+m[3]} ${TH_M[+m[2] - 1]} ${+m[1] + 543} ${m[4]}:${m[5]}`;
}

// ---------------------------------------------------------------- ไฟล์ทดสอบ (TEST-DATA ข้อ 11)
function pdf(n) {
  const head = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n');
  const tail = Buffer.from('\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  const pad = n - head.length - tail.length;
  if (pad < 0) throw new Error('pdf too small');
  return Buffer.concat([head, Buffer.alloc(pad, 0x20), tail]);
}
const CRC_TABLE = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(n) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const base = Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 0, 0]))),
  ]);
  const iend = pngChunk('IEND', Buffer.alloc(0));
  const pad = n - base.length - iend.length - 12;
  const text = pngChunk('tEXt', Buffer.concat([Buffer.from('k\0'), Buffer.alloc(pad - 2, 0x78)]));
  return Buffer.concat([base, text, iend]);
}
function jpg(n) {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const pad = n - soi.length - app0.length - 2 - 4;
  const comLen = Buffer.alloc(2);
  comLen.writeUInt16BE(pad + 2);
  return Buffer.concat([soi, app0, Buffer.from([0xff, 0xfe]), comLen, Buffer.alloc(pad, 0x78), Buffer.from([0xff, 0xd9])]);
}
function F(name, mimeOverride) {
  let buffer;
  const m = /^size-(\d+)\.pdf$/.exec(name);
  if (m) buffer = pdf(+m[1]);
  else if (name === 'real.jpg' || name === 'plan-as-jpg.jpg') buffer = jpg(1024);
  else if (name === 'real.png') buffer = png(1024);
  else if (name === 'fake-text.pdf' || name === 'fake-text.jpg' || name === 'notes.txt') buffer = Buffer.from('hello');
  else if (name === 'exe-as.png') buffer = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(1022)]);
  else buffer = pdf(1024);
  let mimeType = 'application/octet-stream';
  if (/\.pdf$/.test(name)) mimeType = name === 'fake-text.pdf' ? 'application/octet-stream' : 'application/pdf';
  else if (/\.jpg$/.test(name)) mimeType = 'image/jpeg';
  else if (/\.png$/.test(name)) mimeType = 'image/png';
  else if (/\.txt$/.test(name)) mimeType = 'text/plain';
  return { name, mimeType: mimeOverride || mimeType, buffer };
}
const REQ_DOCS = {
  'SV-01': [['id-card.pdf', 'id-card']],
  'SV-02': [['id-card.pdf', 'id-card'], ['map.pdf', 'map']],
  'SV-03': [['id-card.pdf', 'id-card'], ['plan.pdf', 'plan'], ['deed.pdf', 'deed']],
};

// ---------------------------------------------------------------- สูตรกลาง (TEST-PLAN ข้อ 0)
const cleanup = [];
test.beforeEach(() => {
  test.setTimeout(180000);
});
test.afterEach(async () => {
  while (cleanup.length) {
    const c = cleanup.pop();
    try {
      if (typeof c.dispose === 'function') await c.dispose();
      else await c.close();
    } catch (e) { /* ignore */ }
  }
});

async function newApi() {
  const a = await request.newContext({ baseURL: BASE_URL });
  cleanup.push(a);
  return a;
}
// RESET: POST /api/test/reset → 200 · now = 2026-12-01T09:00:00+07:00
async function RESET() {
  const a = await newApi();
  const r = await a.post('/api/test/reset');
  expect(r.status()).toBe(200);
  expect(await r.json()).toMatchObject({ ok: true, now: T0 });
}
// CLOCK(t): PUT /api/test/clock
async function CLOCK(t) {
  const a = await newApi();
  const r = await a.put('/api/test/clock', { data: { now: t } });
  expect(r.status()).toBe(200);
}
// LOGIN_C: start + verify OTP 123456 (ล็อกอินซ้ำบน api เดิมได้ เพื่อต่อ session หลังนาฬิกาเดินข้ามวัน)
async function LOGIN_C(idNo, api) {
  api = api || (await newApi());
  const s = await api.post('/api/auth/thaid/start', { data: { idNo } });
  expect(s.status()).toBe(200);
  const v = await api.post('/api/auth/thaid/verify', { data: { idNo, otp: OTP } });
  expect(v.status()).toBe(200);
  return api;
}
// LOGIN_S: staff login รหัสผ่าน Test@1234
async function LOGIN_S(username, api) {
  api = api || (await newApi());
  const r = await api.post('/api/auth/staff/login', { data: { username, password: PASS } });
  expect(r.status()).toBe(200);
  return api;
}
async function newPage(browser) {
  const ctx = await browser.newContext({ baseURL: BASE_URL });
  cleanup.push(ctx);
  const page = await ctx.newPage();
  return { ctx, page, api: ctx.request };
}
async function pageAsC(browser, idNo) {
  const b = await newPage(browser);
  await LOGIN_C(idNo, b.api);
  return b;
}
async function pageAsS(browser, username) {
  const b = await newPage(browser);
  await LOGIN_S(username, b.api);
  return b;
}

async function createDraft(api, service, o = {}) {
  const data = { serviceId: service };
  if (service === 'SV-01') data.qty = o.qty === undefined ? 1 : o.qty;
  if (service === 'SV-03') data.areaSqm = o.area === undefined ? 100 : o.area;
  const r = await api.post('/api/drafts', { data });
  expect(r.status()).toBe(201);
  return r.json();
}
function uploadApi(api, draftId, file, docKey) {
  return api.post(`/api/drafts/${draftId}/files`, {
    multipart: { file: { name: file.name, mimeType: file.mimeType, buffer: file.buffer }, docKey },
  });
}
// ร่าง + ไฟล์บังคับ + QR (ยังไม่ชำระ)
async function prepareDraft(api, service, o = {}) {
  const d = await createDraft(api, service, o);
  for (const [name, key] of REQ_DOCS[service]) {
    const u = await uploadApi(api, d.draftId, F(name), key);
    expect(u.status()).toBe(201);
  }
  const p = await api.post(`/api/drafts/${d.draftId}/payment`);
  expect(p.status()).toBe(201);
  const pj = await p.json();
  return { draftId: d.draftId, fee: d.fee, ref: pj.ref, qr: pj };
}
function payRef(api, ref, amount) {
  return api.post(`/api/test/payments/${ref}/pay`, { data: { amount } });
}
// NEW_PAID(ผู้ยื่น, บริการ, เวลา, ตัวเลือก)
async function NEW_PAID(o = {}) {
  const service = o.service || 'SV-01';
  if (o.time) await CLOCK(o.time);
  const api = await LOGIN_C(o.idNo || SOMCHAI, o.api);
  const d = await prepareDraft(api, service, o);
  const r = await payRef(api, d.ref, d.fee);
  expect(r.status()).toBe(200);
  const pr = await api.get(`/api/payments/${d.ref}`);
  expect(pr.status()).toBe(200);
  const pj = await pr.json();
  expect(pj.caseNo).toMatch(/^EG-\d{4}-\d{6}$/);
  return { api, ...d, caseNo: pj.caseNo };
}
async function getCase(api, caseNo) {
  const r = await api.get(`/api/cases/${caseNo}`);
  expect(r.status()).toBe(200);
  return r.json();
}
async function casesCount(api) {
  const r = await api.get('/api/cases');
  expect(r.status()).toBe(200);
  return (await r.json()).items.length;
}
async function queueCaseNos(page) {
  return page.getByTestId('queue-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-case-no')));
}
const qrow = (page, caseNo) => page.locator(`[data-testid="queue-row"][data-case-no="${caseNo}"]`);

async function uiLoginC(page, idNo) {
  await page.goto('/login');
  await page.getByTestId('login-tab-citizen').click();
  await page.getByTestId('thaid-id-input').fill(idNo);
  await page.getByTestId('thaid-submit').click();
  await expect(page.getByTestId('otp-step')).toBeVisible();
  await page.getByTestId('otp-input').fill(OTP);
  await page.getByTestId('otp-submit').click();
}
async function otpTry(api, idNo, otp) {
  await api.post('/api/auth/thaid/start', { data: { idNo } });
  const r = await api.post('/api/auth/thaid/verify', { data: { idNo, otp } });
  let body = {};
  try { body = await r.json(); } catch (e) { /* ignore */ }
  return { status: r.status(), body };
}
async function claimApi(api, caseNo) {
  return api.post(`/api/officer/cases/${caseNo}/claim`);
}
async function returnApi(api, caseNo, reason = 'xxxxxxxxxx') {
  return api.post(`/api/officer/cases/${caseNo}/return`, { data: { reason } });
}
async function auditCount(audit, event, caseNo) {
  const r = await audit.get(`/api/audit?actor=&event=${event}&from=2026-12-01&to=2026-12-01`);
  expect(r.status()).toBe(200);
  const j = await r.json();
  return j.items.filter((i) => i.event === event && i.caseNo === caseNo).length;
}

// ================================================================ AUTH
test('TC-AUTH-01 เลขบัตร 13 หลัก + checksum', async ({ browser }) => {
  await RESET();
  const { page } = await newPage(browser);
  const bad = ['110170012345', '11017001234567', '1101700123457', '11017001234ab'];
  const good = ['1101700123456', '3100600987659', '1909900555015', '5500400111221'];

  for (const v of bad) {
    await page.goto('/login');
    await page.getByTestId('login-tab-citizen').click();
    await page.getByTestId('thaid-id-input').fill(v);
    await page.getByTestId('thaid-submit').click();
    await expect(page.getByTestId('thaid-error'), `UI ${v}`).toHaveText('เลขบัตรประชาชนไม่ถูกต้อง');
    await expect(page.getByTestId('otp-step'), `UI ${v}`).toBeHidden();

    const a = await newApi();
    const r = await a.post('/api/auth/thaid/start', { data: { idNo: v } });
    expect(r.status(), `API ${v}`).toBe(400);
    expect((await r.json()).code).toBe('INVALID_ID');
  }
  for (const v of good) {
    await page.goto('/login');
    await page.getByTestId('login-tab-citizen').click();
    await page.getByTestId('thaid-id-input').fill(v);
    await page.getByTestId('thaid-submit').click();
    await expect(page.getByTestId('otp-step'), `UI ${v}`).toBeVisible();
    await expect(page.getByTestId('thaid-error'), `UI ${v}`).toHaveCount(0);

    const a = await newApi();
    const r = await a.post('/api/auth/thaid/start', { data: { idNo: v } });
    expect(r.status(), `API ${v}`).toBe(200);
    expect(await r.json()).toMatchObject({ status: 'OTP_SENT' });
  }
});

test('TC-AUTH-02 OTP ผิด 3 ครั้งล็อก 15 นาที', async ({ browser }) => {
  await RESET();
  const { page } = await newPage(browser);
  await page.goto('/login');
  await page.getByTestId('login-tab-citizen').click();
  await page.getByTestId('thaid-id-input').fill(PITI);
  await page.getByTestId('thaid-submit').click();
  await expect(page.getByTestId('otp-step')).toBeVisible();

  // 1
  await page.getByTestId('otp-input').fill('000000');
  await page.getByTestId('otp-submit').click();
  await expect(page.getByTestId('otp-error')).toHaveText('รหัส OTP ไม่ถูกต้อง');
  await expect(page.getByTestId('otp-attempts-left')).toHaveText('เหลือ 2 ครั้ง');
  // 2
  await page.getByTestId('otp-input').fill('000000');
  await page.getByTestId('otp-submit').click();
  await expect(page.getByTestId('otp-attempts-left')).toHaveText('เหลือ 1 ครั้ง');
  // 3
  await page.getByTestId('otp-input').fill('000000');
  await page.getByTestId('otp-submit').click();
  await expect(page.getByTestId('lock-message')).toHaveText('ผิดเกินกำหนด เลขบัตรนี้ถูกล็อก 15 นาที');
  await expect(page.getByTestId('lock-until')).toHaveAttribute('data-iso', '2026-12-01T09:15:00+07:00');

  const api = await newApi();
  // 4 OTP ถูกทันที → ยัง 423
  let r = await otpTry(api, PITI, OTP);
  expect(r.status).toBe(423);
  expect(r.body.code).toBe('LOCKED');
  // 5 สมชายล็อกอินได้ปกติ
  await LOGIN_C(SOMCHAI);
  // 6 ผ่านไป 14:59 ยังล็อก
  await CLOCK('2026-12-01T09:14:59+07:00');
  r = await otpTry(api, PITI, OTP);
  expect(r.status).toBe(423);
  // 7 ครบ 15:00 ปลดล็อก ตัวนับเริ่มใหม่
  await CLOCK('2026-12-01T09:15:00+07:00');
  r = await otpTry(api, PITI, '000000');
  expect(r.status).toBe(401);
  expect(r.body.code).toBe('OTP_INVALID');
  expect(r.body.attemptsLeft).toBe(2);
  // 8 OTP ถูก → 200
  r = await otpTry(api, PITI, OTP);
  expect(r.status).toBe(200);

  // 9 RESET · ผิด 2 → ถูก → ออก → ผิดอีก 2 ไม่ล็อก
  await RESET();
  const a2 = await newApi();
  r = await otpTry(a2, PITI, '000000');
  expect(r.status).toBe(401);
  expect(r.body.attemptsLeft).toBe(2);
  r = await otpTry(a2, PITI, '000000');
  expect(r.status).toBe(401);
  expect(r.body.attemptsLeft).toBe(1);
  r = await otpTry(a2, PITI, OTP);
  expect(r.status).toBe(200);
  const lo = await a2.post('/api/auth/logout');
  expect(lo.status()).toBe(204);
  r = await otpTry(a2, PITI, '000000');
  expect(r.status).toBe(401);
  expect(r.body.attemptsLeft).toBe(2);
  r = await otpTry(a2, PITI, '000000');
  expect(r.status).toBe(401);
  expect(r.body.code).toBe('OTP_INVALID');
  expect(r.body.attemptsLeft).toBe(1);
});

test('TC-AUTH-03 ลงทะเบียนครั้งแรก', async ({ browser }) => {
  await RESET();
  const { page } = await newPage(browser);
  await uiLoginC(page, MANA);
  await expect(page).toHaveURL(/\/register$/);

  // 1 ชื่ออ่านอย่างเดียว
  const name = page.getByTestId('reg-name');
  await expect(name).toHaveValue('มานะ ตั้งใจ');
  await expect(name).toHaveJSProperty('readOnly', true);
  await name.click();
  await page.keyboard.type('xyz');
  await expect(name).toHaveValue('มานะ ตั้งใจ');

  const mobileErr = 'เบอร์มือถือต้องเป็นตัวเลข 10 หลักขึ้นต้นด้วย 0';
  // 2-4 เบอร์ผิดรูปแบบ
  await page.getByTestId('reg-consent').check();
  for (const m of ['081234567', '08123456789', '1812345678', '08123abcde']) {
    await page.getByTestId('reg-mobile').fill(m);
    await page.getByTestId('reg-submit').click();
    await expect(page.getByTestId('reg-error-mobile'), `mobile ${m}`).toHaveText(mobileErr);
    await expect(page).toHaveURL(/\/register$/);
  }
  // 5 ไม่ติ๊กยินยอม
  await page.getByTestId('reg-mobile').fill('0845678901');
  await page.getByTestId('reg-consent').uncheck();
  await page.getByTestId('reg-submit').click();
  await expect(page.getByTestId('reg-error-consent')).toHaveText('กรุณายินยอมการประมวลผลข้อมูลส่วนบุคคล (PDPA)');
  await expect(page).toHaveURL(/\/register$/);
  // 6 ลงทะเบียนสำเร็จ
  await page.getByTestId('reg-consent').check();
  await page.getByTestId('reg-submit').click();
  await expect(page).toHaveURL(/\/citizen$/);
  await expect(page.getByTestId('citizen-welcome')).toHaveText('สวัสดี มานะ ตั้งใจ');
  // 7 ออกแล้วเข้าใหม่ → /citizen ตรง ๆ
  await page.getByTestId('logout-btn').click();
  await expect(page).toHaveURL(/\/login/);
  await uiLoginC(page, MANA);
  await expect(page).toHaveURL(/\/citizen$/);
  await expect(page.getByTestId('citizen-welcome')).toHaveText('สวัสดี มานะ ตั้งใจ');

  // 8 RESET แล้วทดสอบ API
  await RESET();
  const api = await newApi();
  const s = await api.post('/api/auth/thaid/start', { data: { idNo: MANA } });
  expect(s.status()).toBe(200);
  const v = await api.post('/api/auth/thaid/verify', { data: { idNo: MANA, otp: OTP } });
  expect(v.status()).toBe(200);
  expect(await v.json()).toMatchObject({ registered: false });
  let r = await api.post('/api/auth/register', { data: { mobile: '081234567', email: '', consent: true } });
  expect(r.status()).toBe(400);
  expect((await r.json()).code).toBe('INVALID_MOBILE');
  r = await api.post('/api/auth/register', { data: { mobile: '0845678901', email: '', consent: false } });
  expect(r.status()).toBe(400);
  expect((await r.json()).code).toBe('CONSENT_REQUIRED');
});

test('TC-AUTH-04 เจ้าหน้าที่ SSO จำลองและหน้าตั้งต้นตามบทบาท', async ({ browser }) => {
  await RESET();
  const { page } = await newPage(browser);
  const users = [
    ['off.reg1', '/officer/queue', 'เจ้าหน้าที่ทะเบียน 1', 'เจ้าหน้าที่', 'officer', 'registry'],
    ['off.reg2', '/officer/queue', 'เจ้าหน้าที่ทะเบียน 2', 'เจ้าหน้าที่', 'officer', 'registry'],
    ['off.works1', '/officer/queue', 'เจ้าหน้าที่โยธา 1', 'เจ้าหน้าที่', 'officer', 'works'],
    ['head1', '/head/approvals', 'หัวหน้าฝ่าย', 'หัวหน้าฝ่าย', 'head', null],
    ['exec1', '/dashboard', 'ผู้บริหาร', 'ผู้บริหาร', 'executive', null],
    ['audit1', '/audit', 'ผู้ตรวจสอบภายใน', 'ผู้ตรวจสอบภายใน', 'auditor', null],
    ['admin1', '/admin/services', 'ผู้ดูแลระบบ', 'ผู้ดูแลระบบ', 'admin', null],
  ];
  const staffLogin = async (u, p) => {
    await page.goto('/login');
    await page.getByTestId('login-tab-staff').click();
    await expect(page.getByTestId('staff-submit')).toHaveText('เข้าสู่ระบบเจ้าหน้าที่ (SSO ภาครัฐ จำลอง)');
    await page.getByTestId('staff-username').fill(u);
    await page.getByTestId('staff-password').fill(p);
    await page.getByTestId('staff-submit').click();
  };
  for (const [u, path, uname, roleTxt, role, dept] of users) {
    await staffLogin(u, PASS);
    await expect(page, u).toHaveURL(new RegExp(path.replace(/\//g, '\\/') + '$'));
    await expect(page.getByTestId('user-name'), u).toHaveText(uname);
    const ur = page.getByTestId('user-role');
    await expect(ur, u).toHaveText(roleTxt);
    await expect(ur, u).toHaveAttribute('data-role', role);
    if (dept) await expect(ur, u).toHaveAttribute('data-dept', dept);
    await page.getByTestId('logout-btn').click();
    await expect(page).toHaveURL(/\/login/);
  }
  // ล็อกอินไม่สำเร็จ 3 กรณี เหมือนกัน
  for (const [u, p] of [['off.reg1', 'wrong'], ['nobody', PASS], [SOMCHAI, PASS]]) {
    await staffLogin(u, p);
    await expect(page.getByTestId('staff-error'), `${u}/${p}`).toHaveText('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
    const a = await newApi();
    const r = await a.post('/api/auth/staff/login', { data: { username: u, password: p } });
    expect(r.status(), `API ${u}`).toBe(401);
    expect((await r.json()).code).toBe('INVALID_CREDENTIALS');
  }
  // ออกจากระบบแล้วเปิดหน้าที่ต้องล็อกอิน → /login
  await page.goto('/officer/queue');
  await expect(page).toHaveURL(/\/login/);
});

// ================================================================ FEE
test('TC-FEE-01 ค่าธรรมเนียม SV-01/SV-02/SV-03', async ({ browser }) => {
  await RESET();
  const b = await pageAsC(browser, SOMCHAI);
  const { page, api } = b;

  const apiDraft = async (data) => {
    const r = await api.post('/api/drafts', { data });
    return { status: r.status(), body: await r.json() };
  };
  const sv3 = [
    [0, null, 'กรุณาระบุพื้นที่ 1–500 ตร.ม.', 'INVALID_AREA'],
    [-1, null, 'กรุณาระบุพื้นที่ 1–500 ตร.ม.', 'INVALID_AREA'],
    [1, 1000],
    [100, 1000],
    [101, 1010],
    [102, 1020],
    [250, 2500],
    [300, 3000],
    [499, 4990],
    [500, 5000],
    [501, null, 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน', 'AREA_TOO_LARGE'],
  ];
  await page.goto('/citizen/new/SV-03');
  for (const [area, fee, err, code] of sv3) {
    // สูตร: ฐาน 1,000 ถึง 100 ตร.ม. ส่วนเกิน ×10
    if (fee !== null) expect(fee).toBe(area <= 100 ? 1000 : 1000 + 10 * (area - 100));
    await page.getByTestId('area-input').fill(String(area));
    if (fee !== null) {
      await expect(page.getByTestId('fee-total'), `area ${area}`).toHaveText(baht(fee));
      await expect(page.getByTestId('fee-error'), `area ${area}`).toHaveCount(0);
      await expect(page.getByTestId('to-upload-btn'), `area ${area}`).toBeEnabled();
    } else {
      await expect(page.getByTestId('fee-total'), `area ${area}`).toHaveText('–');
      await expect(page.getByTestId('fee-error'), `area ${area}`).toHaveText(err);
      await expect(page.getByTestId('to-upload-btn'), `area ${area}`).toBeDisabled();
    }
    const r = await apiDraft({ serviceId: 'SV-03', areaSqm: area });
    if (fee !== null) {
      expect(r.status, `API area ${area}`).toBe(201);
      expect(r.body.fee).toBe(fee);
    } else {
      expect(r.status, `API area ${area}`).toBe(400);
      expect(r.body.code).toBe(code);
    }
  }

  // SV-01
  await page.goto('/citizen/new/SV-01');
  const qtyErr = 'จำนวนฉบับต้อง 1–5 ฉบับ';
  for (const q of [0, 1, 2, 3, 4, 5, 6]) {
    await page.getByTestId('qty-input').fill(String(q));
    if (q >= 1 && q <= 5) {
      await expect(page.getByTestId('fee-total'), `qty ${q}`).toHaveText(baht(20 * q));
      await expect(page.getByTestId('fee-error'), `qty ${q}`).toHaveCount(0);
    } else {
      await expect(page.getByTestId('fee-error'), `qty ${q}`).toHaveText(qtyErr);
    }
    const r = await apiDraft({ serviceId: 'SV-01', qty: q });
    if (q >= 1 && q <= 5) {
      expect(r.status, `API qty ${q}`).toBe(201);
      expect(r.body.fee).toBe(20 * q);
    } else {
      expect(r.status, `API qty ${q}`).toBe(400);
      expect(r.body.code).toBe('INVALID_QTY');
    }
  }

  // SV-02
  await page.goto('/citizen/new/SV-02');
  await expect(page.getByTestId('fee-total')).toHaveText('฿500');
  const r2 = await apiDraft({ serviceId: 'SV-02' });
  expect(r2.status).toBe(201);
  expect(r2.body.fee).toBe(500);
});

// ================================================================ SUBMIT
test('TC-SUBMIT-01 ยื่นคำขอ SV-01 ครบวงจร', async ({ browser }) => {
  await RESET();
  const b = await pageAsC(browser, SOMCHAI);
  const { page } = b;
  await page.goto('/citizen');
  // 1
  await page.getByTestId('start-service-SV-01').click();
  await expect(page.getByTestId('wizard-step')).toHaveText('1/3 กรอกข้อมูล');
  await page.getByTestId('qty-input').fill('2');
  await expect(page.getByTestId('fee-total')).toHaveText('฿40');
  await page.getByTestId('to-upload-btn').click();
  // 2
  await expect(page.getByTestId('wizard-step')).toHaveText('2/3 แนบเอกสาร');
  await expect(page.getByTestId('to-payment-btn')).toBeDisabled();
  await page.getByTestId('upload-input-id-card').setInputFiles(F('id-card.pdf'));
  await expect(page.getByTestId('file-item')).toHaveCount(1);
  await expect(page.getByTestId('file-item')).toHaveAttribute('data-doc-key', 'id-card');
  await expect(page.getByTestId('to-payment-btn')).toBeEnabled();
  await page.getByTestId('to-payment-btn').click();
  // 3
  await expect(page.getByTestId('wizard-step')).toHaveText('3/3 ชำระเงิน');
  await expect(page.getByTestId('payment-amount')).toHaveText('฿40');
  await page.getByTestId('create-qr-btn').click();
  await expect(page.getByTestId('qr-ref')).toHaveText('PP-0002');
  await expect(page.getByTestId('qr-expires')).toHaveAttribute('data-iso', '2026-12-01T09:15:00+07:00');
  await expect(page.getByTestId('payment-status')).toHaveText('รอชำระ');
  // 4
  const pay = await page.request.post('/api/test/payments/PP-0002/pay', { data: { amount: 40 } });
  expect(pay.status()).toBe(200);
  expect(await pay.json()).toMatchObject({ status: 'PAID', caseNo: 'EG-2569-000031', receiptNo: 'RC-2569-000031', duplicate: false });
  await page.getByTestId('refresh-payment-btn').click();
  await expect(page.getByTestId('payment-status')).toHaveText('ชำระแล้ว');
  await expect(page.getByTestId('submitted-case-no')).toHaveText('EG-2569-000031');
  await expect(page.getByTestId('receipt-no')).toHaveText('RC-2569-000031');
  await expect(page.getByTestId('receipt-amount')).toHaveText('฿40');
  await expect(page.getByTestId('receipt-paid-at')).toHaveAttribute('data-iso', '2026-12-01T09:00:00+07:00');
  // 5
  await page.getByTestId('go-case-btn').click();
  await expect(page).toHaveURL(/\/citizen\/cases\/EG-2569-000031$/);
  const st = page.getByTestId('case-status');
  await expect(st).toHaveText('ส่งคำขอแล้ว');
  await expect(st).toHaveAttribute('data-status', 'SUBMITTED');
  await expect(page.getByTestId('case-fee')).toHaveText('฿40');
  await expect(page.getByTestId('sla-due')).toHaveText('4 ธ.ค. 2569 16:30');
  await expect(page.getByTestId('sla-due')).toHaveAttribute('data-iso', '2026-12-04T16:30:00+07:00');
  await expect(page.getByTestId('sla-level')).toHaveText('ปกติ');
  await expect(page.getByTestId('cancel-case-btn')).toHaveCount(1);
  await expect(page.getByTestId('case-step')).toHaveCount(0);

  // เจ้าหน้าที่เห็นในคิว
  const o = await pageAsS(browser, 'off.reg1');
  await o.page.goto('/officer/queue');
  const row = qrow(o.page, 'EG-2569-000031');
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('row-owner')).toHaveText('');
  await expect(row.getByTestId('claim-btn')).toHaveCount(1);
  const list = await queueCaseNos(o.page);
  const i31 = list.indexOf('EG-2569-000031');
  expect(list[i31 - 1]).toBe('EG-2569-000030');
  expect(list[i31 + 1]).toBe('EG-2569-000016');
});

test('TC-SUBMIT-02 เอกสารบังคับครบก่อนชำระ', async ({ browser }) => {
  await RESET();
  const b = await pageAsC(browser, SOMCHAI);
  const { page, api } = b;
  const miss = (s) => `ยังขาดเอกสาร: ${s}`;
  const btn = page.getByTestId('to-payment-btn');
  const md = page.getByTestId('missing-docs');

  // SV-02
  await page.goto('/citizen/new/SV-02');
  await page.getByTestId('to-upload-btn').click();
  await expect(page.getByTestId('wizard-step')).toHaveText('2/3 แนบเอกสาร');
  await page.getByTestId('upload-input-id-card').setInputFiles(F('id-card.pdf'));
  await expect(page.getByTestId('file-item')).toHaveCount(1);
  await expect(btn).toBeDisabled();
  await expect(md).toHaveText(miss('แผนที่ตั้ง'));
  await page.getByTestId('upload-input-map').setInputFiles(F('map.pdf'));
  await expect(page.getByTestId('file-item')).toHaveCount(2);
  await expect(btn).toBeEnabled();
  await expect(md).toHaveCount(0);
  await page.locator('[data-testid="file-item"][data-name="map.pdf"]').getByTestId('file-remove-btn').click();
  await expect(page.getByTestId('file-item')).toHaveCount(1);
  await expect(btn).toBeDisabled();
  await expect(md).toHaveText(miss('แผนที่ตั้ง'));

  // SV-03 (พื้นที่ 100)
  await page.goto('/citizen/new/SV-03');
  await page.getByTestId('area-input').fill('100');
  await page.getByTestId('to-upload-btn').click();
  await expect(page.getByTestId('wizard-step')).toHaveText('2/3 แนบเอกสาร');
  await page.getByTestId('upload-input-id-card').setInputFiles(F('id-card.pdf'));
  await expect(page.getByTestId('file-item')).toHaveCount(1);
  await expect(btn).toBeDisabled();
  await expect(md).toHaveText(miss('แบบแปลน, โฉนด'));
  await page.getByTestId('upload-input-deed').setInputFiles(F('deed.pdf'));
  await expect(page.getByTestId('file-item')).toHaveCount(2);
  await expect(btn).toBeDisabled();
  await expect(md).toHaveText(miss('แบบแปลน'));
  await page.getByTestId('upload-input-plan').setInputFiles(F('plan-as-jpg.jpg'));
  await expect(page.getByTestId('upload-error')).toHaveText('แบบแปลนต้องเป็นไฟล์ PDF เท่านั้น');
  await expect(page.getByTestId('file-item')).toHaveCount(2);
  await expect(btn).toBeDisabled();
  await expect(md).toHaveText(miss('แบบแปลน'));
  await page.getByTestId('upload-input-plan').setInputFiles(F('plan.pdf'));
  await expect(page.getByTestId('file-item')).toHaveCount(3);
  await expect(btn).toBeEnabled();
  await expect(md).toHaveCount(0);

  // API
  const d = await createDraft(api, 'SV-03', { area: 100 });
  expect((await uploadApi(api, d.draftId, F('id-card.pdf'), 'id-card')).status()).toBe(201);
  expect((await uploadApi(api, d.draftId, F('deed.pdf'), 'deed')).status()).toBe(201);
  let r = await api.post(`/api/drafts/${d.draftId}/payment`);
  expect(r.status()).toBe(409);
  const j = await r.json();
  expect(j.code).toBe('MISSING_DOCS');
  expect(j.missing).toEqual(['แบบแปลน']);
  expect((await uploadApi(api, d.draftId, F('plan.pdf'), 'plan')).status()).toBe(201);
  r = await api.post(`/api/drafts/${d.draftId}/payment`);
  expect(r.status()).toBe(201);
});

test('TC-SUBMIT-03 ร่าง การลบร่าง และการยกเลิก', async ({ browser }) => {
  // ---- ส่วน A ร่าง
  await RESET();
  let b = await pageAsC(browser, SOMCHAI);
  let { page, api } = b;
  await page.goto('/citizen');
  await expect(page.getByTestId('my-case-row')).toHaveCount(10);
  const drafts = page.getByTestId('my-draft-row');
  await expect(drafts).toHaveCount(2);
  const d1 = page.locator('[data-testid="my-draft-row"][data-draft-id="DR-0001"]');
  const d2 = page.locator('[data-testid="my-draft-row"][data-draft-id="DR-0002"]');
  await expect(d1).toHaveAttribute('data-status', 'DRAFT');
  await expect(d2).toHaveAttribute('data-status', 'PENDING_PAYMENT');
  for (const t of await drafts.allTextContents()) expect(t).not.toContain('EG-');
  await d1.getByTestId('open-draft-btn').click();
  await expect(page.getByTestId('qty-input')).toHaveValue('2');
  await expect(page.getByTestId('fee-total')).toHaveText('฿40');
  await page.goto('/citizen/new/SV-01');
  await page.getByTestId('qty-input').fill('3');
  await page.getByTestId('save-draft-btn').click();
  await expect(page.getByTestId('draft-id')).toHaveText('DR-0003');
  await page.goto('/citizen');
  await expect(page.getByTestId('my-case-row')).toHaveCount(10);
  expect(await casesCount(api)).toBe(10);
  const dl = await api.get('/api/drafts');
  expect((await dl.json()).items.length).toBe(3);

  // ---- ส่วน B ยกเลิก
  await RESET();
  b = await pageAsC(browser, SOMCHAI);
  page = b.page;
  await page.goto('/citizen/cases/EG-2569-000030');
  await expect(page.getByTestId('cancel-case-btn')).toHaveCount(1);
  await page.getByTestId('cancel-case-btn').click();
  await expect(page.getByTestId('cancel-confirm-text')).toHaveText('ค่าธรรมเนียมที่ชำระแล้วไม่คืน');
  await page.getByTestId('confirm-cancel-btn').click();
  await expect(page.getByTestId('case-status')).toHaveText('ยกเลิก');
  await expect(page.getByTestId('case-status')).toHaveAttribute('data-status', 'CANCELLED');
  await expect(page.getByTestId('no-refund-note')).toHaveText('ค่าธรรมเนียมที่ชำระแล้วไม่คืน');
  await expect(page.getByTestId('cancel-case-btn')).toHaveCount(0);
  const o = await pageAsS(browser, 'off.reg1');
  await o.page.goto('/officer/queue');
  await expect(o.page.getByTestId('queue-row')).toHaveCount(16);
  await expect(qrow(o.page, 'EG-2569-000030')).toHaveCount(0);
  const ex = await pageAsS(browser, 'exec1');
  await ex.page.goto('/dashboard');
  await expect(ex.page.getByTestId('kpi-backlog')).toHaveText('20');
  await expect(ex.page.getByTestId('kpi-received')).toHaveText('3');

  // ---- ส่วน C ยกเลิกไม่ได้เมื่อมีผู้รับ
  await RESET();
  const oc = await pageAsS(browser, 'off.reg1');
  expect((await claimApi(oc.api, 'EG-2569-000030')).status()).toBe(200);
  b = await pageAsC(browser, SOMCHAI);
  page = b.page;
  api = b.api;
  await page.goto('/citizen/cases/EG-2569-000030');
  await expect(page.getByTestId('case-status')).toHaveText('กำลังตรวจสอบ');
  await expect(page.getByTestId('cancel-case-btn')).toHaveCount(0);
  let r = await api.post('/api/cases/EG-2569-000030/cancel');
  expect(r.status()).toBe(409);
  let j = await r.json();
  expect(j.code).toBe('CANNOT_CANCEL');
  expect(j.message).toBe('ยกเลิกไม่ได้ คำขอมีเจ้าหน้าที่รับเรื่องแล้ว');
  r = await api.post('/api/cases/EG-2569-000013/cancel');
  expect(r.status()).toBe(409);
  expect((await r.json()).code).toBe('CANNOT_CANCEL');

  // ---- ส่วน E ลบร่าง
  await RESET();
  b = await pageAsC(browser, SOMCHAI);
  page = b.page;
  api = b.api;
  expect((await api.delete('/api/drafts/DR-0001')).status()).toBe(204);
  expect((await api.get('/api/drafts/DR-0001')).status()).toBe(404);
  await page.goto('/citizen');
  await expect(page.getByTestId('my-draft-row')).toHaveCount(1);
  await expect(page.getByTestId('my-draft-row')).toHaveAttribute('data-draft-id', 'DR-0002');
  expect((await api.delete('/api/drafts/DR-0002')).status()).toBe(204);
  expect((await api.get('/api/payments/PP-0001')).status()).toBe(404);
  expect((await payRef(api, 'PP-0001', 500)).status()).toBe(404);

  // ---- ส่วน F ยกเลิกชนกับรับเรื่อง
  await RESET();
  const cit = await pageAsC(browser, SOMCHAI);
  const off = await pageAsS(browser, 'off.reg1');
  const [rc, rk] = await Promise.all([
    cit.api.post('/api/cases/EG-2569-000030/cancel'),
    off.api.post('/api/officer/cases/EG-2569-000030/claim'),
  ]);
  const cancelWon = rc.status() === 200 && rk.status() === 409;
  const claimWon = rk.status() === 200 && rc.status() === 409;
  expect(cancelWon || claimWon, `cancel=${rc.status()} claim=${rk.status()}`).toBe(true);
  if (cancelWon) {
    expect((await rk.json()).code).toBe('INVALID_STATE');
  } else {
    expect((await rc.json()).code).toBe('CANNOT_CANCEL');
  }
  const cj = await getCase(cit.api, 'EG-2569-000030');
  await off.page.goto('/officer/queue');
  if (cancelWon) {
    expect(cj.status).toBe('CANCELLED');
    expect(cj.owner).toBeFalsy();
    await expect(off.page.getByTestId('workload-count')).toHaveText('3');
  } else {
    expect(cj.status).toBe('IN_REVIEW');
    expect(cj.owner).toBe('off.reg1');
    await expect(off.page.getByTestId('workload-count')).toHaveText('4');
  }
});

// ================================================================ UPLOAD
test('TC-UPLOAD-01 ขนาดและจำนวนไฟล์', async ({ browser }) => {
  await RESET();
  const b = await pageAsC(browser, SOMCHAI);
  const { page, api } = b;
  await page.goto('/citizen/new/SV-01');
  await page.getByTestId('qty-input').fill('1');
  await page.getByTestId('to-upload-btn').click();
  await expect(page.getByTestId('wizard-step')).toHaveText('2/3 แนบเอกสาร');
  const idIn = page.getByTestId('upload-input-id-card');
  const items = page.getByTestId('file-item');
  const rm = async () => {
    await items.first().getByTestId('file-remove-btn').click();
    await expect(items).toHaveCount(0);
  };

  // ขนาด (UI)
  await idIn.setInputFiles(F('size-5242879.pdf'));
  await expect(items).toHaveCount(1);
  await rm();
  await idIn.setInputFiles(F('size-5242880.pdf'));
  await expect(items).toHaveCount(1);
  await expect(page.getByTestId('upload-error')).toHaveCount(0);
  await rm();
  await idIn.setInputFiles(F('size-5242881.pdf'));
  await expect(page.getByTestId('upload-error')).toHaveText('ไฟล์ใหญ่เกิน 5 MB');
  await expect(items).toHaveCount(0);

  // ขนาด (API) — ร่างใหม่ต่อไฟล์
  for (const [name, ok] of [['size-5242879.pdf', true], ['size-5242880.pdf', true], ['size-5242881.pdf', false]]) {
    const d = await createDraft(api, 'SV-01', { qty: 1 });
    const r = await uploadApi(api, d.draftId, F(name), 'id-card');
    if (ok) {
      expect(r.status(), name).toBe(201);
    } else {
      expect(r.status(), name).toBe(400);
      const j = await r.json();
      expect(j.code).toBe('FILE_TOO_LARGE');
      expect(j.message).toBe('ไฟล์ใหญ่เกิน 5 MB');
      // ไฟล์ที่ปฏิเสธไม่ถูกเก็บ → ยังขาดบัตรประชาชน
      const p = await api.post(`/api/drafts/${d.draftId}/payment`);
      expect(p.status()).toBe(409);
      expect((await p.json()).code).toBe('MISSING_DOCS');
    }
  }

  // จำนวน (UI)
  await idIn.setInputFiles(F('id-card.pdf'));
  await page.getByTestId('upload-input-extra').setInputFiles(['multi-1.pdf', 'multi-2.pdf', 'multi-3.pdf', 'multi-4.pdf'].map((n) => F(n)));
  await expect(items).toHaveCount(5);
  await page.getByTestId('upload-input-extra').setInputFiles(F('multi-5.pdf'));
  await expect(page.getByTestId('upload-error')).toHaveText('แนบได้สูงสุด 5 ไฟล์ต่อคำขอ');
  await expect(items).toHaveCount(5);
  await items.last().getByTestId('file-remove-btn').click();
  await expect(items).toHaveCount(4);
  await page.getByTestId('upload-input-extra').setInputFiles(F('multi-5.pdf'));
  await expect(items).toHaveCount(5);

  // จำนวน (API)
  const d = await createDraft(api, 'SV-01', { qty: 1 });
  expect((await uploadApi(api, d.draftId, F('id-card.pdf'), 'id-card')).status()).toBe(201);
  for (const n of ['multi-1.pdf', 'multi-2.pdf', 'multi-3.pdf', 'multi-4.pdf']) {
    expect((await uploadApi(api, d.draftId, F(n), 'extra')).status(), n).toBe(201);
  }
  const r6 = await uploadApi(api, d.draftId, F('multi-5.pdf'), 'extra');
  expect(r6.status()).toBe(400);
  expect((await r6.json()).code).toBe('FILE_COUNT');
});

test('TC-UPLOAD-02 ชนิดไฟล์จากเนื้อไฟล์', async ({ browser }) => {
  await RESET();
  const b = await pageAsC(browser, SOMCHAI);
  const { page, api } = b;
  await page.goto('/citizen/new/SV-01');
  await page.getByTestId('qty-input').fill('1');
  await page.getByTestId('to-upload-btn').click();
  await expect(page.getByTestId('wizard-step')).toHaveText('2/3 แนบเอกสาร');
  const idIn = page.getByTestId('upload-input-id-card');
  const items = page.getByTestId('file-item');

  const accepted = ['ok-id.pdf', 'real.jpg', 'real.png'];
  const rejected = [
    ['fake-text.pdf', undefined],
    ['fake-text.jpg', undefined],
    ['exe-as.png', undefined],
    ['notes.txt', undefined],
    ['fake-text.pdf', 'application/pdf'],
  ];
  for (const n of accepted) {
    await idIn.setInputFiles(F(n));
    await expect(items, n).toHaveCount(1);
    await items.first().getByTestId('file-remove-btn').click();
    await expect(items, n).toHaveCount(0);
  }
  for (const [n, mime] of rejected) {
    await idIn.setInputFiles(F(n, mime));
    await expect(page.getByTestId('upload-error'), `${n} ${mime || ''}`).toHaveText('รองรับเฉพาะไฟล์ PDF, JPG, PNG');
    await expect(items, n).toHaveCount(0);
    await page.reload();
    await page.getByTestId('qty-input').fill('1');
    await page.getByTestId('to-upload-btn').click();
    await expect(page.getByTestId('wizard-step')).toHaveText('2/3 แนบเอกสาร');
  }

  // API
  for (const n of accepted) {
    const d = await createDraft(api, 'SV-01', { qty: 1 });
    const r = await uploadApi(api, d.draftId, F(n), 'id-card');
    expect(r.status(), n).toBe(201);
  }
  for (const [n, mime] of rejected) {
    const d = await createDraft(api, 'SV-01', { qty: 1 });
    const r = await uploadApi(api, d.draftId, F(n, mime), 'id-card');
    expect(r.status(), `${n} ${mime || ''}`).toBe(400);
    expect((await r.json()).code).toBe('FILE_TYPE');
    // ไม่ถูกเก็บ → ยังขาดเอกสารบังคับ
    const p = await api.post(`/api/drafts/${d.draftId}/payment`);
    expect(p.status()).toBe(409);
    expect((await p.json()).code).toBe('MISSING_DOCS');
  }
});

// ================================================================ PAY
test('TC-PAY-01 อายุ QR 15:00', async ({ browser }) => {
  const payAt = async (clock) => {
    await RESET();
    if (clock) await CLOCK(clock);
    const api = await LOGIN_C(SOMCHAI);
    const r = await payRef(api, 'PP-0001', 500);
    return { api, r };
  };
  // รอบ 1 อายุ 5:00
  let x = await payAt(null);
  expect(x.r.status()).toBe(200);
  let j = await x.r.json();
  expect(j.status).toBe('PAID');
  expect(j.caseNo).toBe('EG-2569-000031');
  // รอบ 2 อายุ 14:59
  x = await payAt('2026-12-01T09:09:59+07:00');
  expect(x.r.status()).toBe(200);
  j = await x.r.json();
  expect(j.status).toBe('PAID');
  expect(j.caseNo).toBe('EG-2569-000031');
  // รอบ 4 อายุ 15:01
  x = await payAt('2026-12-01T09:10:01+07:00');
  expect(x.r.status()).toBe(410);
  expect((await x.r.json()).code).toBe('QR_EXPIRED');

  // รอบ 3 อายุ 15:00 พอดี
  await RESET();
  await CLOCK('2026-12-01T09:10:00+07:00');
  const b = await pageAsC(browser, SOMCHAI);
  const { page, api } = b;
  const r3 = await payRef(api, 'PP-0001', 500);
  expect(r3.status()).toBe(410);
  expect((await r3.json()).code).toBe('QR_EXPIRED');
  const g = await api.get('/api/payments/PP-0001');
  expect(g.status()).toBe(200);
  expect((await g.json()).status).toBe('EXPIRED');
  expect(await casesCount(api)).toBe(10);
  // บนจอ
  await page.goto('/citizen/new/SV-02?draft=DR-0002');
  await expect(page.getByTestId('qr-expired-msg')).toHaveText('QR หมดอายุ กรุณาสร้าง QR ใหม่');
  await expect(page.getByTestId('payment-status')).toHaveText('QR หมดอายุ');
  await expect(page.getByTestId('payment-status')).toHaveAttribute('data-status', 'EXPIRED');
  await expect(page.getByTestId('regenerate-qr-btn')).toHaveCount(1);
  await page.getByTestId('regenerate-qr-btn').click();
  await expect(page.getByTestId('qr-ref')).toHaveText('PP-0002');
  await expect(page.getByTestId('qr-expires')).toHaveAttribute('data-iso', '2026-12-01T09:25:00+07:00');
  const rp = await payRef(api, 'PP-0002', 500);
  expect(rp.status()).toBe(200);
  expect((await rp.json()).caseNo).toBe('EG-2569-000031');
});

test('TC-PAY-02 ยอดเงินและ callback ซ้ำ', async () => {
  await RESET();
  const api = await LOGIN_C(SOMCHAI);
  const d = await prepareDraft(api, 'SV-01', { qty: 1 });
  expect(d.ref).toBe('PP-0002');
  expect(d.fee).toBe(20);
  const status = async () => (await (await api.get(`/api/payments/${d.ref}`)).json()).status;

  // 1 ขาด ฿1
  let r = await payRef(api, d.ref, 19);
  expect(r.status()).toBe(422);
  expect((await r.json()).code).toBe('AMOUNT_MISMATCH');
  expect(await status()).toBe('PENDING');
  expect(await casesCount(api)).toBe(10);
  // 2 เกิน ฿1
  r = await payRef(api, d.ref, 21);
  expect(r.status()).toBe(422);
  expect(await status()).toBe('PENDING');
  // 3 ตรงยอด
  r = await payRef(api, d.ref, 20);
  expect(r.status()).toBe(200);
  let j = await r.json();
  expect(j.status).toBe('PAID');
  expect(j.caseNo).toBe('EG-2569-000031');
  expect(j.receiptNo).toBe('RC-2569-000031');
  expect(await casesCount(api)).toBe(11);
  // 4 callback ซ้ำ
  r = await payRef(api, d.ref, 20);
  expect(r.status()).toBe(200);
  j = await r.json();
  expect(j.duplicate).toBe(true);
  expect(j.caseNo).toBe('EG-2569-000031');
  expect(j.receiptNo).toBe('RC-2569-000031');
  expect(await casesCount(api)).toBe(11);
  // 5 ใบถัดไป
  const d2 = await prepareDraft(api, 'SV-01', { qty: 1 });
  r = await payRef(api, d2.ref, 20);
  expect(r.status()).toBe(200);
  j = await r.json();
  expect(j.caseNo).toBe('EG-2569-000032');
  expect(j.receiptNo).toBe('RC-2569-000032');
});

test('TC-PAY-03 ชำระพร้อมกัน เลขไม่ซ้ำ', async () => {
  await RESET();
  const a1 = await LOGIN_C(SOMCHAI);
  const a2 = await LOGIN_C(SOMYING);
  const jobs = [];
  for (let i = 0; i < 3; i++) jobs.push({ api: a1, d: await prepareDraft(a1, 'SV-01', { qty: 1 }) });
  for (let i = 0; i < 3; i++) jobs.push({ api: a2, d: await prepareDraft(a2, 'SV-01', { qty: 1 }) });
  expect(jobs.map((x) => x.d.ref).sort()).toEqual(['PP-0002', 'PP-0003', 'PP-0004', 'PP-0005', 'PP-0006', 'PP-0007']);

  const res = await Promise.all(jobs.map((x) => payRef(x.api, x.d.ref, 20)));
  const bodies = [];
  for (const r of res) {
    expect(r.status()).toBe(200);
    bodies.push(await r.json());
  }
  const want = [31, 32, 33, 34, 35, 36];
  expect(bodies.map((x) => x.caseNo).sort()).toEqual(want.map(EG));
  expect(bodies.map((x) => x.receiptNo).sort()).toEqual(want.map((n) => 'RC-2569-' + String(n).padStart(6, '0')));
  expect(new Set(bodies.map((x) => x.caseNo)).size).toBe(6);

  const mine = async (api) => (await (await api.get('/api/cases')).json()).items.map((i) => i.caseNo);
  const c1 = await mine(a1);
  const c2 = await mine(a2);
  expect(c1.length).toBe(13);
  expect(c2.length).toBe(14);
  const new1 = bodies.slice(0, 3).map((x) => x.caseNo);
  const new2 = bodies.slice(3).map((x) => x.caseNo);
  for (const c of new1) expect(c1).toContain(c);
  for (const c of new2) expect(c2).toContain(c);

  const next = await prepareDraft(a1, 'SV-01', { qty: 1 });
  const rn = await payRef(a1, next.ref, 20);
  expect(rn.status()).toBe(200);
  expect((await rn.json()).caseNo).toBe('EG-2569-000037');
});

test('TC-PAY-04 เลขคำขอข้ามปี 2569 → 2570', async ({ browser }) => {
  await RESET();
  const b = await newPage(browser);
  const { page, api } = b;
  // 1
  await CLOCK('2026-12-31T23:58:00+07:00');
  await LOGIN_C(SOMCHAI, api);
  const d1 = await prepareDraft(api, 'SV-01', { qty: 1 });
  const g1 = await (await api.get(`/api/payments/${d1.ref}`)).json();
  expect(g1.status).toBe('PENDING');
  expect(g1.caseNo).toBeFalsy();
  expect(await casesCount(api)).toBe(10);
  // 2
  await CLOCK('2026-12-31T23:59:00+07:00');
  await LOGIN_C(SOMCHAI, api);
  let r = await payRef(api, d1.ref, 20);
  expect(r.status()).toBe(200);
  let j = await r.json();
  expect(j.caseNo).toBe('EG-2569-000031');
  expect(j.receiptNo).toBe('RC-2569-000031');
  await page.goto(`/citizen/new/SV-01?draft=${d1.draftId}`);
  await expect(page.getByTestId('receipt-paid-at')).toHaveAttribute('data-iso', '2026-12-31T23:59:00+07:00');
  // 3
  await CLOCK('2027-01-01T00:00:00+07:00');
  await LOGIN_C(SOMCHAI, api);
  const d2 = await prepareDraft(api, 'SV-01', { qty: 1 });
  r = await payRef(api, d2.ref, 20);
  expect(r.status()).toBe(200);
  j = await r.json();
  expect(j.caseNo).toBe('EG-2570-000001');
  expect(j.receiptNo).toBe('RC-2570-000001');
  // 4
  const d3 = await prepareDraft(api, 'SV-01', { qty: 1 });
  r = await payRef(api, d3.ref, 20);
  expect(r.status()).toBe(200);
  expect((await r.json()).caseNo).toBe('EG-2570-000002');
  // 5
  const c = await getCase(api, 'EG-2569-000031');
  expect(c.caseNo).toBe('EG-2569-000031');
});

// ================================================================ QUEUE
test('TC-QUEUE-01 ลำดับคิวและขอบเขตแผนก', async ({ browser }) => {
  await RESET();
  const r1 = await pageAsS(browser, 'off.reg1');
  const p = r1.page;
  await p.goto('/officer/queue');
  await expect(p.getByTestId('queue-filter')).toHaveValue('all');
  await expect(p.getByTestId('queue-row')).toHaveCount(17);
  const want = [20, 22, 24, 23, 25, 26, 13, 15, 27, 28, 29, 30, 16, 18, 19, 12, 21].map(EG);
  expect(await queueCaseNos(p)).toEqual(want);
  const lv = await p.getByTestId('row-sla-level').allTextContents();
  expect(lv.slice(0, 3).map((s) => s.trim())).toEqual(['เกินกำหนด', 'ใกล้ครบกำหนด', 'ใกล้ครบกำหนด']);
  const masks = await p.getByTestId('row-id-masked').allTextContents();
  expect(masks.length).toBe(17);
  for (const m of masks) expect(m.trim()).toMatch(/^X-XXXX-XXXXX-\d{2}-\d$/);
  // claim-btn 4 ปุ่ม
  await expect(p.getByTestId('claim-btn')).toHaveCount(4);
  for (const n of [24, 28, 29, 30]) await expect(qrow(p, EG(n)).getByTestId('claim-btn')).toHaveCount(1);
  await expect(qrow(p, EG(19)).getByTestId('claim-btn')).toHaveCount(0);
  // filter
  await p.getByTestId('queue-filter').selectOption('unclaimed');
  await expect(p.getByTestId('queue-row')).toHaveCount(4);
  expect(await queueCaseNos(p)).toEqual([24, 28, 29, 30].map(EG));
  await p.getByTestId('queue-filter').selectOption('mine');
  await expect(p.getByTestId('queue-row')).toHaveCount(3);
  expect(await queueCaseNos(p)).toEqual([20, 22, 23].map(EG));
  await expect(p.getByTestId('workload-count')).toHaveText('3');
  // ไม่อยู่ในคิว
  await p.getByTestId('queue-filter').selectOption('all');
  await expect(p.getByTestId('queue-row')).toHaveCount(17);
  for (const n of [17, 11, 14]) await expect(qrow(p, EG(n))).toHaveCount(0);

  // off.reg2
  const r2 = await pageAsS(browser, 'off.reg2');
  await r2.page.goto('/officer/queue');
  await r2.page.getByTestId('queue-filter').selectOption('mine');
  await expect(r2.page.getByTestId('queue-row')).toHaveCount(9);
  expect(await queueCaseNos(r2.page)).toEqual([25, 26, 13, 15, 27, 16, 18, 12, 21].map(EG));
  await expect(r2.page.getByTestId('workload-count')).toHaveText('9');

  // off.works1
  const w = await pageAsS(browser, 'off.works1');
  await w.page.goto('/officer/queue');
  await expect(w.page.getByTestId('queue-row')).toHaveCount(1);
  expect(await queueCaseNos(w.page)).toEqual([EG(10)]);

  // head1
  const h = await pageAsS(browser, 'head1');
  await h.page.goto('/officer/queue');
  await expect(h.page.getByTestId('queue-row')).toHaveCount(18);
  const hl = await queueCaseNos(h.page);
  const dec3 = [10, 23, 25, 26].map(EG);
  expect(hl.filter((c) => dec3.includes(c))).toEqual(dec3);
  await expect(h.page.getByTestId('claim-btn')).toHaveCount(0);
});

test('TC-QUEUE-02 รับเรื่องซ้อน (พร้อมกันและต่อกัน)', async ({ browser }) => {
  const C28 = 'EG-2569-000028';
  const C29 = 'EG-2569-000029';
  // ---- ส่วน 1 พร้อมกัน (UI)
  await RESET();
  const A = await pageAsS(browser, 'off.reg1');
  const B = await pageAsS(browser, 'off.reg2');
  await A.page.goto('/officer/queue');
  await B.page.goto('/officer/queue');
  await expect(qrow(A.page, C28)).toBeVisible();
  await expect(qrow(B.page, C28)).toBeVisible();
  const isClaim = (r) => /\/claim$/.test(r.url()) && r.request().method() === 'POST';
  const wa = A.page.waitForResponse(isClaim);
  const wb = B.page.waitForResponse(isClaim);
  await Promise.all([
    qrow(A.page, C28).getByTestId('claim-btn').click(),
    qrow(B.page, C28).getByTestId('claim-btn').click(),
  ]);
  const [ra, rb] = await Promise.all([wa, wb]);
  expect([ra.status(), rb.status()].sort()).toEqual([200, 409]);
  const winner = ra.status() === 200 ? { ctx: A, user: 'off.reg1' } : { ctx: B, user: 'off.reg2' };
  const loser = ra.status() === 200 ? B : A;
  await expect(loser.page.getByTestId('action-error')).toHaveText('มีเจ้าหน้าที่รับเรื่องนี้แล้ว');
  const lj = await (ra.status() === 200 ? rb : ra).json();
  expect(lj.code).toBe('ALREADY_CLAIMED');
  const wrow = qrow(winner.ctx.page, C28);
  await expect(wrow).toHaveAttribute('data-owner', winner.user);
  await expect(wrow.getByTestId('row-owner')).not.toHaveText('');
  const cj = await getCase(winner.ctx.api, C28);
  expect(cj.owner).toBe(winner.user);
  expect(cj.status).toBe('IN_REVIEW');
  const audit = await LOGIN_S('audit1');
  expect(await auditCount(audit, 'CLAIM', C28)).toBe(1);

  // ---- ส่วน 2 พร้อมกัน (API ×10)
  await RESET();
  const o1 = await LOGIN_S('off.reg1');
  const o2 = await LOGIN_S('off.reg2');
  const calls = [];
  for (let i = 0; i < 5; i++) calls.push({ user: 'off.reg1', p: claimApi(o1, C29) });
  for (let i = 0; i < 5; i++) calls.push({ user: 'off.reg2', p: claimApi(o2, C29) });
  const rs = await Promise.all(calls.map((c) => c.p));
  const codes = rs.map((r) => r.status());
  expect(codes.filter((c) => c === 200).length).toBe(1);
  expect(codes.filter((c) => c === 409).length).toBe(9);
  let win = null;
  for (let i = 0; i < rs.length; i++) {
    if (rs[i].status() === 200) win = calls[i].user;
    else expect((await rs[i].json()).code).toBe('ALREADY_CLAIMED');
  }
  const c2 = await getCase(o1, C29);
  expect(c2.owner).toBe(win);
  const audit2 = await LOGIN_S('audit1');
  expect(await auditCount(audit2, 'CLAIM', C29)).toBe(1);

  // ---- ส่วน 3 ต่อกัน
  await RESET();
  const b1 = await pageAsS(browser, 'off.reg1');
  const b2 = await pageAsS(browser, 'off.reg2');
  let r = await claimApi(b1.api, C29);
  expect(r.status()).toBe(200);
  expect((await r.json()).owner).toBe('off.reg1');
  r = await claimApi(b2.api, C29);
  expect(r.status()).toBe(409);
  const j = await r.json();
  expect(j.code).toBe('ALREADY_CLAIMED');
  expect(j.message).toBe('มีเจ้าหน้าที่รับเรื่องนี้แล้ว');
  expect((await getCase(b2.api, C29)).owner).toBe('off.reg1');
  await b2.page.goto('/officer/queue');
  await expect(b2.page.getByTestId('workload-count')).toHaveText('9');
  r = await claimApi(b1.api, C29);
  expect(r.status()).toBe(409);
  const audit3 = await LOGIN_S('audit1');
  expect(await auditCount(audit3, 'CLAIM', C29)).toBe(1);
});

test('TC-QUEUE-03 งานในมือสูงสุด 10', async ({ browser }) => {
  await RESET();
  let o = await pageAsS(browser, 'off.reg2');
  let p = o.page;
  await p.goto('/officer/queue');
  const wl = () => p.getByTestId('workload-count');
  // 1-2
  await expect(wl()).toHaveText('9');
  await qrow(p, EG(28)).getByTestId('claim-btn').click();
  await expect(wl()).toHaveText('10');
  // 3
  await qrow(p, EG(29)).getByTestId('claim-btn').click();
  await expect(p.getByTestId('action-error')).toHaveText('รับงานได้สูงสุด 10 เรื่อง');
  await expect(wl()).toHaveText('10');
  await expect(qrow(p, EG(29))).toHaveAttribute('data-status', 'SUBMITTED');
  await expect(qrow(p, EG(29))).toHaveAttribute('data-owner', '');
  let r = await claimApi(o.api, EG(29));
  expect(r.status()).toBe(409);
  expect((await r.json()).code).toBe('WORKLOAD_LIMIT');
  // 4 อนุมัติ 000025 → APPROVED ไม่นับ
  await p.goto('/officer/cases/' + EG(25));
  await p.getByTestId('approve-btn').click();
  await expect(p.getByTestId('case-status')).toHaveAttribute('data-status', 'APPROVED');
  await p.goto('/officer/queue');
  await expect(wl()).toHaveText('9');
  // 5
  await qrow(p, EG(29)).getByTestId('claim-btn').click();
  await expect(wl()).toHaveText('10');
  // 6 off.reg1 ไม่ติดเพดาน
  const o1 = await LOGIN_S('off.reg1');
  expect((await claimApi(o1, EG(30))).status()).toBe(200);

  // 7 RESET · return 000025
  await RESET();
  o = await pageAsS(browser, 'off.reg2');
  p = o.page;
  await p.goto('/officer/cases/' + EG(25));
  await p.getByTestId('return-btn').click();
  await p.getByTestId('return-reason').fill('xxxxxxxxxx');
  await p.getByTestId('return-submit').click();
  await expect(p.getByTestId('case-status')).toHaveText('รอแก้ไขเอกสาร');
  await p.goto('/officer/queue');
  await expect(wl()).toHaveText('8');
  // 8
  await qrow(p, EG(28)).getByTestId('claim-btn').click();
  await expect(wl()).toHaveText('9');
  await qrow(p, EG(29)).getByTestId('claim-btn').click();
  await expect(wl()).toHaveText('10');
  // 9 สมหญิงส่งแก้
  const cit = await pageAsC(browser, SOMYING);
  await cit.page.goto('/citizen/cases/' + EG(25));
  await cit.page.getByTestId('submit-fix-btn').click();
  await expect(cit.page.getByTestId('case-status')).toHaveText('กำลังตรวจสอบ');
  await p.goto('/officer/cases/' + EG(25));
  await expect(p.getByTestId('case-owner')).toHaveText('off.reg2');
  await p.goto('/officer/queue');
  await expect(wl()).toHaveText('11');
  // 10
  r = await claimApi(o.api, EG(30));
  expect(r.status()).toBe(409);
  const j = await r.json();
  expect(j.code).toBe('WORKLOAD_LIMIT');
  expect(j.message).toBe('รับงานได้สูงสุด 10 เรื่อง');
  await p.reload();
  await expect(wl()).toHaveText('11');
});

// ================================================================ SLA
test('TC-SLA-01 กำหนดเสร็จตามตารางวันที่', async ({ browser }) => {
  const rows = [
    ['a', 'SV-01', '2026-12-01T09:00:00+07:00', '2026-12-04T16:30:00+07:00', { qty: 3 }],
    ['b', 'SV-01', '2026-12-01T16:29:00+07:00', '2026-12-04T16:30:00+07:00', {}],
    ['c', 'SV-01', '2026-12-01T16:30:00+07:00', '2026-12-08T16:30:00+07:00', {}],
    ['d', 'SV-01', '2026-12-04T10:00:00+07:00', '2026-12-11T16:30:00+07:00', {}],
    ['e', 'SV-01', '2026-12-05T10:00:00+07:00', '2026-12-14T16:30:00+07:00', {}],
    ['f', 'SV-02', '2026-12-01T09:00:00+07:00', '2026-12-17T16:30:00+07:00', {}],
    ['g', 'SV-03', '2026-12-01T09:00:00+07:00', '2026-12-24T16:30:00+07:00', { area: 100 }],
    ['h', 'SV-01', '2026-12-29T10:00:00+07:00', '2027-01-05T16:30:00+07:00', {}],
    ['i', 'SV-01', '2026-12-31T23:59:00+07:00', '2027-01-07T16:30:00+07:00', {}],
  ];
  for (const [id, service, time, due, opts] of rows) {
    await RESET();
    const b = await newPage(browser);
    const n = await NEW_PAID({ service, time, api: b.api, ...opts });
    expect(n.caseNo, `แถว ${id}`).toBe('EG-2569-000031');
    const c = await getCase(b.api, n.caseNo);
    expect(c.dueAt, `แถว ${id} dueAt`).toBe(due);
    await b.page.goto(`/citizen/cases/${n.caseNo}`);
    await expect(b.page.getByTestId('sla-due'), `แถว ${id}`).toHaveAttribute('data-iso', due);
    await expect(b.page.getByTestId('sla-due'), `แถว ${id}`).toHaveText(thDate(due));
  }
  // ข้อความตามตารางโดยตรง
  expect(thDate('2026-12-04T16:30:00+07:00')).toBe('4 ธ.ค. 2569 16:30');
  expect(thDate('2027-01-07T16:30:00+07:00')).toBe('7 ม.ค. 2570 16:30');
});

test('TC-SLA-02 หยุดนับ SLA ระหว่างรอแก้ไข', async ({ browser }) => {
  // ---- ส่วน 1
  await RESET();
  let cit = await newPage(browser);
  const n = await NEW_PAID({ time: '2026-12-01T09:00:00+07:00', api: cit.api });
  expect(n.caseNo).toBe('EG-2569-000031');
  expect((await getCase(cit.api, n.caseNo)).dueAt).toBe('2026-12-04T16:30:00+07:00');
  await CLOCK('2026-12-02T11:00:00+07:00');
  const off = await pageAsS(browser, 'off.reg1');
  expect((await claimApi(off.api, n.caseNo)).status()).toBe(200);
  const rr = await returnApi(off.api, n.caseNo);
  expect(rr.status()).toBe(200);
  await LOGIN_C(SOMCHAI, cit.api);
  await cit.page.goto(`/citizen/cases/${n.caseNo}`);
  await expect(cit.page.getByTestId('case-status')).toHaveText('รอแก้ไขเอกสาร');
  await expect(cit.page.getByTestId('sla-level')).toHaveText('หยุดนับ');
  await expect(cit.page.getByTestId('sla-level')).toHaveAttribute('data-level', 'paused');
  await expect(cit.page.getByTestId('fix-deadline')).toHaveAttribute('data-iso', '2026-12-09T11:00:00+07:00');
  await CLOCK('2026-12-03T10:00:00+07:00');
  await LOGIN_C(SOMCHAI, cit.api);
  await cit.page.goto(`/citizen/cases/${n.caseNo}`);
  await cit.page.getByTestId('submit-fix-btn').click();
  await expect(cit.page.getByTestId('case-status')).toHaveText('กำลังตรวจสอบ');
  await expect(cit.page.getByTestId('sla-due')).toHaveAttribute('data-iso', '2026-12-08T16:30:00+07:00');
  await expect(cit.page.getByTestId('sla-due')).toHaveText('8 ธ.ค. 2569 16:30');
  await expect(cit.page.getByTestId('sla-level')).toHaveText('ปกติ');
  expect((await getCase(cit.api, n.caseNo)).dueAt).toBe('2026-12-08T16:30:00+07:00');
  await LOGIN_S('off.reg1', off.api);
  await off.page.goto(`/officer/cases/${n.caseNo}`);
  await expect(off.page.getByTestId('case-owner')).toHaveText('off.reg1');

  // ---- ส่วน 2 seed …000017 ส่งแก้ 1 ธ.ค. 09:00
  await RESET();
  cit = await pageAsC(browser, SOMCHAI);
  await cit.page.goto('/citizen/cases/' + EG(17));
  await expect(cit.page.getByTestId('sla-level')).toHaveText('หยุดนับ');
  await expect(cit.page.getByTestId('sla-due')).toHaveAttribute('data-iso', '2026-11-27T16:30:00+07:00');
  await cit.page.getByTestId('submit-fix-btn').click();
  await expect(cit.page.getByTestId('case-status')).toHaveText('กำลังตรวจสอบ');
  await expect(cit.page.getByTestId('sla-due')).toHaveAttribute('data-iso', '2026-12-01T16:30:00+07:00');
  await expect(cit.page.getByTestId('sla-level')).toHaveText('ใกล้ครบกำหนด');
  const o2 = await LOGIN_S('off.reg1');
  expect((await getCase(o2, EG(17))).owner).toBe('off.reg1');

  // ---- ส่วน 3 ส่งแก้ 4 ธ.ค. 10:00
  await RESET();
  await CLOCK('2026-12-04T10:00:00+07:00');
  cit = await pageAsC(browser, SOMCHAI);
  await cit.page.goto('/citizen/cases/' + EG(17));
  await cit.page.getByTestId('submit-fix-btn').click();
  await expect(cit.page.getByTestId('case-status')).toHaveText('กำลังตรวจสอบ');
  await expect(cit.page.getByTestId('sla-due')).toHaveAttribute('data-iso', '2026-12-04T16:30:00+07:00');
  await expect(cit.page.getByTestId('sla-level')).toHaveText('ใกล้ครบกำหนด');

  // ---- ส่วน 4 ตีกลับและส่งแก้วันเดียวกัน
  await RESET();
  const p4 = await newPage(browser);
  const n4 = await NEW_PAID({ time: '2026-12-01T09:00:00+07:00', api: p4.api });
  expect((await getCase(p4.api, n4.caseNo)).dueAt).toBe('2026-12-04T16:30:00+07:00');
  await CLOCK('2026-12-02T09:00:00+07:00');
  const off4 = await LOGIN_S('off.reg1');
  expect((await claimApi(off4, n4.caseNo)).status()).toBe(200);
  expect((await returnApi(off4, n4.caseNo)).status()).toBe(200);
  await CLOCK('2026-12-02T15:00:00+07:00');
  await LOGIN_C(SOMCHAI, p4.api);
  const rs4 = await p4.api.post(`/api/cases/${n4.caseNo}/resubmit`);
  expect(rs4.status()).toBe(200);
  expect((await getCase(p4.api, n4.caseNo)).dueAt).toBe('2026-12-04T16:30:00+07:00');

  // ---- ส่วน 5 คร่อมสุดสัปดาห์/วันหยุด ส่งแก้หลัง 16:30
  await RESET();
  const p5 = await newPage(browser);
  const n5 = await NEW_PAID({ time: '2026-12-01T09:00:00+07:00', api: p5.api });
  expect((await getCase(p5.api, n5.caseNo)).dueAt).toBe('2026-12-04T16:30:00+07:00');
  await CLOCK('2026-12-04T10:00:00+07:00');
  const off5 = await LOGIN_S('off.reg1');
  expect((await claimApi(off5, n5.caseNo)).status()).toBe(200);
  expect((await returnApi(off5, n5.caseNo)).status()).toBe(200);
  await CLOCK('2026-12-08T17:00:00+07:00');
  await LOGIN_C(SOMCHAI, p5.api);
  await p5.page.goto(`/citizen/cases/${n5.caseNo}`);
  await p5.page.getByTestId('submit-fix-btn').click();
  await expect(p5.page.getByTestId('case-status')).toHaveText('กำลังตรวจสอบ');
  await expect(p5.page.getByTestId('sla-due')).toHaveAttribute('data-iso', '2026-12-08T16:30:00+07:00');
  await expect(p5.page.getByTestId('sla-level')).toHaveText('เกินกำหนด');
  expect((await getCase(p5.api, n5.caseNo)).dueAt).toBe('2026-12-08T16:30:00+07:00');
});

test('TC-SLA-03 ระดับเตือน ปกติ/ใกล้/เกิน', async ({ browser }) => {
  const TXT = { normal: 'ปกติ', near: 'ใกล้ครบกำหนด', overdue: 'เกินกำหนด', paused: 'หยุดนับ', closed: 'ปิดแล้ว' };
  const checkCase = async (b, idNo, caseNo, level, label) => {
    await LOGIN_C(idNo, b.api);
    await b.page.goto(`/citizen/cases/${caseNo}`);
    await expect(b.page.getByTestId('sla-level'), label).toHaveText(TXT[level]);
    await expect(b.page.getByTestId('sla-level'), label).toHaveAttribute('data-level', level);
    expect((await getCase(b.api, caseNo)).slaLevel, label).toBe(level);
  };

  // ---- ส่วน A คำขอใหม่ กำหนด ศ. 4 ธ.ค. 16:30
  await RESET();
  const a = await newPage(browser);
  const n = await NEW_PAID({ time: '2026-12-01T09:00:00+07:00', api: a.api });
  expect(n.caseNo).toBe('EG-2569-000031');
  const tableA = [
    ['2026-12-01T09:00:00+07:00', 'normal'],
    ['2026-12-02T09:00:00+07:00', 'normal'],
    ['2026-12-03T09:00:00+07:00', 'near'],
    ['2026-12-04T16:30:00+07:00', 'near'],
    ['2026-12-04T16:30:01+07:00', 'overdue'],
    ['2026-12-04T16:31:00+07:00', 'overdue'],
    ['2026-12-05T10:00:00+07:00', 'overdue'],
  ];
  for (const [clk, lvl] of tableA) {
    await CLOCK(clk);
    await checkCase(a, SOMCHAI, n.caseNo, lvl, `A ${clk}`);
  }

  // ---- ส่วน B seed …000016 (ปิติ) กำหนด อ. 8 ธ.ค. 16:30
  await RESET();
  const bb = await newPage(browser);
  const tableB = [
    ['2026-12-03T09:00:00+07:00', 'normal'],
    ['2026-12-04T09:00:00+07:00', 'near'],
    ['2026-12-08T16:30:00+07:00', 'near'],
    ['2026-12-08T16:31:00+07:00', 'overdue'],
  ];
  for (const [clk, lvl] of tableB) {
    await CLOCK(clk);
    await checkCase(bb, PITI, EG(16), lvl, `B ${clk}`);
  }

  // ---- ส่วน C seed ที่ 09:00
  await RESET();
  const o = await pageAsS(browser, 'off.reg1');
  await o.page.goto('/officer/queue');
  const want = { 20: 'overdue', 22: 'near', 24: 'near', 25: 'normal' };
  for (const [k, lvl] of Object.entries(want)) {
    const row = qrow(o.page, EG(+k));
    await expect(row.getByTestId('row-sla-level'), `…0000${k}`).toHaveText(TXT[lvl]);
    await expect(row, `…0000${k}`).toHaveAttribute('data-sla-level', lvl);
  }
  await o.page.goto('/officer/cases/' + EG(20));
  await expect(o.page.getByTestId('sla-level')).toHaveText('เกินกำหนด');
  const cS = await pageAsC(browser, SOMCHAI);
  await cS.page.goto('/citizen/cases/' + EG(17));
  await expect(cS.page.getByTestId('sla-level')).toHaveText('หยุดนับ');
  const cY = await pageAsC(browser, SOMYING);
  await cY.page.goto('/citizen/cases/' + EG(1));
  await expect(cY.page.getByTestId('sla-level')).toHaveText('ปิดแล้ว');
  await expect(cY.page.getByTestId('sla-level')).toHaveAttribute('data-level', 'closed');

  await CLOCK('2026-12-01T16:30:00+07:00');
  await LOGIN_S('off.reg1', o.api);
  await o.page.goto('/officer/queue');
  await expect(qrow(o.page, EG(22)).getByTestId('row-sla-level')).toHaveText('ใกล้ครบกำหนด');
  await CLOCK('2026-12-01T16:31:00+07:00');
  await LOGIN_S('off.reg1', o.api);
  await o.page.goto('/officer/queue');
  await expect(qrow(o.page, EG(22)).getByTestId('row-sla-level')).toHaveText('เกินกำหนด');
});
