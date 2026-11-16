// Black-box tests authored exclusively from TEST-PLAN, CONTRACT and TEST-DATA.
// Run all reset-based spec files with workers: 1 (reset invalidates every session).
// Test dependencies: @playwright/test, @axe-core/playwright, exceljs, pdf-parse.
const { test: base, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const NOW = '2026-12-01T09:00:00+07:00';
const SOMCHAI = '1101700123456';
const SOMYING = '3100600987659';
const MANA = '5500400111221';
const REASON = 'xxxxxxxxxx';
const REASON_ERROR = 'กรุณากรอกเหตุผลอย่างน้อย 10 ตัวอักษร';
const MASK = /^X-XXXX-XXXXX-\d{2}-\d$/;
const caseNo = n => `EG-2569-${String(n).padStart(6, '0')}`;
const apiCase = n => `/api/cases/${caseNo(n)}`;
const officerApi = (n, action) => `/api/officer/cases/${caseNo(n)}/${action}`;
const officerPage = n => `/officer/cases/${caseNo(n)}`;
const citizenPage = n => `/citizen/cases/${caseNo(n)}`;
const by = (page, id) => page.getByTestId(id);
const row = (page, id, attribute, value) => page.locator(`[data-testid="${id}"][data-${attribute}="${value}"]`);
const pdf = () => {
  const head = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n');
  const tail = Buffer.from('\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  return Buffer.concat([head, Buffer.alloc(1024 - head.length - tail.length, 32), tail]);
};
const uploadFile = (name = 'id-card.pdf') => ({ name, mimeType: 'application/pdf', buffer: pdf() });

async function json(response, status = 200, subset) {
  expect(response.status(), `${response.url()}: ${await response.text()}`).toBe(status);
  expect(response.headers()['content-type']).toContain('application/json');
  const body = await response.json();
  if (subset) expect(body).toMatchObject(subset);
  return body;
}
async function error(response, status, code, message) {
  const body = await json(response, status);
  if (code) expect(body.code).toBe(code);
  if (message) expect(body.message).toBe(message);
  return body;
}
async function post(actor, url, data, expected) {
  return json(await actor.api.post(url, data === undefined ? {} : { data }), 200, expected);
}
async function statusUI(page, status, text) {
  await expect(by(page, 'case-status')).toHaveAttribute('data-status', status);
  await expect(by(page, 'case-status')).toHaveText(text);
}
async function buttons(page, counts) {
  for (const [id, count] of Object.entries(counts)) await expect(by(page, id)).toHaveCount(count);
}
async function clickAction(page, id) {
  await by(page, id).click();
}

class World {
  constructor(browser, control) { this.browser = browser; this.control = control; this.contexts = []; this.actors = new Map(); }
  async reset() {
    for (const context of this.contexts) await context.close();
    this.contexts = []; this.actors.clear();
    expect(await json(await this.control.post('/api/test/reset'))).toEqual({ ok: true, now: NOW });
  }
  async clock(now) { expect(await json(await this.control.put('/api/test/clock', { data: { now } }))).toEqual({ now }); }
  async anonymous() {
    const context = await this.browser.newContext({ baseURL: BASE_URL, acceptDownloads: true });
    this.contexts.push(context);
    return { context, api: context.request, page: await context.newPage() };
  }
  async actor(username) {
    if (this.actors.has(username)) return this.actors.get(username);
    const actor = await this.anonymous();
    if (/^\d{13}$/.test(username)) {
      await json(await actor.api.post('/api/auth/thaid/start', { data: { idNo: username } }), 200, { status: 'OTP_SENT' });
      await json(await actor.api.post('/api/auth/thaid/verify', { data: { idNo: username, otp: '123456' } }));
    } else {
      await json(await actor.api.post('/api/auth/staff/login', { data: { username, password: 'Test@1234' } }));
    }
    this.actors.set(username, actor);
    return actor;
  }
  async paid({ fee = 20, qty = 1, time = NOW } = {}) {
    await this.clock(time);
    const citizen = await this.actor(SOMCHAI);
    const draft = await json(await citizen.api.post('/api/drafts', { data: { serviceId: 'SV-01', qty } }), 201, { fee });
    await json(await citizen.api.post(`/api/drafts/${draft.draftId}/files`, {
      multipart: { docKey: 'id-card', file: uploadFile() },
    }), 201);
    const payment = await json(await citizen.api.post(`/api/drafts/${draft.draftId}/payment`), 201, { amount: fee });
    await json(await this.control.post(`/api/test/payments/${payment.ref}/pay`, { data: { amount: fee } }), 200, { status: 'PAID' });
    return json(await citizen.api.get(`/api/payments/${payment.ref}`), 200, { status: 'PAID' });
  }
}

// Automatic fixture: the first HTTP operation of EVERY TC is RESET.
const test = base.extend({
  world: async ({ browser, playwright }, use) => {
    const control = await playwright.request.newContext({ baseURL: BASE_URL });
    const world = new World(browser, control);
    try { await world.reset(); await use(world); }
    finally { for (const context of world.contexts) await context.close(); await control.dispose(); }
  },
});
test.setTimeout(120000);

async function notifications(actor, expectedPairs, count = expectedPairs.length) {
  const body = await json(await actor.api.get('/api/notifications'));
  expect(body.items).toHaveLength(count);
  const pairs = body.items.map(item => `${item.caseNo}:${item.level}`);
  expect(new Set(pairs).size).toBe(pairs.length);
  for (const pair of expectedPairs) expect(pairs).toContain(pair);
  await actor.page.goto('/notifications');
  await expect(by(actor.page, 'bell-count')).toHaveText(String(count));
  await expect(by(actor.page, 'noti-item')).toHaveCount(count);
  for (const item of body.items) {
    const text = `คำขอ ${item.caseNo} ${item.level === 'near' ? 'ใกล้ครบกำหนด' : 'เกินกำหนด'}`;
    expect(item.text).toBe(text);
    await expect(actor.page.locator(`[data-testid="noti-item"][data-case-no="${item.caseNo}"][data-level="${item.level}"]`)).toHaveText(text);
  }
  if (!count) await expect(by(actor.page, 'noti-empty')).toHaveText('ไม่มีแจ้งเตือน');
  return body.items;
}
const pairs = (numbers, level) => numbers.map(n => `${caseNo(n)}:${level}`);
async function initialNoti(world) {
  const reg1 = await world.actor('off.reg1');
  const reg2 = await world.actor('off.reg2');
  const head = await world.actor('head1');
  const works = await world.actor('off.works1');
  await notifications(reg1, [...pairs([24, 22], 'near'), ...pairs([20], 'overdue')]);
  await notifications(reg2, pairs([24], 'near'));
  await notifications(head, pairs([20], 'overdue'));
  await notifications(works, []);
  await world.clock('2026-12-01T16:31:00+07:00');
  await notifications(reg1, [...pairs([24, 22], 'near'), ...pairs([20, 22], 'overdue')]);
  await notifications(head, pairs([20, 22], 'overdue'));
  await notifications(reg2, pairs([24], 'near'));
  return { reg1, reg2, head, works };
}

test('TC-NOTI-01 ผู้รับแจ้งเตือนตามระดับ', async ({ world }) => { await initialNoti(world); });

test('TC-NOTI-02 ไม่แจ้งซ้ำ ข้ามระดับ และขั้นรออนุมัติ/รอออกเอกสาร', async ({ world }) => {
  const { reg1, head } = await initialNoti(world);
  for (let i = 0; i < 3; i++) {
    await reg1.page.goto('/notifications'); await head.page.goto('/notifications');
    await json(await reg1.api.get('/api/notifications')); await json(await head.api.get('/api/notifications'));
  }
  for (let i = 0; i < 2; i++) { await reg1.page.goto('/officer/queue'); await head.page.goto('/officer/queue'); }
  await notifications(reg1, [], 4); await notifications(head, [], 2);
  await world.reset(); await world.clock('2026-12-05T10:00:00+07:00');
  const fixtures = [
    ['off.reg1', [20, 22, 23, 24, 28, 29, 30], []],
    ['off.reg2', [13, 15, 24, 25, 26, 27, 28, 29, 30], [16]],
    ['off.works1', [10], []],
    ['head1', [10, 13, 14, 15, 20, 22, 23, 24, 25, 26, 27, 28, 29, 30], [11]],
  ];
  for (const [user, overdue, near] of fixtures) await notifications(await world.actor(user), [...pairs(overdue, 'overdue'), ...pairs(near, 'near')]);
  await world.reset(); await world.clock('2026-12-04T09:00:00+07:00');
  const h = await world.actor('head1'); const r1 = await world.actor('off.reg1'); const r2 = await world.actor('off.reg2');
  async function levels(actor, n, expected) {
    const items = (await json(await actor.api.get('/api/notifications'))).items.filter(item => item.caseNo === caseNo(n));
    expect(items.map(item => item.level).sort()).toEqual([...expected].sort());
    await actor.page.goto('/notifications');
    await expect(row(actor.page, 'noti-item', 'case-no', caseNo(n))).toHaveCount(expected.length);
  }
  await levels(h, 14, ['near']); await levels(r1, 14, []); await levels(r2, 14, []);
  await world.clock('2026-12-04T16:31:00+07:00');
  await levels(h, 14, ['near', 'overdue']); await levels(r1, 14, []); await levels(r2, 14, []);
  await world.clock('2026-12-08T09:00:00+07:00');
  await levels(r1, 19, ['near']); await levels(r2, 19, []); await levels(h, 19, []);
  await world.clock('2026-12-09T16:31:00+07:00');
  await levels(r1, 19, ['near', 'overdue']); await levels(h, 19, ['overdue']);
});

async function issue(world, n = 25, username = 'off.reg2', approve = true) {
  const actor = await world.actor(username);
  if (approve) await post(actor, `${apiCase(n)}/approve`, undefined, { status: 'APPROVED' });
  const document = await post(actor, officerApi(n, 'issue'), undefined, { status: 'COMPLETED' });
  expect(document.verifyCode).toMatch(/^[A-Z0-9]{8}$/);
  return document;
}
async function dashboard(actor, expected, period = '2026-12', service = 'ALL') {
  const body = await json(await actor.api.get(`/api/dashboard?period=${period}&service=${service}`), 200, expected);
  await actor.page.goto('/dashboard');
  await by(actor.page, 'period-select').selectOption(period);
  await by(actor.page, 'service-select').selectOption(service);
  const ids = { received: 'received', closed: 'closed', backlog: 'backlog', overdue: 'overdue' };
  for (const [key, id] of Object.entries(ids)) if (key in expected) await expect(by(actor.page, `kpi-${id}`)).toHaveText(String(expected[key]));
  if ('ontimePct' in expected) await expect(by(actor.page, 'kpi-ontime-pct')).toHaveText(expected.ontimePct === null ? '–' : `${expected.ontimePct.toFixed(1)}%`);
  return body;
}
async function pdfResponse(response, filename, ascii) {
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('application/pdf');
  if (filename) expect(response.headers()['content-disposition']).toContain(filename);
  const bytes = await response.body();
  expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
  if (ascii) expect(bytes.toString('latin1')).toContain(ascii);
  return bytes;
}

test('TC-WORKFLOW-01 SV-01 อนุมัติและออกเอกสาร', async ({ world }) => {
  const r2 = await world.actor('off.reg2'); const p = r2.page;
  await p.goto(officerPage(25)); await statusUI(p, 'IN_REVIEW', 'กำลังตรวจสอบ');
  await buttons(p, { 'approve-btn': 1, 'return-btn': 1, 'reject-btn': 1, 'forward-btn': 0, 'issue-btn': 0 });
  await expect(by(p, 'case-fee')).toHaveText('฿60');
  await error(await (await world.actor('off.reg1')).api.post(`${apiCase(26)}/approve`), 403, 'FORBIDDEN');
  await clickAction(p, 'approve-btn'); await statusUI(p, 'APPROVED', 'อนุมัติ');
  await buttons(p, { 'issue-btn': 1, 'approve-btn': 0 });
  await clickAction(p, 'issue-btn'); await statusUI(p, 'COMPLETED', 'เสร็จสิ้น');
  await expect(by(p, 'doc-no')).toHaveText('DOC-2569-000002');
  await expect(by(p, 'verify-code')).toHaveText(/^[A-Z0-9]{8}$/);
  await expect(by(p, 'closed-at')).toHaveAttribute('data-iso', NOW);
  await expect(by(p, 'sla-level')).toHaveText('ปิดแล้ว');
  const citizen = await world.actor(SOMYING); await citizen.page.goto(citizenPage(25));
  await statusUI(citizen.page, 'COMPLETED', 'เสร็จสิ้น');
  await expect(by(citizen.page, 'download-doc-btn')).toHaveCount(1);
  await pdfResponse(await citizen.api.get('/api/documents/DOC-2569-000002/pdf'), 'DOC-2569-000002.pdf', 'docNo=DOC-2569-000002 caseNo=EG-2569-000025');
  await dashboard(await world.actor('exec1'), { closed: 1, onTime: 1, received: 3, backlog: 20 });
});

test('TC-WORKFLOW-02 SV-02 ผ่านหัวหน้า', async ({ world }) => {
  const r2 = await world.actor('off.reg2'); await r2.page.goto(officerPage(13));
  await buttons(r2.page, { 'approve-btn': 0, 'forward-btn': 1, 'forward-target': 0 });
  await clickAction(r2.page, 'forward-btn'); await statusUI(r2.page, 'PENDING_APPROVAL', 'รออนุมัติ');
  await r2.page.goto('/officer/queue'); await expect(by(r2.page, 'workload-count')).toHaveText('8');
  await expect(row(r2.page, 'queue-row', 'case-no', caseNo(13))).toHaveCount(0);
  const h = await world.actor('head1'); await h.page.goto('/head/approvals');
  await expect(by(h.page, 'approval-row')).toHaveCount(3);
  expect(await by(h.page, 'approval-row').evaluateAll(rows => rows.map(r => r.dataset.caseNo))).toEqual([13, 14, 11].map(caseNo));
  await row(h.page, 'approval-row', 'case-no', caseNo(13)).getByTestId('approval-open').click();
  await buttons(h.page, { 'approve-btn': 1, 'reject-btn': 1, 'issue-btn': 0 });
  await clickAction(h.page, 'approve-btn'); await statusUI(h.page, 'APPROVED', 'อนุมัติ');
  await buttons(h.page, { 'issue-btn': 0 });
  const r1 = await world.actor('off.reg1'); await r1.page.goto(officerPage(13)); await buttons(r1.page, { 'issue-btn': 0 });
  await error(await r1.api.post(officerApi(13, 'issue')), 403, 'FORBIDDEN');
  await r2.page.goto(officerPage(13)); await clickAction(r2.page, 'issue-btn');
  await statusUI(r2.page, 'COMPLETED', 'เสร็จสิ้น'); await expect(by(r2.page, 'doc-no')).toHaveText('DOC-2569-000002');
  const code = await by(r2.page, 'verify-code').innerText();
  const anon = await world.anonymous(); await anon.page.goto(`/verify/${code}`); await expect(by(anon.page, 'verify-signer')).toHaveText('หัวหน้าฝ่าย');
  await world.reset();
  const seedIssuer = await world.actor('off.reg1'); await seedIssuer.page.goto(officerPage(19)); await clickAction(seedIssuer.page, 'issue-btn');
  await statusUI(seedIssuer.page, 'COMPLETED', 'เสร็จสิ้น'); await expect(by(seedIssuer.page, 'doc-no')).toHaveText('DOC-2569-000002');
  const anon2 = await world.anonymous(); await anon2.page.goto(`/verify/${await by(seedIssuer.page, 'verify-code').innerText()}`);
  await expect(by(anon2.page, 'verify-signer')).toHaveText('หัวหน้าฝ่าย');
});

test('TC-WORKFLOW-03 SV-03 สามขั้นตอน', async ({ world }) => {
  const r2 = await world.actor('off.reg2'); await r2.page.goto(officerPage(12));
  await expect(by(r2.page, 'case-step')).toHaveText('ขั้นตอน 1/3 · ฝ่ายทะเบียน');
  await expect(by(r2.page, 'case-fee')).toHaveText('฿1,010'); await buttons(r2.page, { 'forward-btn': 1 });
  await clickAction(r2.page, 'forward-btn'); await statusUI(r2.page, 'IN_REVIEW', 'กำลังตรวจสอบ');
  await expect(by(r2.page, 'case-step')).toHaveText('ขั้นตอน 2/3 · ฝ่ายโยธา');
  await expect(by(r2.page, 'case-owner')).toHaveText('ยังไม่มีผู้รับ');
  await r2.page.goto('/officer/queue'); await expect(by(r2.page, 'workload-count')).toHaveText('8');
  await expect(by(r2.page, 'queue-row')).toHaveCount(16); await expect(row(r2.page, 'queue-row', 'case-no', caseNo(12))).toHaveCount(0);
  const works = await world.actor('off.works1'); await works.page.goto('/officer/queue');
  expect(await by(works.page, 'queue-row').evaluateAll(rows => rows.map(r => r.dataset.caseNo))).toEqual([10, 12].map(caseNo));
  await expect(by(works.page, 'claim-btn')).toHaveCount(2);
  await error(await (await world.actor('off.reg1')).api.post(officerApi(12, 'claim')), 403, 'FORBIDDEN');
  await post(works, officerApi(12, 'claim'), undefined, { owner: 'off.works1' });
  await works.page.goto(officerPage(12)); await expect(by(works.page, 'case-owner')).toHaveText('off.works1');
  await clickAction(works.page, 'forward-btn'); await statusUI(works.page, 'PENDING_APPROVAL', 'รออนุมัติ');
  await expect(by(works.page, 'case-step')).toHaveText('ขั้นตอน 3/3 · หัวหน้าฝ่าย');
  const h = await world.actor('head1'); await h.page.goto('/head/approvals'); await expect(by(h.page, 'approval-row')).toHaveCount(3);
  await row(h.page, 'approval-row', 'case-no', caseNo(12)).getByTestId('approval-open').click();
  await clickAction(h.page, 'approve-btn'); await statusUI(h.page, 'APPROVED', 'อนุมัติ');
  await works.page.goto(officerPage(12)); await buttons(works.page, { 'issue-btn': 0 });
  await r2.page.goto(officerPage(12)); await buttons(r2.page, { 'issue-btn': 1 }); await clickAction(r2.page, 'issue-btn');
  await statusUI(r2.page, 'COMPLETED', 'เสร็จสิ้น');
  const anon = await world.anonymous(); await anon.page.goto(`/verify/${await by(r2.page, 'verify-code').innerText()}`);
  await expect(by(anon.page, 'verify-signer')).toHaveText('หัวหน้าฝ่าย');
});

async function returnTwice(world, n, user) {
  const officer = await world.actor(user); const citizen = await world.actor(SOMCHAI);
  await json(await officer.api.get(apiCase(n)), 200, { status: 'IN_REVIEW', returnCount: 0 });
  for (let count = 1; count <= 2; count++) {
    await post(officer, officerApi(n, 'return'), { reason: REASON }, { status: 'NEED_FIX', returnCount: count });
    await officer.page.goto(officerPage(n)); await statusUI(officer.page, 'NEED_FIX', 'รอแก้ไขเอกสาร');
    await expect(by(officer.page, 'return-count')).toHaveText(String(count));
    await post(citizen, `${apiCase(n)}/resubmit`, undefined, { status: 'IN_REVIEW' });
    await json(await officer.api.get(apiCase(n)), 200, { status: 'IN_REVIEW', owner: user, returnCount: count });
  }
  await officer.page.goto(officerPage(n));
  return officer;
}
test('TC-WORKFLOW-04 ตีกลับสูงสุด 2 ครั้งและผลหลังครบ', async ({ world }) => {
  let r = await returnTwice(world, 20, 'off.reg1');
  await buttons(r.page, { 'return-btn': 0, 'approve-btn': 1, 'reject-btn': 1 });
  await error(await r.api.post(officerApi(20, 'return'), { data: { reason: REASON } }), 409, 'RETURN_LIMIT', 'ตีกลับได้สูงสุด 2 ครั้ง');
  await json(await r.api.get(apiCase(20)), 200, { status: 'IN_REVIEW', returnCount: 2 });
  await world.reset(); r = await world.actor('off.reg1'); await r.page.goto(officerPage(23));
  await expect(by(r.page, 'return-count')).toHaveText('2');
  await buttons(r.page, { 'return-btn': 0, 'approve-btn': 1, 'reject-btn': 1 });
  await error(await r.api.post(officerApi(23, 'return'), { data: { reason: REASON } }), 409, 'RETURN_LIMIT');
  await json(await r.api.get(apiCase(23)), 200, { status: 'IN_REVIEW', returnCount: 2 });
  await world.reset(); r = await returnTwice(world, 13, 'off.reg2');
  await buttons(r.page, { 'return-btn': 0, 'approve-btn': 0, 'reject-btn': 0, 'forward-btn': 1 });
  await error(await r.api.post(`${apiCase(13)}/reject`, { data: { reason: REASON } }), 403, 'FORBIDDEN');
  await by(r.page, 'forward-note').fill('ส่งต่อให้หัวหน้าพิจารณา'); await clickAction(r.page, 'forward-btn');
  await statusUI(r.page, 'PENDING_APPROVAL', 'รออนุมัติ');
  const auditor = await world.actor('audit1'); await auditFilter(auditor, { event: 'FORWARD' }, 1);
  await expect(by(auditor.page, 'audit-detail')).toContainText('ส่งต่อให้หัวหน้าพิจารณา');
  const h = await world.actor('head1'); await h.page.goto(officerPage(13)); await buttons(h.page, { 'approve-btn': 1, 'reject-btn': 1 });
});

test('TC-WORKFLOW-05 เหตุผลอย่างน้อย 10 ตัวอักษร', async ({ world }) => {
  const r1 = await world.actor('off.reg1'); await r1.page.goto(officerPage(20)); await clickAction(r1.page, 'return-btn');
  for (const reason of ['xxxxxxxxx', '          ']) {
    await by(r1.page, 'return-reason').fill(reason); await clickAction(r1.page, 'return-submit');
    await expect(by(r1.page, 'return-reason-error')).toHaveText(REASON_ERROR);
    await error(await r1.api.post(officerApi(20, 'return'), { data: { reason } }), 400, 'REASON_TOO_SHORT');
    await json(await r1.api.get(apiCase(20)), 200, { status: 'IN_REVIEW' });
  }
  await by(r1.page, 'return-reason').fill(REASON); await clickAction(r1.page, 'return-submit');
  await statusUI(r1.page, 'NEED_FIX', 'รอแก้ไขเอกสาร');
  const c = await world.actor(SOMCHAI); await c.page.goto(citizenPage(20)); await expect(by(c.page, 'return-reason-display')).toHaveText(REASON);
  await world.reset(); const r2 = await world.actor('off.reg2'); await r2.page.goto(officerPage(26)); await clickAction(r2.page, 'reject-btn');
  await by(r2.page, 'reject-reason').fill('xxxxxxxxx'); await clickAction(r2.page, 'reject-submit');
  await expect(by(r2.page, 'reject-reason-error')).toHaveText(REASON_ERROR);
  await error(await r2.api.post(`${apiCase(26)}/reject`, { data: { reason: 'xxxxxxxxx' } }), 400, 'REASON_TOO_SHORT');
  await by(r2.page, 'reject-reason').fill(REASON); await clickAction(r2.page, 'reject-submit'); await statusUI(r2.page, 'REJECTED', 'ไม่อนุมัติ');
  await expect(by(r2.page, 'closed-at')).toHaveAttribute('data-iso', NOW); await expect(by(r2.page, 'sla-level')).toHaveText('ปิดแล้ว');
  const owner = await world.actor(SOMCHAI); await owner.page.goto(citizenPage(26)); await expect(by(owner.page, 'no-refund-note')).toHaveText('ค่าธรรมเนียมที่ชำระแล้วไม่คืน');
  await dashboard(await world.actor('exec1'), { closed: 1, onTime: 1 });
  await world.reset(); const h = await world.actor('head1');
  await error(await h.api.post(`${apiCase(11)}/reject`, { data: { reason: 'xxxxxxxxx' } }), 400, 'REASON_TOO_SHORT');
  await post(h, `${apiCase(11)}/reject`, { reason: REASON }, { status: 'REJECTED' });
});

test('TC-WORKFLOW-06 เวลาแก้ไข 168 ชั่วโมง', async ({ world }) => {
  let c = await world.actor(SOMCHAI); await c.page.goto(citizenPage(17));
  await statusUI(c.page, 'NEED_FIX', 'รอแก้ไขเอกสาร');
  await expect(by(c.page, 'return-reason-display')).toHaveText('ชื่อในเอกสารไม่ตรงกับบัตร กรุณาแก้ไข');
  await expect(by(c.page, 'fix-deadline')).toHaveText('4 ธ.ค. 2569 14:00');
  await expect(by(c.page, 'fix-deadline')).toHaveAttribute('data-iso', '2026-12-04T14:00:00+07:00'); await buttons(c.page, { 'submit-fix-btn': 1 });
  await world.reset(); await world.clock('2026-12-04T13:59:00+07:00'); c = await world.actor(SOMCHAI);
  await c.page.goto(citizenPage(17)); await expect(by(c.page, 'submit-fix-btn')).toBeEnabled();
  await post(c, `${apiCase(17)}/resubmit`, undefined, { status: 'IN_REVIEW' }); await c.page.reload(); await statusUI(c.page, 'IN_REVIEW', 'กำลังตรวจสอบ');
  await world.reset(); await world.clock('2026-12-04T14:00:00+07:00'); c = await world.actor(SOMCHAI);
  await c.page.goto(citizenPage(17)); await statusUI(c.page, 'CANCELLED', 'ยกเลิก'); await buttons(c.page, { 'submit-fix-btn': 0 });
  await expect(by(c.page, 'no-refund-note')).toHaveText('ค่าธรรมเนียมที่ชำระแล้วไม่คืน');
  await error(await c.api.post(`${apiCase(17)}/resubmit`), 409);
  await expect(by(c.page, 'case-timeline').locator('[data-testid="timeline-item"][data-iso="2026-12-04T14:00:00+07:00"]')).toHaveCount(1);
  await dashboard(await world.actor('exec1'), { backlog: 20 });
});

const VERIFY_TEXT = { VALID: 'เอกสารถูกต้อง', EXPIRED: 'เอกสารหมดอายุ', TAMPERED: 'ลายเซ็นไม่ถูกต้อง', NOT_FOUND: 'ไม่พบเอกสาร' };
async function verify(anon, code, result, values = {}) {
  const http = result === 'NOT_FOUND' ? 404 : 200;
  expect((await anon.page.goto(`/verify/${code}`)).status()).toBe(http);
  await expect(by(anon.page, 'verify-result')).toHaveText(VERIFY_TEXT[result]);
  await expect(by(anon.page, 'verify-result')).toHaveAttribute('data-result', result);
  const body = await json(await anon.api.get(`/api/verify/${code}`), http, { result });
  if (['TAMPERED', 'NOT_FOUND'].includes(result)) {
    expect(body).toEqual({ result });
    await buttons(anon.page, { 'verify-doc-no': 0, 'verify-applicant': 0 });
  }
  for (const [id, value] of Object.entries(values)) {
    if (id === 'issued' || id === 'expires') await expect(by(anon.page, `verify-${id}`)).toHaveAttribute('data-iso', value);
    else await expect(by(anon.page, `verify-${id}`)).toHaveText(value);
  }
  return body;
}

test('TC-DOC-01 ออกเอกสารและข้อมูลใน PDF', async ({ world }) => {
  const doc = await issue(world); expect(doc.docNo).toBe('DOC-2569-000002');
  const citizen = await world.actor(SOMYING);
  await pdfResponse(await citizen.api.get(`/api/documents/${doc.docNo}/pdf`), `${doc.docNo}.pdf`,
    `docNo=DOC-2569-000002 caseNo=EG-2569-000025 verify=${doc.verifyCode} validUntil=2027-02-28`);
  const anon = await world.anonymous();
  const body = await verify(anon, doc.verifyCode, 'VALID', {
    'doc-no': doc.docNo, applicant: 'สมหญิง ร***', service: 'SV-01 ขอหนังสือรับรอง',
    issued: NOW, expires: '2027-02-28', signer: 'เจ้าหน้าที่ทะเบียน 2',
  });
  expect(body).toMatchObject({ validUntil: '2027-02-28', issuedAt: NOW });
  await citizen.page.goto(citizenPage(25)); await expect(by(citizen.page, 'doc-qr')).toHaveAttribute('data-url', `${BASE_URL}/verify/${doc.verifyCode}`);
  expect((await (await world.actor(SOMCHAI)).api.get(`/api/documents/${doc.docNo}/pdf`)).status()).toBe(404);
  const r2 = await world.actor('off.reg2'); await error(await r2.api.post(officerApi(25, 'issue')), 409, 'INVALID_STATE');
  expect((await issue(world, 26)).docNo).toBe('DOC-2569-000003');
});

test('TC-DOC-02 ตรวจเอกสารสาธารณะและปิดบังข้อมูล', async ({ world }) => {
  const anon = await world.anonymous();
  const body = await verify(anon, 'K7M2Q9XA', 'VALID', {
    'doc-no': 'DOC-2569-000001', applicant: 'สมชาย ใ***', service: 'SV-01 ขอหนังสือรับรอง',
    issued: '2026-11-05T10:00:00+07:00', expires: '2027-02-02', signer: 'เจ้าหน้าที่ทะเบียน 1',
  });
  expect(body.applicantMasked).toBe('สมชาย ใ***');
  expect(new URL(anon.page.url()).pathname).toBe('/verify/K7M2Q9XA');
  const text = await anon.page.locator('body').innerText(); expect(text).not.toContain('ใจดี'); expect(text).not.toContain(SOMCHAI);
  await verify(anon, 'ZZZZZZZZ', 'NOT_FOUND');
});

test('TC-DOC-03 หมดอายุ 90 วัน รายปี ปีอธิกสุรทิน และลายเซ็น', async ({ world }) => {
  async function boundary(code, expiry, validAt, expiredAt) {
    const anon = await world.anonymous();
    await world.clock(validAt); await verify(anon, code, 'VALID', { expires: expiry });
    await world.clock(expiredAt); await verify(anon, code, 'EXPIRED', { expires: expiry });
  }
  const c1 = await issue(world);
  await boundary(c1.verifyCode, '2027-02-28', '2027-02-28T23:59:00+07:00', '2027-03-01T00:00:00+07:00');
  await world.reset(); const c2 = await issue(world, 19, 'off.reg1', false);
  await boundary(c2.verifyCode, '2027-11-30', '2027-11-30T23:59:00+07:00', '2027-12-01T00:00:00+07:00');
  await world.reset(); await boundary('K7M2Q9XA', '2027-02-02', '2027-02-02T23:59:00+07:00', '2027-02-03T00:00:00+07:00');
  await world.reset(); await world.clock('2028-02-29T10:00:00+07:00');
  const leap1 = await issue(world); const leap2 = await issue(world, 19, 'off.reg1', false);
  expect(leap1.docNo).toBe('DOC-2571-000001'); expect(leap2.docNo).toBe('DOC-2571-000002');
  await boundary(leap1.verifyCode, '2028-05-28', '2028-05-28T23:59:00+07:00', '2028-05-29T00:00:00+07:00');
  await boundary(leap2.verifyCode, '2029-02-27', '2029-02-27T23:59:00+07:00', '2029-02-28T00:00:00+07:00');
  await world.reset(); expect(await json(await world.control.post('/api/test/documents/DOC-2569-000001/tamper'))).toEqual({ ok: true });
  const anon = await world.anonymous(); await verify(anon, 'K7M2Q9XA', 'TAMPERED');
  await world.clock('2027-03-01T00:00:00+07:00'); await verify(anon, 'K7M2Q9XA', 'TAMPERED');
});

test('TC-PDPA-01 ปิดบังเลขบัตรบนจอ', async ({ world }) => {
  const r2 = await world.actor('off.reg2'); await r2.page.goto('/officer/queue');
  const masked = await by(r2.page, 'row-id-masked').allTextContents(); expect(masked.length).toBe(17);
  for (const value of masked) expect(value.trim()).toMatch(MASK);
  await expect(row(r2.page, 'queue-row', 'case-no', caseNo(25)).getByTestId('row-id-masked')).toHaveText('X-XXXX-XXXXX-65-9');
  await expect(row(r2.page, 'queue-row', 'case-no', caseNo(26)).getByTestId('row-id-masked')).toHaveText('X-XXXX-XXXXX-45-6');
  for (const user of ['off.reg2', 'head1']) {
    const actor = await world.actor(user); await actor.page.goto(officerPage(25));
    await expect(by(actor.page, 'applicant-id')).toHaveText('X-XXXX-XXXXX-65-9');
    const html = await actor.page.content(); expect(html).not.toContain(SOMYING); expect(html).not.toContain('3-1006-00987-65-9');
  }
  for (const [user, n, full] of [[SOMYING, 25, '3-1006-00987-65-9'], [SOMCHAI, 20, '1-1017-00123-45-6']]) {
    const actor = await world.actor(user); await actor.page.goto(citizenPage(n)); await expect(by(actor.page, 'case-id-full')).toHaveText(full);
  }
});

function assertMaskedJSON(body) {
  const text = JSON.stringify(body);
  expect(text).not.toMatch(/\d{13}/); expect(text).not.toMatch(/\d-\d{4}-\d{5}-\d{2}-\d/);
  for (const id of [SOMYING, SOMCHAI, '1909900555015']) expect(text).not.toContain(id);
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    expect(Object.keys(value)).not.toContain('idNo');
    if ('idMasked' in value) expect(value.idMasked).toMatch(MASK);
    for (const child of Object.values(value)) walk(child);
  }
  walk(body);
}
test('TC-PDPA-02 API เจ้าหน้าที่ไม่มีเลขบัตรเต็มหรือ key idNo', async ({ world }) => {
  for (const user of ['off.reg1', 'head1']) {
    const actor = await world.actor(user);
    for (const url of ['/api/officer/queue?filter=all', apiCase(25), apiCase(26), apiCase(20), '/api/notifications', `${apiCase(25)}/files`]) {
      const body = await json(await actor.api.get(url)); assertMaskedJSON(body);
      if (url.startsWith('/api/officer/queue')) for (const item of body.items) expect(item.idMasked).toMatch(MASK);
      if ([apiCase(25), apiCase(26), apiCase(20)].includes(url)) expect(body.idMasked).toMatch(MASK);
    }
  }
});

async function auditFilter(actor, filters = {}, count) {
  const query = new URLSearchParams(filters).toString();
  const body = await json(await actor.api.get(`/api/audit?${query}`));
  if (count !== undefined) { expect(body.count).toBe(count); expect(body.items).toHaveLength(count); }
  await actor.page.goto('/audit');
  await by(actor.page, 'audit-filter-actor').fill(filters.actor || '');
  await by(actor.page, 'audit-filter-event').selectOption(filters.event || '');
  await by(actor.page, 'audit-filter-from').fill(filters.from || '');
  await by(actor.page, 'audit-filter-to').fill(filters.to || '');
  await by(actor.page, 'audit-apply-btn').click();
  await expect(by(actor.page, 'audit-count')).toHaveText(String(body.count));
  await expect(by(actor.page, 'audit-row')).toHaveCount(body.count);
  return body;
}
test('TC-PDPA-03 แสดงเลขเต็มต้องมีเหตุผลและ Audit', async ({ world }) => {
  const r2 = await world.actor('off.reg2'); await r2.page.goto(officerPage(25)); await clickAction(r2.page, 'show-full-id-btn');
  for (const reason of ['', '          ']) {
    await by(r2.page, 'unmask-reason').fill(reason); await clickAction(r2.page, 'unmask-submit');
    await expect(by(r2.page, 'unmask-error')).toHaveText('กรุณากรอกเหตุผล'); await buttons(r2.page, { 'full-id': 0 });
    await error(await r2.api.post(officerApi(25, 'unmask'), { data: { reason } }), 400, 'REASON_REQUIRED');
  }
  await by(r2.page, 'unmask-reason').fill('ตรวจสอบตัวตนซ้ำ'); await clickAction(r2.page, 'unmask-submit');
  await expect(by(r2.page, 'full-id')).toHaveText('3-1006-00987-65-9');
  await r2.page.reload(); await expect(by(r2.page, 'applicant-id')).toHaveText('X-XXXX-XXXXX-65-9'); await buttons(r2.page, { 'full-id': 0 });
  const auditor = await world.actor('audit1'); const body = await auditFilter(auditor, { event: 'UNMASK' }, 1);
  expect(body.items[0]).toMatchObject({ username: 'off.reg2', role: 'officer', event: 'UNMASK', caseNo: caseNo(25), time: NOW });
  const auditRow = by(auditor.page, 'audit-row'); await expect(auditRow).toHaveAttribute('data-actor', 'off.reg2');
  for (const [id, text] of Object.entries({ 'audit-role': 'officer', 'audit-case-no': caseNo(25), 'audit-event': 'UNMASK' })) await expect(auditRow.getByTestId(id)).toHaveText(text);
  await expect(auditRow.getByTestId('audit-detail')).toContainText('ตรวจสอบตัวตนซ้ำ'); await expect(auditRow.getByTestId('audit-time')).toHaveAttribute('data-iso', NOW);
  for (const user of ['exec1', 'audit1', SOMYING]) await error(await (await world.actor(user)).api.post(officerApi(25, 'unmask'), { data: { reason: 'x' } }), 403, 'FORBIDDEN');
});

function noPersonal(text) {
  expect(text).not.toMatch(/\d{13}/); expect(text).not.toMatch(/0\d{9}/);
  for (const name of ['สมชาย', 'สมหญิง', 'ปิติ', 'มานะ']) expect(text).not.toContain(name);
}
test('TC-DASH-01 Dashboard ตัวเลขเริ่มต้นและบริการ', async ({ world }) => {
  const exec = await world.actor('exec1');
  const body = await dashboard(exec, { received: 3, closed: 0, onTime: 0, ontimePct: null, backlog: 21, overdue: 1 });
  await expect(by(exec.page, 'period-select')).toHaveValue('2026-12'); await expect(by(exec.page, 'service-select')).toHaveValue('ALL');
  expect(body.workload).toHaveLength(3);
  await expect(by(exec.page, 'workload-row')).toHaveCount(3);
  for (const [username, count] of [['off.reg1', 3], ['off.reg2', 9], ['off.works1', 0]]) {
    expect(body.workload).toContainEqual({ username, count });
    await expect(row(exec.page, 'workload-row', 'username', username).getByTestId('workload-value')).toHaveText(String(count));
  }
  noPersonal(await exec.page.locator('body').innerText());
  for (const [service, received, backlog, overdue] of [['SV-01', 3, 11, 1], ['SV-02', 0, 7, 0], ['SV-03', 0, 3, 0]]) {
    await dashboard(exec, { received, closed: 0, onTime: 0, ontimePct: null, backlog, overdue }, '2026-12', service);
  }
});

test('TC-DASH-02 Dashboard ย้อนหลังและรายปี', async ({ world }) => {
  const exec = await world.actor('exec1');
  const rows = [
    ['2026-10', 'ALL', 1, 1, 1, 100], ['2026-11', 'ALL', 26, 7, 6, 85.7],
    ['2026-11', 'SV-01', 12, 3, 3, 100], ['2026-11', 'SV-02', 10, 3, 2, 66.7], ['2026-11', 'SV-03', 4, 1, 1, 100],
    ['2026', 'ALL', 30, 8, 7, 87.5], ['2026', 'SV-01', 16, 4, 4, 100], ['2026', 'SV-02', 10, 3, 2, 66.7], ['2026', 'SV-03', 4, 1, 1, 100],
  ];
  for (const [period, service, received, closed, onTime, ontimePct] of rows) {
    const [backlog, overdue] = { ALL: [21, 1], 'SV-01': [11, 1], 'SV-02': [7, 0], 'SV-03': [3, 0] }[service];
    await dashboard(exec, { received, closed, onTime, ontimePct, backlog, overdue }, period, service);
  }
});

async function download(page, id) {
  const [file] = await Promise.all([page.waitForEvent('download'), by(page, id).click()]);
  expect(await file.failure()).toBeNull();
  return { name: file.suggestedFilename(), buffer: await fs.readFile(await file.path()) };
}
async function xlsxText(buffer, expected) {
  const ExcelJS = require('exceljs'); const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0]; expect(sheet).toBeTruthy();
  expect([sheet.getCell('A1').text, sheet.getCell('B1').text]).toEqual(['ตัวชี้วัด', 'ค่า']);
  const labels = ['รับเรื่อง', 'ปิดงาน', 'ทันกำหนด %', 'งานคงค้าง', 'เกินกำหนดคงค้าง'];
  for (let i = 0; i < labels.length; i++) {
    expect(sheet.getCell(i + 2, 1).text).toBe(labels[i]); expect(sheet.getCell(i + 2, 2).text).toBe(expected[i]);
  }
  const all = []; for (const ws of workbook.worksheets) ws.eachRow(r => r.eachCell(c => all.push(c.text)));
  return all.join('\n');
}
async function parsedPDF(buffer) {
  const module = require('pdf-parse');
  if (typeof module === 'function') return (await module(buffer)).text;
  if (typeof module.default === 'function') return (await module.default(buffer)).text;
  const parser = new module.PDFParse({ data: buffer });
  try { return (await parser.getText()).text; } finally { await parser.destroy(); }
}
test('TC-DASH-03 ส่งออก Excel/PDF เท่าหน้าจอและไม่มีข้อมูลส่วนบุคคล', async ({ world }) => {
  const exec = await world.actor('exec1'); await dashboard(exec, { received: 26, closed: 7, ontimePct: 85.7, backlog: 21, overdue: 1 }, '2026-11');
  const november = await download(exec.page, 'export-xlsx-btn'); expect(november.name).toMatch(/\.xlsx$/);
  noPersonal(await xlsxText(november.buffer, ['26', '7', '85.7%', '21', '1']));
  const responsePromise = exec.page.waitForResponse(r => r.url().includes('/api/dashboard/export') && r.url().includes('format=pdf'));
  const report = await download(exec.page, 'export-pdf-btn'); const response = await responsePromise;
  expect(response.headers()['content-type']).toContain('application/pdf'); expect(report.name).toMatch(/\.pdf$/);
  const reportText = await parsedPDF(report.buffer); expect(reportText).toContain('kpi received=26 closed=7 ontime=85.7% backlog=21 overdue=1'); noPersonal(reportText);
  await dashboard(exec, { received: 3, closed: 0, ontimePct: null, backlog: 21, overdue: 1 });
  const december = await download(exec.page, 'export-xlsx-btn'); noPersonal(await xlsxText(december.buffer, ['3', '0', '–', '21', '1']));
  const auditor = await world.actor('audit1'); const body = await auditFilter(auditor, { event: 'EXPORT' }, 3);
  for (const item of body.items) expect(item).toMatchObject({ username: 'exec1', role: 'executive' });
  expect(body.items.map(item => item.detail).sort()).toEqual(['xlsx 2026-11 ALL', 'pdf 2026-11 ALL', 'xlsx 2026-12 ALL'].sort());
});

