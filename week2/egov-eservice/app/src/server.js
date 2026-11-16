'use strict';
/**
 * e-Service กลางของเทศบาลนครตัวอย่าง · จุดเริ่มต้น (B01)
 * =====================================================================================
 * สัญญาของ "โมดูลบล็อก" (ไฟล์ src/<ชื่อ>.js ที่ทีมอื่นเขียน) — server.js โหลดตามลำดับนี้ ถ้ายังไม่มีไฟล์จะข้ามเงียบ ๆ:
 *     auth · citizen · payment · workflow · documents · notifications · reporting · admin
 *   module.exports = {
 *     register(app, ctx) { … app.get/post … },     // บังคับ: ผูก route (Express 4)
 *     schema: 'CREATE TABLE …;',                   // ไม่บังคับ: ตารางเพิ่มของโมดูล (รันทุกครั้งที่สร้าง DB ใหม่)
 *     seed(ctx) { … },                             // ไม่บังคับ: ข้อมูลเพิ่ม (รันหลัง seed หลัก ทุก reset)
 *     onReset(ctx) { … },                          // ไม่บังคับ: ล้าง cache/ตัวแปรในหน่วยความจำของโมดูล
 *   }
 *   ctx = { config, clock, db, ids, security, bug, audit, http, view, storage, onRequest(fn), resetAll(), modules }
 *   - กฎเวลาทุกข้อใช้ ctx.clock เท่านั้น (ห้าม Date.now()/new Date() ในกฎธุรกิจ)
 *   - ctx.onRequest(fn(req)) ลงทะเบียนงานที่ต้องรันทุก request ยกเว้น /api/test/* และไฟล์ static (CONTRACT §0 ข้อ 7:
 *     ประเมินแจ้งเตือน SLA + ยกเลิกอัตโนมัติ) · fn ซิงก์ · รันหลัง session ก่อนถึง route · ต้อง idempotent
 *   - route ของ test hook เพิ่มเติม (payments/<ref>/pay, documents/<docNo>/tamper) ลงทะเบียนใต้ /api/test/... ได้เลย
 *     ถูก guard 404 อัตโนมัติเมื่อไม่ได้ตั้ง TEST_MODE
 *   - ข้อผิดพลาด API ใช้ ctx.http.apiError(res, status, code, message, extra) → {"code","message"}
 *   - handler แบบ async ห่อด้วย ctx.http.wrap(fn)
 *   - หน้า HTML ใช้ ctx.view.page(req, res, {title, body}) · guard: ctx.http.requirePage(...roles) / requireApi(...roles)
 * =====================================================================================
 */
const path = require('path');
const express = require('express');

const config = require('./config');
const clock = require('./clock');
const { db, ids, init: initDb, addSchema } = require('./db');
const security = require('./security');
const bug = require('./bugs');
const audit = require('./audit');
const http = require('./http');
const view = require('./view');
const storage = require('./storage');
const { seedAll } = require('./seed');
const testhook = require('./testhook');

const MODULE_NAMES = ['auth', 'citizen', 'payment', 'workflow', 'documents', 'notifications', 'reporting', 'admin'];

const requestHooks = [];
const loaded = []; // [{name, mod}]

const ctx = {
  config, clock, db, ids, security, bug, audit, http, view, storage,
  onRequest: (fn) => { requestHooks.push(fn); },
  modules: loaded,
  resetAll,
};

function loadModules() {
  for (const name of MODULE_NAMES) {
    const file = path.join(__dirname, name + '.js');
    let mod;
    try {
      mod = require(file);
    } catch (e) {
      if (e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(file)) {
        console.log(`[boot] module ${name}: ยังไม่มีไฟล์ (ข้าม)`);
        continue;
      }
      throw e;
    }
    loaded.push({ name, mod });
    if (mod.schema) addSchema(mod.schema);
  }
  // rules.js (B03) เป็นไลบรารีฟังก์ชันล้วน — ไม่ต้องลงทะเบียนที่นี่ (require จากโมดูลอื่นได้เลย)
}

