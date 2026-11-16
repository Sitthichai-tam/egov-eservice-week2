'use strict';
/**
 * B09 · Dashboard + ส่งออก Excel/PDF + Audit Trail + แสดงเลขบัตรเต็ม (FR-21 FR-22 FR-23 FR-24)
 * =====================================================================================
 * แหล่งกฎ: DECISIONS §12 §13 §18 · CONTRACT §2.9 §2.10 §6.4 §6.8 §7 · TEST-DATA §7 §10
 *
 * หน้า   GET /dashboard (executive) · GET /audit (auditor)   — ด่านบทบาทกลางอยู่ใน auth.js แล้ว
 * API    GET  /api/dashboard?period=2026-11|2026&service=ALL|SV-01..
 *        GET  /api/dashboard/export?format=xlsx|pdf&period=&service=       + Audit EXPORT "<format> <period> <service>"
 *        GET  /api/audit?actor=&event=&from=&to=                          (ช่วงวันที่ = วันเริ่ม..วันจบ รวมทั้งสองวัน ตามเวลาไทย)
 *        GET  /api/audit/export.csv?…                                      + Audit EXPORT "audit-csv"
 *        PUT/PATCH/DELETE /api/audit[/…] → 405 (auth.js ตอบก่อนถึงที่นี่ · ที่นี่ตอบซ้ำเพื่อกันพลาด)
 *        POST /api/officer/cases/:caseNo/unmask {reason}                   200 {idNo} + Audit UNMASK
 *
 * นิยามตัวชี้วัด (DECISIONS §12 §18):
 *   รับเรื่อง = คำขอที่มีเลข paid_at อยู่ในช่วง (รวม CANCELLED)
 *   ปิดงาน   = COMPLETED + REJECTED ที่ closed_at อยู่ในช่วง · ทัน ⇔ closed_at ≤ due_at (รวมวินาทีที่ขอบ)
 *   ทัน %    = ทัน ÷ ปิดงาน × 100 ทศนิยม 1 ตำแหน่ง ปัดครึ่งขึ้น · ปิดงาน 0 → null / "–"
 *   คงค้าง/เกินกำหนด = ค่า "ณ ตอนนี้" ไม่ขึ้นกับช่วง (A-41) แต่ขึ้นกับบริการ
 *   ปี (period = 2026) = รวมตัวเลขทุกเดือนแล้วคิด % จากยอดรวม ไม่ใช่เฉลี่ย %
 *
 * BUG_MODE: B10 ทัน % หารด้วยรับเรื่อง · B11 unmask ไม่บันทึก Audit
 * ห้ามใส่ชื่อผู้ยื่น เลขบัตร เบอร์โทร ใน Dashboard / ไฟล์ส่งออก (BR-24)
 */
const fs = require('fs');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

const BACKLOG_STATUSES = ['SUBMITTED', 'IN_REVIEW', 'NEED_FIX', 'PENDING_APPROVAL', 'APPROVED'];
const AUDIT_EVENTS = ['STAFF_LOGIN', 'CLAIM', 'RETURN', 'FORWARD', 'APPROVE', 'REJECT', 'ISSUE', 'UNMASK', 'EXPORT', 'ADMIN_CHANGE'];
const DASH = '–';
const PERIOD_RE = /^(\d{4})(?:-(0[1-9]|1[0-2]))?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const ERR = {
  REASON_REQUIRED: 'กรุณากรอกเหตุผล',
  NOT_FOUND: 'ไม่พบคำขอ',
  FORBIDDEN: 'ไม่มีสิทธิ์ทำรายการนี้',
  INVALID_PERIOD: 'ช่วงเวลาไม่ถูกต้อง',
  INVALID_SERVICE: 'บริการไม่ถูกต้อง',
  INVALID_FORMAT: 'รูปแบบไฟล์ไม่ถูกต้อง',
  INVALID_DATE: 'รูปแบบวันที่ไม่ถูกต้อง (YYYY-MM-DD)',
  INVALID_EVENT: 'เหตุการณ์ไม่ถูกต้อง',
};