test('TC-DASH-04 ทันกำหนดก่อนขอบ ที่ขอบ และเกินหนึ่งวินาที', async ({ world }) => {
  await world.clock('2026-12-03T16:00:00+07:00');
  const r1 = await world.actor('off.reg1'); const r2 = await world.actor('off.reg2'); const exec = await world.actor('exec1');
  await post(r2, `${apiCase(25)}/approve`, undefined, { status: 'APPROVED' }); await post(r1, `${apiCase(23)}/approve`, undefined, { status: 'APPROVED' });
  for (const [actor, n, action, time, closed, onTime] of [
    [r2, 25, 'issue', '2026-12-03T16:29:59+07:00', 1, 1],
    [r2, 26, 'reject', '2026-12-03T16:30:00+07:00', 2, 2],
    [r1, 23, 'issue', '2026-12-03T16:30:01+07:00', 3, 2],
  ]) {
    await world.clock(time);
    await post(actor, action === 'issue' ? officerApi(n, action) : `${apiCase(n)}/reject`, action === 'reject' ? { reason: REASON } : undefined);
    await actor.page.goto(officerPage(n)); await expect(by(actor.page, 'closed-at')).toHaveAttribute('data-iso', time);
    await json(await actor.api.get(apiCase(n)), 200, { closedAt: time });
    await dashboard(exec, { closed, onTime });
  }
  await expect(by(exec.page, 'kpi-backlog')).toHaveText('18');
});