/** ล้างทุกอย่าง + seed ตาม TEST-DATA + นาฬิกากลับค่าเริ่มต้น + ล้าง session (ทั้งไฟล์ DB ถูกสร้างใหม่) */
function seedEverything() {
  clock.reset();
  seedAll();
  for (const { mod } of loaded) if (typeof mod.seed === 'function') mod.seed(ctx);
}
function resetAll() {
  initDb({ fresh: true });
  seedEverything();
  for (const { mod } of loaded) if (typeof mod.onReset === 'function') mod.onReset(ctx);
}

function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // body ≥ 6 MB (CONTRACT §0 ข้อ 10) — multipart ให้โมดูลอัปโหลดจัดการเอง (multer) โดยตั้ง limit ≥ 6 MB
  app.use(express.json({ limit: config.MAX_BODY }));
  app.use(express.urlencoded({ extended: false, limit: config.MAX_BODY }));

  // /api/test/* : TEST_MODE ไม่เปิด → 404 (CONTRACT §0 ข้อ 8) — ต้องมาก่อนโมดูลทั้งหมด
  app.use('/api/test', (req, res, next) => {
    if (!config.TEST_MODE) return http.apiError(res, 404, 'NOT_FOUND', 'ไม่พบ');
    next();
  });

  // ไฟล์ static: public/ (style.css ของ B11, app.js กลาง) ที่ /static และที่ราก (index ปิด)
  const pub = path.join(__dirname, '..', 'public');
  app.use('/static', express.static(pub, { index: false }));
  app.use(express.static(pub, { index: false }));

  app.use(http.sessionMiddleware);

  // งานต่อ request (A-30 A-46): ยกเว้น /api/test/* (static ถูกตอบไปแล้วข้างบน)
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/test')) return next();
    for (const fn of requestHooks) fn(req);
    next();
  });

  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  testhook.register(app, ctx);
  for (const { mod } of loaded) {
    if (typeof mod.register === 'function') mod.register(app, ctx);
  }

  // "/" : ยังไม่ล็อกอิน → /login · ล็อกอินแล้ว → หน้าตั้งต้นของบทบาท (CONTRACT §1)
  app.get('/', (req, res) => {
    if (!req.user) return res.redirect('/login');
    if (req.user.kind !== 'full') return res.redirect('/register');
    res.redirect(view.LANDING[req.user.role] || '/login');
  });

  // 404
  app.use('/api', (req, res) => http.apiError(res, 404, 'NOT_FOUND', 'ไม่พบ API นี้'));
  app.use((req, res) => view.page(req, res, { title: 'ไม่พบหน้า', status: 404, body: '<h1>404</h1><p data-testid="not-found-msg">ไม่พบหน้านี้</p>' }));

  // ข้อผิดพลาด
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    let status = err.status || err.statusCode || 500;
    let code = err.code && typeof err.code === 'string' && err.status ? err.code : 'INTERNAL_ERROR';
    let message = err.message;
    if (err.type === 'entity.parse.failed') { status = 400; code = 'BAD_JSON'; message = 'รูปแบบ JSON ไม่ถูกต้อง'; }
    if (err.type === 'entity.too.large') { status = 413; code = 'PAYLOAD_TOO_LARGE'; message = 'ข้อมูลใหญ่เกินไป'; }
    if (status >= 500) { console.error('[error]', req.method, req.path, err); message = 'เกิดข้อผิดพลาดภายในระบบ'; }
    if (req.path.startsWith('/api')) return res.status(status).json({ code, message, ...(err.extra || {}) });
    return view.page(req, res, { title: 'ผิดพลาด', status, body: `<h1>${status}</h1><p data-testid="error-msg">${view.esc(message)}</p>` });
  });

  return app;
}

function main() {
  loadModules();
  // TEST_MODE เริ่มจากข้อมูล seed สะอาดเสมอ · โหมดปกติใช้ฐานข้อมูลเดิมถ้ามี (ไม่งั้น seed)
  const needSeed = initDb({ fresh: config.TEST_MODE });
  if (needSeed) seedEverything();
  const app = buildApp();
  app.listen(config.PORT, '0.0.0.0', () => {
    console.log(`[boot] e-Service listening on :${config.PORT} · TEST_MODE=${config.TEST_MODE ? 1 : 0} · BUG_MODE=${bug.active().join(',') || '-'} · now=${clock.nowIso()}`);
  });
}

if (require.main === module) main();

module.exports = { ctx, buildApp, main };