const THAI_FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/tlwg/Loma.ttf',
  '/usr/share/fonts/truetype/tlwg/Garuda.ttf',
  '/usr/share/fonts/truetype/tlwg/Norasi.ttf',
  '/usr/share/fonts/thai-tlwg/Loma.ttf',
  '/usr/share/fonts/TTF/Loma.ttf',
  '/usr/share/fonts/truetype/noto/NotoSansThai-Regular.ttf',
  '/usr/share/fonts/noto/NotoSansThai-Regular.ttf',
  '/usr/share/fonts/truetype/freefont/FreeSerif.ttf',
];

function register(app, ctx) {
  const { db, clock, http, view, audit, bug } = ctx;
  const esc = view.esc;
  const apiError = http.apiError;

  /* ============================================================== ตัวชี้วัด Dashboard */

  const toMs = (iso) => clock.parseIso(iso);

  /** ปัดครึ่งขึ้น 1 ตำแหน่งด้วยเลขจำนวนเต็ม (ไม่พึ่ง floating point) → ตัวเลขเช่น 85.7 */
  function pct1(num, den) {
    if (!den) return null;
    return Math.floor((num * 2000 + den) / (2 * den)) / 10;
  }

  function parsePeriod(raw, nowIso) {
    const s = raw === undefined || raw === '' ? nowIso.slice(0, 7) : String(raw).trim();
    if (!PERIOD_RE.test(s)) return null;
    return s;
  }
  function parseService(raw) {
    const s = raw === undefined || raw === '' ? 'ALL' : String(raw).trim();
    if (s === 'ALL') return s;
    return db.get('SELECT id FROM services WHERE id = ?', s) ? s : null;
  }

  function listServices() {
    const rows = db.all('SELECT id FROM services ORDER BY id').map((r) => r.id);
    return rows.length ? rows : ['SV-01', 'SV-02', 'SV-03'];
  }

  /** คำนวณตัวชี้วัดทั้งหมดของช่วง/บริการ (period = 'YYYY-MM' หรือ 'YYYY' · service = 'ALL' | id) */
  function computeMetrics(period, service) {
    const nowIso = clock.nowIso();
    const nowMs = clock.now();
    const svcSql = service === 'ALL' ? '' : ' AND service_id = ?';
    const svcArgs = service === 'ALL' ? [] : [service];
    const prefix = period + '%';

    const received = db.get(
      `SELECT COUNT(*) AS n FROM cases WHERE paid_at LIKE ?${svcSql}`, prefix, ...svcArgs
    ).n;

    const closedRows = db.all(
      `SELECT closed_at, due_at FROM cases WHERE status IN ('COMPLETED','REJECTED') AND closed_at LIKE ?${svcSql}`,
      prefix, ...svcArgs
    );
    let onTime = 0;
    for (const r of closedRows) {
      const c = toMs(r.closed_at);
      const d = toMs(r.due_at);
      if (c !== null && d !== null && c <= d) onTime += 1;
    }
    const closed = closedRows.length;

    // BUG B10: หารด้วย "รับเรื่อง" แทน "ปิดงาน" (พ.ย. 6÷26 = 23.1% · ธ.ค. 0÷3 = 0.0%)
    const ontimePct = bug('B10') ? pct1(onTime, received) : pct1(onTime, closed);

    const backlogRows = db.all(
      `SELECT status, due_at FROM cases WHERE status IN (${BACKLOG_STATUSES.map(() => '?').join(',')})${svcSql}`,
      ...BACKLOG_STATUSES, ...svcArgs
    );
    let overdue = 0;
    for (const r of backlogRows) {
      if (r.status === 'NEED_FIX') continue; // หยุดนับ SLA ระหว่างรอแก้ไข
      const d = toMs(r.due_at);
      if (d !== null && nowMs > d) overdue += 1;
    }

    const hand = new Map(db.all(
      `SELECT owner, COUNT(*) AS n FROM cases WHERE status = 'IN_REVIEW' AND owner IS NOT NULL AND owner <> ''${svcSql} GROUP BY owner`,
      ...svcArgs
    ).map((r) => [r.owner, r.n]));
    const officers = db.all(`SELECT username FROM users WHERE role = 'officer' ORDER BY username`).map((r) => r.username);
    for (const u of hand.keys()) if (!officers.includes(u)) officers.push(u);
    const workload = officers.map((username) => ({ username, count: hand.get(username) || 0 }));

    return {
      period, service, asOf: nowIso,
      received, closed, onTime, ontimePct,
      backlog: backlogRows.length, overdue, workload,
    };
  }

  const fmtPct = (p) => (p === null || p === undefined ? DASH : p.toFixed(1) + '%');
  const fmtPctAscii = (p) => (p === null || p === undefined ? '-' : p.toFixed(1) + '%');

  /** ตัวอ่านพารามิเตอร์ period/service → {period, service} หรือส่ง 400 แล้วคืน null */
  function readParams(req, res) {
    const period = parsePeriod(req.query.period, clock.nowIso());
    if (!period) { apiError(res, 400, 'INVALID_PERIOD', ERR.INVALID_PERIOD); return null; }
    const service = parseService(req.query.service);
    if (!service) { apiError(res, 400, 'INVALID_SERVICE', ERR.INVALID_SERVICE); return null; }
    return { period, service };
  }

  app.get('/api/dashboard', (req, res) => {
    const p = readParams(req, res);
    if (!p) return;
    const m = computeMetrics(p.period, p.service);
    res.set('Cache-Control', 'no-store').json({
      received: m.received, closed: m.closed, onTime: m.onTime, ontimePct: m.ontimePct,
      backlog: m.backlog, overdue: m.overdue, workload: m.workload,
      period: m.period, service: m.service,
    });
  });

  /* ============================================================== ส่งออก Dashboard (xlsx / pdf) */

  /** แถวตัวชี้วัดที่ใช้ร่วมกันทั้งหน้าจอและไฟล์ — ค่าเป็นข้อความเหมือนบนจอ */
  function kpiRows(m) {
    return [
      ['รับเรื่อง', String(m.received)],
      ['ปิดงาน', String(m.closed)],
      ['ทันกำหนด %', fmtPct(m.ontimePct)],
      ['งานคงค้าง', String(m.backlog)],
      ['เกินกำหนดคงค้าง', String(m.overdue)],
    ];
  }

  async function buildXlsx(m) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'e-Service';
    const ws = wb.addWorksheet('Dashboard');
    ws.columns = [{ width: 28 }, { width: 18 }];
    ws.addRow(['ตัวชี้วัด', 'ค่า']).font = { bold: true };
    for (const [k, v] of kpiRows(m)) {
      const row = ws.addRow([k, v]);
      row.getCell(2).numFmt = '@'; // เก็บเป็นข้อความ
    }
    ws.addRow([]);
    ws.addRow(['ช่วง', m.period]);
    ws.addRow(['บริการ', m.service]);
    ws.addRow(['ข้อมูล ณ', m.asOf]);
    ws.addRow([]);
    ws.addRow(['งานในมือรายเจ้าหน้าที่', 'จำนวน']).font = { bold: true };
    for (const w of m.workload) ws.addRow([w.username, String(w.count)]);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  function findThaiFont() {
    for (const f of THAI_FONT_CANDIDATES) {
      try { if (fs.existsSync(f)) return f; } catch (_) { /* ข้าม */ }
    }
    return null;
  }

  function buildPdf(m) {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 50, compress: false, info: { Title: 'Dashboard report', Author: 'e-Service' } });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      let thai = null;
      const fontPath = findThaiFont();
      if (fontPath) {
        try { doc.registerFont('th', fontPath); thai = 'th'; } catch (_) { thai = null; }
      }
      const th = (text, opts) => { // ข้อความไทย ถ้าไม่มีฟอนต์ไทยในเครื่องจะข้าม (ASCII ครบทุกค่าอยู่แล้ว)
        if (!thai) return;
        doc.font(thai).text(text, opts);
      };
      const en = (text, opts) => doc.font('Courier').text(text, opts); // Courier ไม่มี kerning → บรรทัดเดียวต่อเนื่อง สกัดข้อความได้ตรง

      en('Dashboard report', { align: 'left' });
      doc.moveDown(0.3);
      th('รายงาน Dashboard e-Service เทศบาลนครตัวอย่าง');
      en(`period ${m.period} service ${m.service} as-of ${m.asOf}`);
      doc.moveDown();
      for (const [k, v] of kpiRows(m)) {
        if (thai) doc.font(thai).text(`${k}: ${v}`);
      }
      doc.moveDown();
      // บรรทัด ASCII เดียวที่เครื่องอ่านได้ (CONTRACT §7)
      en(`kpi received=${m.received} closed=${m.closed} ontime=${fmtPctAscii(m.ontimePct)} backlog=${m.backlog} overdue=${m.overdue}`);
      doc.moveDown();
      en('workload (IN_REVIEW per officer)');
      for (const w of m.workload) en(`  ${w.username}: ${w.count}`);
      doc.end();
    });
  }

  app.get('/api/dashboard/export', http.wrap(async (req, res) => {
    const format = String(req.query.format || '').toLowerCase();
    if (format !== 'xlsx' && format !== 'pdf') return apiError(res, 400, 'INVALID_FORMAT', ERR.INVALID_FORMAT);
    const p = readParams(req, res);
    if (!p) return;
    const m = computeMetrics(p.period, p.service);
    const buf = format === 'xlsx' ? await buildXlsx(m) : await buildPdf(m);
    audit.log(req.user, { event: 'EXPORT', detail: `${format} ${p.period} ${p.service}` });
    const fname = `dashboard-${p.period}-${p.service}.${format}`;
    res.set({
      'Content-Type': format === 'xlsx'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'application/pdf',
      'Content-Disposition': `attachment; filename="${fname}"`,
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  }));

  /* ============================================================== หน้า /dashboard */

  const periodOptions = () => {
    const nowYear = clock.nowIso().slice(0, 4);
    const cur = clock.nowIso().slice(0, 7);
    const opts = [cur];
    for (const o of ['2026-11', '2026-10']) if (!opts.includes(o)) opts.push(o);
    if (!opts.includes(nowYear)) opts.push(nowYear);
    // ปีของนาฬิกา = ทั้งปี (2026 = พ.ศ. 2569)
    const yearOpt = nowYear;
    const label = (v) => {
      if (/^\d{4}$/.test(v)) return `ทั้งปี ${Number(v) + 543}`;
      const [y, mo] = v.split('-').map(Number);
      return `${view.MONTHS[mo - 1]} ${y + 543}`;
    };
    return { opts: [...new Set([...opts, yearOpt])], label };
  };

  app.get('/dashboard', (req, res) => {
    const period = parsePeriod(req.query.period, clock.nowIso()) || clock.nowIso().slice(0, 7);
    const service = parseService(req.query.service) || 'ALL';
    const m = computeMetrics(period, service);
    const { opts, label } = periodOptions();
    if (!opts.includes(period)) opts.push(period);
    const svcLabel = (id) => (id === 'ALL' ? 'ทั้งหมด' : id);

    const body = `<h1>Dashboard ผู้บริหาร</h1>
<div class="toolbar filters">
  <div class="field"><label for="period-select">ช่วงเวลา</label>
    <select id="period-select" data-testid="period-select">
      ${opts.map((o) => `<option value="${esc(o)}"${o === period ? ' selected' : ''}>${esc(label(o))}</option>`).join('\n      ')}
    </select></div>
  <div class="field"><label for="service-select">บริการ</label>
    <select id="service-select" data-testid="service-select">
      ${['ALL', ...listServices()].map((o) => `<option value="${esc(o)}"${o === service ? ' selected' : ''}>${esc(svcLabel(o))}</option>`).join('\n      ')}
    </select></div>
</div>
<div class="stats dashboard-grid" aria-live="polite">
  <div class="card stat-card"><h2>รับเรื่อง</h2><p class="stat" data-testid="kpi-received">${m.received}</p></div>
  <div class="card stat-card"><h2>ปิดงาน</h2><p class="stat" data-testid="kpi-closed">${m.closed}</p></div>
  <div class="card stat-card"><h2>ทันกำหนด %</h2><p class="stat" data-testid="kpi-ontime-pct">${esc(fmtPct(m.ontimePct))}</p></div>
  <div class="card stat-card"><h2>งานคงค้าง</h2><p class="stat" data-testid="kpi-backlog">${m.backlog}</p></div>
  <div class="card stat-card"><h2>เกินกำหนดคงค้าง</h2><p class="stat" data-testid="kpi-overdue">${m.overdue}</p></div>
</div>
<p class="muted">งานคงค้างและเกินกำหนดคงค้างเป็นค่า ณ ปัจจุบัน ไม่เปลี่ยนตามช่วงเวลาที่เลือก</p>
<h2>งานในมือรายเจ้าหน้าที่</h2>
<div class="table-wrap"><table>
  <caption>งานที่กำลังตรวจสอบ (IN_REVIEW) ของเจ้าหน้าที่แต่ละคน</caption>
  <thead><tr><th scope="col">เจ้าหน้าที่</th><th scope="col">จำนวนงาน</th></tr></thead>
  <tbody id="workload-body">
${m.workload.map((w) => `    <tr data-testid="workload-row" data-username="${esc(w.username)}"><td>${esc(w.username)}</td><td data-testid="workload-value">${w.count}</td></tr>`).join('\n')}
  </tbody>
</table></div>
<div class="actions">
  <button type="button" data-testid="export-xlsx-btn" id="export-xlsx-btn">ส่งออก Excel</button>
  <button type="button" data-testid="export-pdf-btn" id="export-pdf-btn">ส่งออก PDF</button>
</div>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var seq = 0;
  function qs() { return 'period=' + encodeURIComponent($('period-select').value) + '&service=' + encodeURIComponent($('service-select').value); }
  function set(testid, text) { var el = document.querySelector('[data-testid="' + testid + '"]'); if (el) el.textContent = text; }
  function render(d) {
    set('kpi-received', String(d.received));
    set('kpi-closed', String(d.closed));
    set('kpi-ontime-pct', d.ontimePct === null || d.ontimePct === undefined ? '${DASH}' : Number(d.ontimePct).toFixed(1) + '%');
    set('kpi-backlog', String(d.backlog));
    set('kpi-overdue', String(d.overdue));
    var tb = $('workload-body'); tb.innerHTML = '';
    d.workload.forEach(function (w) {
      var tr = document.createElement('tr');
      tr.setAttribute('data-testid', 'workload-row'); tr.setAttribute('data-username', w.username);
      var a = document.createElement('td'); a.textContent = w.username;
      var b = document.createElement('td'); b.setAttribute('data-testid', 'workload-value'); b.textContent = String(w.count);
      tr.appendChild(a); tr.appendChild(b); tb.appendChild(tr);
    });
  }
  function refresh() {
    var mine = ++seq;
    fetch('/api/dashboard?' + qs(), { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && mine === seq) render(d); });
    if (history.replaceState) history.replaceState(null, '', '/dashboard?' + qs());
  }
  $('period-select').addEventListener('change', refresh);
  $('service-select').addEventListener('change', refresh);
  function exp(fmt) { window.location.href = '/api/dashboard/export?format=' + fmt + '&' + qs(); }
  $('export-xlsx-btn').addEventListener('click', function () { exp('xlsx'); });
  $('export-pdf-btn').addEventListener('click', function () { exp('pdf'); });
})();
</script>`;
    view.page(req, res, { title: 'Dashboard', body });
  });

  /* ============================================================== Audit Trail */

  /** อ่านตัวกรอง Audit → {where, args, filters} หรือ {error:{code,message}} */
  function auditFilter(q) {
    const actor = String(q.actor || '').trim();
    const event = String(q.event || '').trim();
    const from = String(q.from || '').trim();
    const to = String(q.to || '').trim();
    if (event && !AUDIT_EVENTS.includes(event)) return { error: { code: 'INVALID_EVENT', message: ERR.INVALID_EVENT } };
    for (const d of [from, to]) {
      if (d && (!DATE_RE.test(d) || clock.parseIso(`${d}T00:00:00+07:00`) === null)) {
        return { error: { code: 'INVALID_DATE', message: ERR.INVALID_DATE } };
      }
    }
    const where = [];
    const args = [];
    if (actor) { where.push('username = ?'); args.push(actor); }
    if (event) { where.push('event = ?'); args.push(event); }
    // เวลาเก็บเป็น ISO +07:00 เสมอ → 10 ตัวแรกคือวันที่ตามเวลาไทย (รวมทั้งวันเริ่มและวันจบ)
    if (from) { where.push('substr(time, 1, 10) >= ?'); args.push(from); }
    if (to) { where.push('substr(time, 1, 10) <= ?'); args.push(to); }
    return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', args, filters: { actor, event, from, to } };
  }

  function auditRows(f) {
    return db.all(`SELECT * FROM audit_log ${f.where} ORDER BY time DESC, id DESC`, ...f.args);
  }
  const auditItem = (r) => ({
    id: r.id, time: r.time, username: r.username, role: r.role, event: r.event,
    caseNo: r.case_no || '', fromStatus: r.from_status || '', toStatus: r.to_status || '', detail: r.detail || '',
  });

  app.get('/api/audit', (req, res) => {
    const f = auditFilter(req.query);
    if (f.error) return apiError(res, 400, f.error.code, f.error.message);
    const items = auditRows(f).map(auditItem);
    res.set('Cache-Control', 'no-store').json({ count: items.length, items });
  });

  // Audit เพิ่มได้อย่างเดียว: เมธอดเขียนทุกชนิดตอบ 405 (auth.js ตอบแล้ว · เผื่อลำดับโมดูลเปลี่ยน)
  app.all(['/api/audit', '/api/audit/:id'], (req, res, next) => {
    if (['PUT', 'PATCH', 'DELETE', 'POST'].includes(req.method)) {
      return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method Not Allowed');
    }
    return next();
  });

  /** CSV: ป้องกัน formula injection (= + - @ ขึ้นต้น) แล้วครอบด้วย " เมื่อมี , " หรือขึ้นบรรทัดใหม่ */
  function csvCell(v) {
    let s = String(v === null || v === undefined ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  app.get('/api/audit/export.csv', (req, res) => {
    const f = auditFilter(req.query);
    if (f.error) return apiError(res, 400, f.error.code, f.error.message);
    const header = 'time,username,role,event,caseNo,fromStatus,toStatus,detail';
    const lines = auditRows(f).map(auditItem).map((r) =>
      [r.time, r.username, r.role, r.event, r.caseNo, r.fromStatus, r.toStatus, r.detail].map(csvCell).join(','));
    const csv = [header, ...lines].join('\r\n') + '\r\n';
    audit.log(req.user, { event: 'EXPORT', detail: 'audit-csv' }); // บันทึกหลังสร้างไฟล์ (ไฟล์นี้ไม่รวมแถวของตัวเอง)
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="audit-trail.csv"',
      'Cache-Control': 'no-store',
    });
    res.send(csv);
  });

  app.get('/audit', (req, res) => {
    let f = auditFilter(req.query);
    let note = '';
    if (f.error) { note = f.error.message; f = auditFilter({}); }
    const rows = auditRows(f).map(auditItem);
    const fl = f.filters;
    const csvQs = new URLSearchParams(Object.entries(fl).filter(([, v]) => v)).toString();
    const body = `<h1>Audit Trail</h1>
<form method="get" action="/audit" class="toolbar filters" data-testid="audit-filter-form">
  <div class="field"><label for="audit-filter-actor">ผู้ทำ (username)</label>
    <input type="text" id="audit-filter-actor" name="actor" data-testid="audit-filter-actor" value="${esc(fl.actor)}" autocomplete="off"></div>
  <div class="field"><label for="audit-filter-event">เหตุการณ์</label>
    <select id="audit-filter-event" name="event" data-testid="audit-filter-event">
      <option value=""${fl.event ? '' : ' selected'}>ทั้งหมด</option>
      ${AUDIT_EVENTS.map((e) => `<option value="${e}"${fl.event === e ? ' selected' : ''}>${e}</option>`).join('\n      ')}
    </select></div>
  <div class="field"><label for="audit-filter-from">ตั้งแต่วันที่</label>
    <input type="date" id="audit-filter-from" name="from" data-testid="audit-filter-from" value="${esc(fl.from)}"></div>
  <div class="field"><label for="audit-filter-to">ถึงวันที่</label>
    <input type="date" id="audit-filter-to" name="to" data-testid="audit-filter-to" value="${esc(fl.to)}"></div>
  <button type="submit" data-testid="audit-apply-btn" id="audit-apply-btn">ค้นหา</button>
</form>
${note ? `<p class="msg msg-error" role="alert">${esc(note)}</p>` : ''}
<p>พบ <strong data-testid="audit-count">${rows.length}</strong> รายการ</p>
<div class="actions">
  <button type="button" data-testid="audit-export-csv-btn" id="audit-export-csv-btn" data-href="/api/audit/export.csv${csvQs ? '?' + esc(csvQs) : ''}">ส่งออก CSV</button>
</div>
<div class="table-wrap"><table>
  <caption>บันทึกเหตุการณ์ (ใหม่ → เก่า · อ่านอย่างเดียว)</caption>
  <thead><tr>
    <th scope="col">เวลา</th><th scope="col">ผู้ทำ</th><th scope="col">บทบาท</th><th scope="col">เหตุการณ์</th>
    <th scope="col">เลขคำขอ</th><th scope="col">สถานะก่อน → หลัง</th><th scope="col">รายละเอียด / เหตุผล</th>
  </tr></thead>
  <tbody>
${rows.map((r) => `    <tr data-testid="audit-row" data-id="${r.id}" data-event="${esc(r.event)}" data-actor="${esc(r.username)}" data-case-no="${esc(r.caseNo)}">
      <td>${view.dt(r.time, 'data-testid="audit-time"')}</td>
      <td data-testid="audit-actor">${esc(r.username)}</td>
      <td data-testid="audit-role">${esc(r.role)}</td>
      <td data-testid="audit-event">${esc(r.event)}</td>
      <td data-testid="audit-case-no">${r.caseNo ? esc(r.caseNo) : DASH}</td>
      <td data-testid="audit-transition">${r.fromStatus || r.toStatus ? esc(`${r.fromStatus || DASH} → ${r.toStatus || DASH}`) : DASH}</td>
      <td data-testid="audit-detail">${esc(r.detail)}</td>
    </tr>`).join('\n')}
  </tbody>
</table></div>
<script>
document.getElementById('audit-export-csv-btn').addEventListener('click', function () {
  window.location.href = this.getAttribute('data-href');
});
</script>`;
    view.page(req, res, { title: 'Audit Trail', body });
  });

  /* ============================================================== แสดงเลขบัตรเต็ม (FR-21) */

  /** officer: ตามสิทธิ์เปิดคำขอ (ทะเบียนทุกใบ · โยธาเฉพาะ SV-03 ที่ถึงขั้น 2 แล้ว) · head: ทุกแผนก */
  function staffMayOpen(user, c) {
    if (user.role === 'head') return true;
    if (user.role !== 'officer') return false;
    if (user.dept === 'registry') return true;
    if (user.dept === 'works') return c.service_id === 'SV-03' && (c.step == null || c.step >= 2);
    return false;
  }

  app.post('/api/officer/cases/:caseNo/unmask', (req, res) => {
    const user = req.user;
    if (!user || (user.role !== 'officer' && user.role !== 'head')) {
      return apiError(res, 403, 'FORBIDDEN', ERR.FORBIDDEN);
    }
    const c = db.get('SELECT * FROM cases WHERE case_no = ?', req.params.caseNo);
    if (!c) return apiError(res, 404, 'NOT_FOUND', ERR.NOT_FOUND);
    if (!staffMayOpen(user, c)) return apiError(res, 403, 'FORBIDDEN', ERR.FORBIDDEN);
    const reason = typeof (req.body || {}).reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) return apiError(res, 400, 'REASON_REQUIRED', ERR.REASON_REQUIRED);
    const ap = db.get('SELECT id_enc FROM users WHERE username = ?', c.applicant);
    const idNo = ap && ap.id_enc ? ctx.security.decrypt(ap.id_enc) : null;
    if (!idNo) return apiError(res, 404, 'NOT_FOUND', ERR.NOT_FOUND);
    // BUG B11: ไม่บันทึก Audit UNMASK
    if (!bug('B11')) audit.log(user, { event: 'UNMASK', caseNo: c.case_no, detail: reason });
    res.set('Cache-Control', 'no-store').json({ idNo });
  });
}

module.exports = { register };