function csvRows(text) {
  const rows = []; let record = []; let cell = ''; let quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { record.push(cell); cell = ''; }
    else if (c === '\n' && !quoted) { record.push(cell.replace(/\r$/, '')); rows.push(record); record = []; cell = ''; }
    else cell += c;
  }
  if (cell || record.length) { record.push(cell.replace(/\r$/, '')); rows.push(record); }
  return rows;
}

test('TC-AUDIT-01 เหตุการณ์ ฟิลด์ การเรียง กรอง และ CSV', async ({ world }) => {
  const r2 = await world.actor('off.reg2'); await post(r2, officerApi(28, 'claim'));
  const r1 = await world.actor('off.reg1'); await post(r1, officerApi(20, 'return'), { reason: REASON });
  await post(r2, officerApi(13, 'forward'));
  const h = await world.actor('head1'); await post(h, `${apiCase(13)}/approve`);
  await post(r2, `${apiCase(25)}/approve`); await post(r2, officerApi(25, 'issue'));
  await post(r2, `${apiCase(26)}/reject`, { reason: REASON }); await post(r2, officerApi(25, 'unmask'), { reason: 'ตรวจสอบตัวตนซ้ำ' });
  const exec = await world.actor('exec1'); expect((await exec.api.get('/api/dashboard/export?format=xlsx&period=2026-12&service=ALL')).status()).toBe(200);
  const admin = await world.actor('admin1'); await json(await admin.api.put('/api/admin/services/SV-01', { data: { fee: 25, sla: 3 } }));
  const auditor = await world.actor('audit1'); const body = await auditFilter(auditor, {}, 16);
  const counts = { STAFF_LOGIN: 6, CLAIM: 1, RETURN: 1, FORWARD: 1, APPROVE: 2, ISSUE: 1, REJECT: 1, UNMASK: 1, EXPORT: 1, ADMIN_CHANGE: 1 };
  for (const [event, count] of Object.entries(counts)) expect(body.items.filter(item => item.event === event)).toHaveLength(count);
  const wanted = [
    ['CLAIM', 'off.reg2', 'officer', 28, 'SUBMITTED', 'IN_REVIEW', ''],
    ['RETURN', 'off.reg1', 'officer', 20, 'IN_REVIEW', 'NEED_FIX', REASON],
    ['FORWARD', 'off.reg2', 'officer', 13, 'IN_REVIEW', 'PENDING_APPROVAL', ''],
    ['APPROVE', 'head1', 'head', 13, 'PENDING_APPROVAL', 'APPROVED', ''],
    ['APPROVE', 'off.reg2', 'officer', 25, 'IN_REVIEW', 'APPROVED', ''],
    ['ISSUE', 'off.reg2', 'officer', 25, 'APPROVED', 'COMPLETED', 'DOC-2569-000002'],
    ['REJECT', 'off.reg2', 'officer', 26, 'IN_REVIEW', 'REJECTED', REASON],
    ['UNMASK', 'off.reg2', 'officer', 25, null, null, 'ตรวจสอบตัวตนซ้ำ'],
    ['EXPORT', 'exec1', 'executive', null, null, null, 'xlsx 2026-12'],
    ['ADMIN_CHANGE', 'admin1', 'admin', null, null, null, 'SV-01 fee 20 → 25'],
  ];
  for (const [event, username, roleName, n, fromStatus, toStatus, detail] of wanted) {
    const items = body.items.filter(item => item.event === event && item.username === username && (!n || item.caseNo === caseNo(n)));
    expect(items).toHaveLength(1); const item = items[0]; expect(item.role).toBe(roleName); expect(item.detail || '').toContain(detail);
    const ui = row(auditor.page, 'audit-row', 'id', item.id);
    await expect(ui).toHaveAttribute('data-event', event); await expect(ui).toHaveAttribute('data-actor', username);
    await expect(ui.getByTestId('audit-actor')).toHaveText(username); await expect(ui.getByTestId('audit-role')).toHaveText(roleName);
    await expect(ui.getByTestId('audit-event')).toHaveText(event);
    await expect(ui.getByTestId('audit-transition')).toHaveText(fromStatus ? `${fromStatus} → ${toStatus}` : '–');
    if (n) { expect(item.caseNo).toBe(caseNo(n)); await expect(ui.getByTestId('audit-case-no')).toHaveText(caseNo(n)); }
    if (fromStatus) expect(item).toMatchObject({ fromStatus, toStatus });
    if (detail) await expect(ui.getByTestId('audit-detail')).toContainText(detail);
  }
  expect(body.items.filter(item => item.event === 'STAFF_LOGIN').map(item => item.username).sort()).toEqual(['off.reg2', 'off.reg1', 'head1', 'exec1', 'admin1', 'audit1'].sort());
  const ids = body.items.map(item => Number(item.id)); expect(ids).toEqual([...ids].sort((a, b) => b - a));
  expect(await by(auditor.page, 'audit-row').evaluateAll(rows => rows.map(r => Number(r.dataset.id)))).toEqual(ids);
  for (const item of body.items) expect(item.time).toBe(NOW);
  for (const element of await by(auditor.page, 'audit-time').all()) await expect(element).toHaveAttribute('data-iso', NOW);
  await auditFilter(auditor, { actor: 'off.reg2' }, 7); await auditFilter(auditor, { event: 'APPROVE' }, 2); await auditFilter(auditor, { actor: 'off.reg2', event: 'APPROVE' }, 1);
  await auditFilter(auditor, {}, 16); const csv = await download(auditor.page, 'audit-export-csv-btn');
  const rows = csvRows(csv.buffer.toString('utf8')); expect(rows[0]).toEqual(['time', 'username', 'role', 'event', 'caseNo', 'fromStatus', 'toStatus', 'detail']); expect(rows.slice(1)).toHaveLength(16);
  expect(rows.slice(1)).toEqual(body.items.map(item => [item.time, item.username, item.role, item.event, item.caseNo || '', item.fromStatus || '', item.toStatus || '', item.detail || '']));
  const after = await auditFilter(auditor, {}, 17); expect(after.items[0]).toMatchObject({ event: 'EXPORT', username: 'audit1' }); expect(after.items[0].detail).toContain('audit-csv');
});

test('TC-AUDIT-02 Audit แก้หรือลบไม่ได้', async ({ world }) => {
  const auditor = await world.actor('audit1'); const before = await json(await auditor.api.get('/api/audit')); expect(before.items).toHaveLength(1);
  const id = before.items[0].id;
  for (const user of ['admin1', 'audit1']) {
    const actor = await world.actor(user);
    for (const [method, url] of [['put', `/api/audit/${id}`], ['patch', `/api/audit/${id}`], ['delete', `/api/audit/${id}`], ['put', '/api/audit'], ['delete', '/api/audit'], ['delete', '/api/audit/999999']]) {
      await error(await actor.api[method](url, { data: { detail: 'x' } }), 405, 'METHOD_NOT_ALLOWED');
    }
  }
  const after = await auditFilter(auditor, {}, 2);
  for (const item of before.items) expect(after.items).toContainEqual(item);
  expect(after.items.filter(item => !before.items.some(old => old.id === item.id))).toEqual([expect.objectContaining({ event: 'STAFF_LOGIN', username: 'admin1' })]);
  await buttons(auditor.page, { 'audit-edit-btn': 0, 'audit-delete-btn': 0 });
  await error(await (await world.actor('admin1')).api.get('/api/audit'), 403, 'FORBIDDEN');
});

test('TC-AUDIT-03 กรองวันที่ตามเวลาไทยและรวมขอบวัน', async ({ world }) => {
  const times = ['2026-11-30T23:59:59+07:00', '2026-12-01T00:00:00+07:00', '2026-12-01T23:59:59+07:00', '2026-12-02T00:00:00+07:00', '2026-12-02T09:00:00+07:00'];
  const users = ['off.reg1', 'off.reg2', 'off.works1', 'off.reg1', 'audit1'];
  let auditor;
  for (let i = 0; i < times.length; i++) {
    await world.clock(times[i]);
    if (i === 3) {
      const extra = await world.anonymous(); await json(await extra.api.post('/api/auth/staff/login', { data: { username: users[i], password: 'Test@1234' } }));
    } else { const actor = await world.actor(users[i]); if (i === 4) auditor = actor; }
  }
  for (const [from, to, indexes, actor] of [
    ['2026-12-01', '2026-12-01', [1, 2]], ['2026-11-30', '2026-11-30', [0]], ['2026-11-30', '2026-12-01', [0, 1, 2]],
    ['2026-12-02', '', [3, 4]], ['', '2026-11-30', [0]], ['2026-12-01', '2026-12-02', [1, 2, 3, 4]], ['2026-12-01', '2026-12-01', [1], 'off.reg2'],
  ]) {
    const filters = { from, to }; if (actor) filters.actor = actor;
    const body = await auditFilter(auditor, filters, indexes.length);
    expect(body.items.map(item => item.time).sort()).toEqual(indexes.map(i => times[i]).sort());
    expect(body.items.map(item => item.username).sort()).toEqual(indexes.map(i => users[i]).sort());
    expect((await by(auditor.page, 'audit-time').evaluateAll(elements => elements.map(el => el.dataset.iso))).sort()).toEqual(indexes.map(i => times[i]).sort());
  }
});

test('TC-RBAC-01 ประชาชนเปิดคำขอและเอกสารของคนอื่นไม่ได้', async ({ world }) => {
  const citizen = await world.actor(SOMYING); const p = citizen.page;
  expect((await p.goto(citizenPage(5))).status()).toBe(404);
  await expect(by(p, 'not-found-msg')).toHaveText('ไม่พบคำขอ'); await buttons(p, { 'case-no': 0, 'case-status': 0 });
  expect(await p.content()).not.toContain('สมชาย');
  const existing = await citizen.api.get(apiCase(5)); const nonexistent = await citizen.api.get('/api/cases/EG-2569-999999');
  expect(await error(existing, 404, 'NOT_FOUND', 'ไม่พบคำขอ')).toEqual({ code: 'NOT_FOUND', message: 'ไม่พบคำขอ' });
  await error(nonexistent, 404, 'NOT_FOUND', 'ไม่พบคำขอ'); expect(await existing.text()).toBe(await nonexistent.text());
  for (const url of ['/api/documents/DOC-2569-000001/pdf', '/api/drafts/DR-0001']) expect((await citizen.api.get(url)).status()).toBe(404);
  expect((await citizen.api.post(`${apiCase(30)}/cancel`)).status()).toBe(404);
  expect((await p.goto(citizenPage(7))).status()).toBe(200); await expect(by(p, 'case-no')).toHaveText(caseNo(7));
  await json(await (await world.actor(SOMCHAI)).api.get(apiCase(5)), 200, { caseNo: caseNo(5) });
});

test('TC-RBAC-02 เจ้าหน้าที่อนุมัติหรือไม่อนุมัติ SV-02 ไม่ได้', async ({ world }) => {
  const r2 = await world.actor('off.reg2');
  for (const [n, action, state] of [[14, 'approve', 'PENDING_APPROVAL'], [13, 'approve', 'IN_REVIEW'], [14, 'reject', 'PENDING_APPROVAL']]) {
    await error(await r2.api.post(`${apiCase(n)}/${action}`, { data: { reason: REASON } }), 403, 'FORBIDDEN');
    await json(await r2.api.get(apiCase(n)), 200, { status: state });
  }
  for (const n of [13, 14]) { await r2.page.goto(officerPage(n)); await buttons(r2.page, { 'approve-btn': 0 }); }
  const h = await world.actor('head1'); await error(await h.api.post(`${apiCase(25)}/approve`), 403, 'FORBIDDEN');
  await post(h, `${apiCase(14)}/approve`, undefined, { status: 'APPROVED' });
  const auditor = await world.actor('audit1'); const body = await auditFilter(auditor, { event: 'APPROVE' }, 1);
  expect(body.items[0]).toMatchObject({ username: 'head1', caseNo: caseNo(14) });
});

test('TC-RBAC-03 ตารางสิทธิ์หน้า API เมนู และขอบเขตแผนก', async ({ world }) => {
  test.setTimeout(180000);
  const roles = [
    ['anon', null, []], ['citizen', SOMCHAI, ['nav-my-cases']], ['officer', 'off.reg1', ['nav-queue', 'nav-bell']],
    ['head', 'head1', ['nav-queue', 'nav-approvals', 'nav-bell']], ['executive', 'exec1', ['nav-dashboard']],
    ['auditor', 'audit1', ['nav-audit']], ['admin', 'admin1', ['nav-admin-services', 'nav-admin-holidays', 'nav-admin-users']],
  ];
  const nav = ['nav-my-cases', 'nav-queue', 'nav-approvals', 'nav-bell', 'nav-dashboard', 'nav-audit', 'nav-admin-services', 'nav-admin-holidays', 'nav-admin-users'];
  const pages = [
    ['/citizen', ['citizen']], ['/officer/queue', ['officer', 'head']], ['/head/approvals', ['head']],
    ['/dashboard', ['executive']], ['/audit', ['auditor']], ['/admin/services', ['admin']], ['/admin/holidays', ['admin']],
    ['/admin/users', ['admin']], ['/notifications', ['officer', 'head']], ['/verify/K7M2Q9XA', ['anon', 'citizen', 'officer', 'head', 'executive', 'auditor', 'admin']],
  ];
  const apis = [
    ['get', '/api/officer/queue', ['officer', 'head'], 200], ['get', '/api/notifications', ['officer', 'head'], 200],
    ['get', '/api/dashboard?period=2026-12&service=ALL', ['executive'], 200], ['get', '/api/audit', ['auditor'], 200],
    ['get', '/api/admin/services', ['admin'], 200], ['post', '/api/drafts', ['citizen'], 201, { serviceId: 'SV-01', qty: 1 }],
    ['get', apiCase(25), ['citizen', 'officer', 'head'], 200], ['post', officerApi(28, 'claim'), ['officer'], 200],
  ];
  for (const [roleName, username, expectedNav] of roles) {
    await world.reset(); const actor = username ? await world.actor(username) : await world.anonymous();
    for (const [url, allowed] of pages) {
      const response = await actor.page.goto(url);
      if (allowed.includes(roleName)) expect(response.status(), `${roleName} ${url}`).toBe(200);
      else if (roleName === 'anon') expect(new URL(actor.page.url()).pathname).toBe('/login');
      else { expect(response.status(), `${roleName} ${url}`).toBe(403); await expect(by(actor.page, 'forbidden-msg')).toHaveText('ไม่มีสิทธิ์เข้าถึงหน้านี้'); }
    }
    if (username) {
      const landing = pages.find(([url, allowed]) => allowed.includes(roleName) && !url.startsWith('/verify'))[0];
      await actor.page.goto(landing);
      for (const id of nav) await expect(by(actor.page, id)).toHaveCount(expectedNav.includes(id) ? 1 : 0);
    }
    // Only this API row uses Somying, per the explicit exception on the card.
    let ownCaseActor;
    for (const [method, url, allowed, success, data] of apis) {
      const caller = roleName === 'citizen' && url === apiCase(25) ? (ownCaseActor ||= await world.actor(SOMYING)) : actor;
      const response = await caller.api[method](url, data ? { data } : {});
      const expectedStatus = roleName === 'anon' ? 401 : allowed.includes(roleName) ? success : 403;
      expect(response.status(), `${roleName} ${method} ${url}`).toBe(expectedStatus);
    }
  }
  await world.reset(); const works = await world.actor('off.works1'); const reg = await world.actor('off.reg1');
  await error(await works.api.post(officerApi(28, 'claim')), 403, 'FORBIDDEN'); await error(await reg.api.post(officerApi(10, 'claim')), 403, 'FORBIDDEN');
  const queue = await json(await works.api.get('/api/officer/queue')); expect(queue.items.map(item => item.caseNo)).toEqual([caseNo(10)]);
  await works.page.goto('/officer/queue'); await expect(by(works.page, 'queue-row')).toHaveCount(1); await expect(by(works.page, 'queue-row')).toHaveAttribute('data-case-no', caseNo(10));
});

test('TC-RBAC-04 ผู้ดูแลแก้บริการ วันหยุด บทบาท และค่าที่ล็อกไว้', async ({ world }) => {
  const admin = await world.actor('admin1'); await admin.page.goto('/admin/holidays'); await expect(by(admin.page, 'holiday-row')).toHaveCount(4);
  expect((await by(admin.page, 'holiday-row').evaluateAll(rows => rows.map(r => r.dataset.date))).sort()).toEqual(['2026-12-07', '2026-12-10', '2026-12-31', '2027-01-01']);
  const first = await world.paid(); expect(first.caseNo).toBe(caseNo(31));
  const citizen = await world.actor(SOMCHAI); await json(await citizen.api.get(apiCase(31)), 200, { dueAt: '2026-12-04T16:30:00+07:00', fee: 20 });
  await admin.page.goto('/admin/services');
  for (const [service, fee] of [['SV-01', 25], ['SV-02', 600]]) {
    await by(admin.page, `svc-fee-${service}`).fill(String(fee)); await by(admin.page, `svc-save-${service}`).click(); await expect(by(admin.page, 'action-success')).toBeVisible();
    const services = await json(await admin.api.get('/api/admin/services')); expect(services.items.find(item => item.id === service).fee).toBe(fee);
  }
  await citizen.page.goto('/citizen/new/SV-01'); await by(citizen.page, 'qty-input').fill('5'); await expect(by(citizen.page, 'fee-total')).toHaveText('฿125');
  await by(citizen.page, 'qty-input').fill('1'); await expect(by(citizen.page, 'fee-total')).toHaveText('฿25');
  await citizen.page.goto('/citizen/new/SV-02'); await expect(by(citizen.page, 'fee-total')).toHaveText('฿600');
  await citizen.page.goto(citizenPage(30)); await expect(by(citizen.page, 'case-fee')).toHaveText('฿20');
  await citizen.page.goto('/citizen/new/SV-02?draft=DR-0002'); await expect(by(citizen.page, 'payment-amount')).toHaveText('฿500');
  await error(await world.control.post('/api/test/payments/PP-0001/pay', { data: { amount: 600 } }), 422, 'AMOUNT_MISMATCH');
  await json(await world.control.post('/api/test/payments/PP-0001/pay', { data: { amount: 500 } }), 200, { status: 'PAID', caseNo: caseNo(32) });
  await admin.page.goto('/admin/holidays'); await by(admin.page, 'holiday-date-input').fill('2026-12-02'); await by(admin.page, 'holiday-name-input').fill('วันหยุดทดสอบ'); await by(admin.page, 'holiday-add-btn').click();
  await expect(by(admin.page, 'holiday-row')).toHaveCount(5); await json(await citizen.api.get(apiCase(31)), 200, { dueAt: '2026-12-04T16:30:00+07:00' });
  const later = await world.paid({ fee: 25 }); expect(later.caseNo).toBe(caseNo(33)); await json(await citizen.api.get(apiCase(33)), 200, { dueAt: '2026-12-08T16:30:00+07:00' });
  await json(await admin.api.put('/api/admin/users/exec1', { data: { role: 'auditor', dept: '' } }));
  const changed = await world.actor('exec1'); await changed.page.goto('/'); await expect(changed.page).toHaveURL(`${BASE_URL}/audit`);
  expect((await changed.page.goto('/dashboard')).status()).toBe(403); await expect(by(changed.page, 'forbidden-msg')).toHaveText('ไม่มีสิทธิ์เข้าถึงหน้านี้');
  const audit = await auditFilter(changed, { event: 'ADMIN_CHANGE' }, 4);
  const details = ['SV-01 fee 20 → 25', 'SV-02 fee 500 → 600', 'holiday add 2026-12-02', 'exec1 role executive → auditor'];
  for (const item of audit.items) expect(item).toMatchObject({ username: 'admin1', role: 'admin' });
  for (const detail of details) expect(audit.items.some(item => item.detail.includes(detail))).toBe(true);
  await error(await admin.api.post('/api/drafts', { data: { serviceId: 'SV-01', qty: 1 } }), 403, 'FORBIDDEN');
  await row(admin.page, 'holiday-row', 'date', '2026-12-02').getByTestId('holiday-delete-btn').click(); await expect(by(admin.page, 'holiday-row')).toHaveCount(4);
  const after = await auditFilter(changed, { event: 'ADMIN_CHANGE' }, 5); expect(after.items.some(item => item.detail.includes('holiday delete 2026-12-02'))).toBe(true);
});

test('TC-RBAC-05 สิทธิ์รายการและดาวน์โหลดไฟล์แนบทุกบทบาท', async ({ world }) => {
  const head = await world.actor('head1'); const known = new Map();
  for (const n of [25, 12, 10, 11]) {
    const body = await json(await head.api.get(`${apiCase(n)}/files`));
    expect(body.items.map(item => item.name).sort()).toEqual(n === 25 ? ['id-card.pdf'] : ['deed.pdf', 'id-card.pdf', 'plan.pdf']);
    known.set(n, body.items);
  }
  const cases = [
    ['off.reg1', 25, 200], ['off.works1', 25, 403], ['off.reg2', 12, 200], ['off.works1', 12, 403],
    ['off.works1', 10, 200], ['off.reg1', 10, 200], ['off.works1', 11, 200],
    ['head1', 25, 200], ['head1', 10, 200], ['head1', 12, 200], [SOMYING, 25, 200], [SOMCHAI, 25, 404],
    ['exec1', 25, 403], ['audit1', 25, 403], ['admin1', 25, 403], [null, 25, 401],
  ];
  for (const [user, n, expected] of cases) {
    const actor = user ? await world.actor(user) : await world.anonymous();
    const listing = await actor.api.get(`${apiCase(n)}/files`); expect(listing.status(), `${user} list ${n}`).toBe(expected);
    if (expected === 200) {
      const body = await json(listing); expect(body.items).toHaveLength(known.get(n).length);
      expect(body.items.map(item => item.name).sort()).toEqual(known.get(n).map(item => item.name).sort());
    }
    for (const file of known.get(n)) {
      const response = await actor.api.get(`/api/files/${file.fileId}`); expect(response.status(), `${user} file ${file.name}`).toBe(expected);
      if (expected === 200) { const bytes = await pdfResponse(response); expect(bytes.length).toBeGreaterThan(0); }
    }
  }
  const reg1 = await world.actor('off.reg1'); expect((await reg1.api.get('/api/files/nonexistent-file-id')).status()).toBe(404);
  for (const [user, n, count] of [['off.reg1', 25, 1], ['off.reg2', 12, 3], [SOMYING, 25, 1]]) {
    const actor = await world.actor(user); await actor.page.goto(/^\d/.test(user) ? citizenPage(n) : officerPage(n));
    await expect(by(actor.page, 'doc-item')).toHaveCount(count);
    for (const file of known.get(n)) {
      const item = row(actor.page, 'doc-item', 'name', file.name); await expect(item).toHaveAttribute('data-file-id', String(file.fileId));
      await expect(item.getByTestId('doc-download-link')).toHaveAttribute('href', `/api/files/${file.fileId}`);
    }
    if (user === 'off.reg1') {
      const promise = actor.page.waitForResponse(r => r.url().endsWith(`/api/files/${known.get(n)[0].fileId}`));
      // A direct attachment link can trigger navigation or a browser download.
      await by(actor.page, 'doc-download-link').click(); const response = await promise;
      expect(response.status()).toBe(200); expect(response.headers()['content-type']).toContain('application/pdf');
      // API body is checked above, independent of how the browser handles attachments.
    }
  }
});

test('TC-RBAC-06 ช่วงค่าบริการ วันหยุดซ้ำ และห้ามเปลี่ยนบทบาทตนเอง', async ({ world }) => {
  const admin = await world.actor('admin1'); const p = admin.page; await p.goto('/admin/services');
  let current = { fee: 20, sla: 3 };
  for (const [field, value, success, code, message] of [
    ['fee', -1, false, 'INVALID_FEE', 'ค่าธรรมเนียมต้องเป็นจำนวนเต็ม 0–100,000 บาท'],
    ['fee', 0, true], ['fee', 100000, true], ['fee', 100001, false, 'INVALID_FEE', 'ค่าธรรมเนียมต้องเป็นจำนวนเต็ม 0–100,000 บาท'],
    ['sla', 0, false, 'INVALID_SLA', 'SLA ต้องเป็นจำนวนเต็ม 1–60 วันทำการ'], ['sla', 1, true], ['sla', 60, true],
    ['sla', 61, false, 'INVALID_SLA', 'SLA ต้องเป็นจำนวนเต็ม 1–60 วันทำการ'],
  ]) {
    const data = { ...current, [field]: value };
    await by(p, `svc-${field}-SV-01`).fill(String(value));
    if (success) {
      const responsePromise = p.waitForResponse(r => new URL(r.url()).pathname === '/api/admin/services/SV-01' && r.request().method() === 'PUT');
      await by(p, 'svc-save-SV-01').click(); const response = await responsePromise;
      expect(response.status()).toBe(200); await expect(by(p, 'action-success')).toBeVisible(); current = data;
      // The UI's PUT is itself the API boundary check, avoiding duplicate audit writes.
    } else {
      await by(p, 'svc-save-SV-01').click(); await expect(by(p, 'action-error')).toHaveText(message);
      await error(await admin.api.put('/api/admin/services/SV-01', { data }), 400, code);
    }
    const body = await json(await admin.api.get('/api/admin/services')); expect(body.items.find(item => item.id === 'SV-01')).toMatchObject(current);
    await p.reload();
  }
  await admin.page.goto('/admin/holidays');
  await error(await admin.api.post('/api/admin/holidays', { data: { date: '2026-12-07', name: 'ซ้ำ' } }), 409, 'DUPLICATE_HOLIDAY', 'มีวันหยุดนี้อยู่แล้ว');
  await admin.page.reload(); await expect(by(admin.page, 'holiday-row')).toHaveCount(4);
  await json(await admin.api.post('/api/admin/holidays', { data: { date: '2026-12-05', name: 'วันเสาร์' } }), 201);
  await error(await admin.api.put('/api/admin/users/admin1', { data: { role: 'executive', dept: '' } }), 409, 'SELF_ROLE_CHANGE');
  await json(await admin.api.get('/api/me'), 200, { role: 'admin' });
  const auditor = await world.actor('audit1'); const audit = await auditFilter(auditor, { event: 'ADMIN_CHANGE' }, 5);
  const expectedDetails = ['SV-01 fee 20 → 0', 'SV-01 fee 0 → 100000', 'SV-01 sla 3 → 1', 'SV-01 sla 1 → 60', 'holiday add 2026-12-05'];
  for (const detail of expectedDetails) expect(audit.items.some(item => item.detail.includes(detail))).toBe(true);
});

async function citizenLoginUI(actor) {
  await actor.page.goto('/login'); await by(actor.page, 'thaid-id-input').fill(SOMCHAI); await by(actor.page, 'thaid-submit').click();
  await by(actor.page, 'otp-input').fill('123456'); await by(actor.page, 'otp-submit').click(); await expect(actor.page).toHaveURL(`${BASE_URL}/citizen`);
}
async function wizardToPayment(actor) {
  await by(actor.page, 'start-service-SV-01').click(); await by(actor.page, 'qty-input').fill('1'); await expect(by(actor.page, 'fee-total')).toHaveText('฿20');
  await by(actor.page, 'to-upload-btn').click(); await by(actor.page, 'upload-input-id-card').setInputFiles(uploadFile());
  await expect(row(actor.page, 'file-item', 'name', 'id-card.pdf')).toHaveCount(1);
  await expect(by(actor.page, 'to-payment-btn')).toBeEnabled(); await by(actor.page, 'to-payment-btn').click(); await expect(by(actor.page, 'create-qr-btn')).toBeVisible();
}
const responsivePages = [
  [null, '/login'], [SOMCHAI, '/citizen'], [SOMCHAI, '/citizen/new/SV-03'], [SOMCHAI, citizenPage(13)],
  ['off.reg1', '/officer/queue'], ['off.reg1', officerPage(20)], ['head1', '/head/approvals'],
  ['exec1', '/dashboard'], ['audit1', '/audit'], ['admin1', '/admin/services'], [null, '/verify/K7M2Q9XA'],
];
test('TC-NFR-01 Responsive 375 768 1280 และงานหลักบนมือถือ', async ({ world }) => {
  let checks = 0;
  for (const size of [{ width: 375, height: 812 }, { width: 768, height: 1024 }, { width: 1280, height: 800 }]) {
    for (const [user, url] of responsivePages) {
      const actor = user ? await world.actor(user) : await world.anonymous(); await actor.page.setViewportSize(size);
      expect((await actor.page.goto(url)).status()).toBe(200);
      const dimensions = await actor.page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: window.innerWidth }));
      expect(dimensions.scroll, `${url} at ${size.width}px`).toBeLessThanOrEqual(dimensions.viewport); checks++;
    }
  }
  expect(checks).toBe(33);
  const mobile = await world.anonymous(); await mobile.page.setViewportSize({ width: 375, height: 812 });
  await citizenLoginUI(mobile); await wizardToPayment(mobile);
  const box = await by(mobile.page, 'create-qr-btn').boundingBox(); expect(box).not.toBeNull(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(375);
});

const STATUS_TEXT = {
  DRAFT: 'ร่าง', PENDING_PAYMENT: 'รอชำระเงิน', SUBMITTED: 'ส่งคำขอแล้ว', IN_REVIEW: 'กำลังตรวจสอบ', NEED_FIX: 'รอแก้ไขเอกสาร',
  PENDING_APPROVAL: 'รออนุมัติ', APPROVED: 'อนุมัติ', COMPLETED: 'เสร็จสิ้น', REJECTED: 'ไม่อนุมัติ', CANCELLED: 'ยกเลิก',
};
const LEVEL_TEXT = { normal: 'ปกติ', near: 'ใกล้ครบกำหนด', overdue: 'เกินกำหนด', paused: 'หยุดนับ', closed: 'ปิดแล้ว' };
async function statusLabels(page) {
  for (const id of ['case-status', 'row-status', 'sla-level', 'row-sla-level']) {
    for (const locator of await by(page, id).all()) {
      const state = await locator.evaluate((el, id) => {
        const status = id.endsWith('status');
        return status ? el.dataset.status || el.closest('[data-status]')?.dataset.status : el.dataset.level || el.closest('[data-sla-level]')?.dataset.slaLevel;
      }, id);
      const expected = id.endsWith('status') ? STATUS_TEXT[state] : LEVEL_TEXT[state];
      expect(expected, `${id} must expose its status/level code`).toBeTruthy(); await expect(locator).toHaveText(expected);
    }
  }
}
async function tabTo(page, id) {
  const target = by(page, id); await expect(target).toBeVisible();
  for (let i = 0; i < 100; i++) {
    if (await target.evaluate(el => el === document.activeElement)) {
      const ring = await target.evaluate(el => { const css = getComputedStyle(el); return { outline: css.outlineStyle, width: parseFloat(css.outlineWidth), shadow: css.boxShadow }; });
      expect((ring.outline !== 'none' && ring.width > 0) || ring.shadow !== 'none', `${id} visible keyboard focus`).toBe(true);
      return target;
    }
    await page.keyboard.press('Tab');
  }
  throw new Error(`Could not reach ${id} using Tab`);
}
test('TC-NFR-02 axe คีย์บอร์ด label และข้อความสถานะใน forced colors', async ({ world }) => {
  test.setTimeout(240000);
  const AxeBuilder = require('@axe-core/playwright').default;
  const pages = [
    [null, '/login'], [MANA, '/register'], [SOMCHAI, '/citizen'], [SOMCHAI, '/citizen/new/SV-01'], [SOMCHAI, citizenPage(17)],
    ['off.reg1', '/officer/queue'], ['off.reg1', officerPage(20)], ['head1', '/head/approvals'],
    ['exec1', '/dashboard'], ['audit1', '/audit'], ['admin1', '/admin/services'], ['off.reg1', '/notifications'], [null, '/verify/K7M2Q9XA'],
  ];
  for (const [user, url] of pages) {
    const actor = user ? await world.actor(user) : await world.anonymous(); const p = actor.page; expect((await p.goto(url)).status()).toBe(200);
    const result = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(result.violations.filter(v => ['serious', 'critical'].includes(v.impact)), url).toEqual([]);
    const unnamed = await p.locator('input:visible, select:visible, textarea:visible').evaluateAll(elements => elements.filter(el => {
      if (['button', 'submit', 'reset'].includes(el.type)) return !(el.value || el.getAttribute('aria-label') || '').trim();
      const aria = el.getAttribute('aria-label')?.trim();
      const labelled = (el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
      const labels = [...(el.labels || [])].map(label => label.textContent || '').join(' ').trim();
      return !(aria || labelled || labels || el.title?.trim());
    }).map(el => el.outerHTML));
    expect(unnamed, `${url} accessible control names`).toEqual([]);
    await statusLabels(p); await p.emulateMedia({ forcedColors: 'active' }); await statusLabels(p); await p.emulateMedia({ forcedColors: 'none' });
  }
  // No click(), focus(), or mouse actions in the keyboard-only user journey.
  const keyboard = await world.anonymous(); const p = keyboard.page; await p.goto('/login');
  await tabTo(p, 'thaid-id-input'); await p.keyboard.type(SOMCHAI); await p.keyboard.press('Enter');
  await tabTo(p, 'otp-input'); await p.keyboard.type('123456'); await p.keyboard.press('Enter'); await expect(p).toHaveURL(`${BASE_URL}/citizen`);
  await tabTo(p, 'start-service-SV-01'); await p.keyboard.press('Enter');
  await tabTo(p, 'qty-input'); await p.keyboard.press('Control+A'); await p.keyboard.type('1');
  await tabTo(p, 'to-upload-btn'); await p.keyboard.press('Enter');
  await tabTo(p, 'upload-input-id-card'); await by(p, 'upload-input-id-card').setInputFiles(uploadFile());
  await expect(row(p, 'file-item', 'name', 'id-card.pdf')).toHaveCount(1);
  await tabTo(p, 'to-payment-btn'); await p.keyboard.press('Enter'); await expect(by(p, 'create-qr-btn')).toBeVisible(); await tabTo(p, 'create-qr-btn');
});

test('TC-NFR-03 Health เวลาโหลด reset ซ้ำ และนาฬิกา', async ({ world, playwright }) => {
  const anon = await world.anonymous(); expect(await json(await anon.api.get('/api/health'))).toEqual({ status: 'ok' });
  for (const [user, url] of [[null, '/login'], [SOMCHAI, '/citizen'], ['off.reg1', '/officer/queue'], ['exec1', '/dashboard'], ['audit1', '/audit']]) {
    const actor = user ? await world.actor(user) : anon; await actor.page.goto(url, { waitUntil: 'load' });
    const start = performance.now(); await actor.page.goto(url, { waitUntil: 'load' }); const elapsed = performance.now() - start;
    expect(elapsed, `${url} warm page load ${elapsed.toFixed(0)} ms`).toBeLessThanOrEqual(3000);
  }
  async function snapshot() {
    const clock = await json(await world.control.get('/api/test/clock'));
    const reg = await world.actor('off.reg1'); const queue = await json(await reg.api.get('/api/officer/queue'));
    const exec = await world.actor('exec1'); const dash = await json(await exec.api.get('/api/dashboard?period=2026-12&service=ALL'));
    return { clock, queue: queue.items.map(({ caseNo, dueAt, status, owner }) => ({ caseNo, dueAt, status, owner })), dashboard: dash };
  }
  await world.reset(); const before = await snapshot(); expect(before.clock).toEqual({ now: NOW });
  await world.clock('2026-12-10T12:00:00+07:00'); await post(await world.actor('off.reg1'), officerApi(28, 'claim'));
  await world.paid({ time: '2026-12-10T12:00:00+07:00' });
  await world.reset(); const after = await snapshot(); expect(after).toEqual(before);
  await error(await world.control.put('/api/test/clock', { data: { now: '2026-12-01 09:00' } }), 400, 'INVALID_TIME');
  // Set NORMAL_BASE_URL when a second, non-TEST_MODE server is available.
  if (process.env.NORMAL_BASE_URL) {
    const normal = await playwright.request.newContext({ baseURL: process.env.NORMAL_BASE_URL });
    try { expect((await normal.post('/api/test/reset')).status()).toBe(404); } finally { await normal.dispose(); }
  }
});

test('TC-NFR-04 ไม่มีข้อมูลส่วนบุคคลเป็นข้อความในฐานข้อมูลและถอดรหัสได้', async ({ world }, testInfo) => {
  const mana = await world.actor(MANA);
  await json(await mana.api.post('/api/auth/register', { data: { mobile: '0845678901', email: '', consent: true } }), 201);
  const dbPath = path.resolve(process.env.DB_PATH || path.join(process.cwd(), 'data/app.db'));
  expect((await fs.stat(dbPath)).isFile(), `DB_PATH must point to the running server database: ${dbPath}`).toBe(true);
  const files = new Set([dbPath]);
  // Include SQLite journals/WAL and dump/log files beside the database.
  for (const name of await fs.readdir(path.dirname(dbPath))) {
    if (/\.(?:db|sqlite|sqlite3|sql|dump|log)(?:-wal|-shm|-journal)?$/i.test(name)) {
      const candidate = path.join(path.dirname(dbPath), name); if ((await fs.stat(candidate)).isFile()) files.add(candidate);
    }
  }
  for (const envName of ['DB_DUMP_PATHS', 'APP_LOG_PATHS']) {
    for (const file of (process.env[envName] || '').split(path.delimiter).filter(Boolean)) files.add(path.resolve(file));
  }
  const values = [SOMCHAI, SOMYING, '1909900555015', MANA, '0812345678', '0823456789', '0834567890', '0845678901',
    '1-1017-00123-45-6', '3-1006-00987-65-9', '1-9099-00555-01-5', '5-5004-00111-22-1'];
  const results = [];
  for (const file of files) {
    const bytes = await fs.readFile(file);
    for (const value of values) {
      // Check both UTF-8 and UTF-16LE storage representations.
      const found = bytes.includes(Buffer.from(value)) || bytes.includes(Buffer.from(value, 'utf16le'));
      expect(found, `plaintext personal data in ${file}: ${value}`).toBe(false);
    }
    results.push({ file, bytes: bytes.length, plaintextMatches: 0 });
  }
  await json(await (await world.actor(SOMCHAI)).api.get(apiCase(5)), 200, { idNo: SOMCHAI });
  await testInfo.attach('encryption-inspection.json', {
    body: Buffer.from(JSON.stringify({ method: 'AES-256-GCM (reported on team board; algorithm not independently established by byte inspection)', results, decryptionControl: 'passed' }, null, 2)),
    contentType: 'application/json',
  });
});
