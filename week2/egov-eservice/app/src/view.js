'use strict';
/**
 * โครงหน้า HTML กลาง (CONTRACT §2.1 "ทุกหน้า") + ตัวจัดรูปแบบข้อความ (A-04 A-51)
 *   page(req, res, { title, body, scripts?, head?, status? })  ส่งหน้าเต็มพร้อมแถบหัว
 *   forbidden(req, res)  → 403 + data-testid="forbidden-msg" "ไม่มีสิทธิ์เข้าถึงหน้านี้"
 *   notFound(req, res, text?)  → 404 + data-testid="not-found-msg" "ไม่พบคำขอ"
 *   dt(iso)  → <time data-iso="…">4 ธ.ค. 2569 16:30</time> (HTML พร้อมใช้)
 *   fmtDateTime(iso) / fmtDate('YYYY-MM-DD') / money(1010) → "฿1,010"
 * สไตล์: /static/style.css (บล็อก B11) · สคริปต์กลาง /static/app.js (api(), toast, logout)
 */
const { db } = require('./db');
const clock = require('./clock');

const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const ROLE_LABEL = {
  citizen: 'ประชาชน', officer: 'เจ้าหน้าที่', head: 'หัวหน้าฝ่าย',
  executive: 'ผู้บริหาร', auditor: 'ผู้ตรวจสอบภายใน', admin: 'ผู้ดูแลระบบ',
};
const LANDING = {
  citizen: '/citizen', officer: '/officer/queue', head: '/head/approvals',
  executive: '/dashboard', auditor: '/audit', admin: '/admin/services',
};

const esc = (s) => String(s === null || s === undefined ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** ISO → "4 ธ.ค. 2569 16:30" (เวลาไทย) */
function fmtDateTime(iso) {
  const ms = clock.parseIso(iso);
  if (ms === null) return '';
  const p = clock.parts(ms);
  return `${p.d} ${MONTHS[p.m - 1]} ${p.be} ${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
}
/** 'YYYY-MM-DD' → "2 ก.พ. 2570" */
function fmtDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y) return '';
  return `${d} ${MONTHS[m - 1]} ${y + 543}`;
}
/** องค์ประกอบวันเวลาพร้อม data-iso (CONTRACT §0 ข้อ 3) · attrs เช่น 'data-testid="due-at"' */
function dt(iso, attrs = '') {
  if (!iso) return '';
  return `<time ${attrs} data-iso="${esc(iso)}">${esc(fmtDateTime(iso))}</time>`;
}
/** วันที่ล้วนพร้อม data-iso เป็น 'YYYY-MM-DD' */
function dd(dateStr, attrs = '') {
  if (!dateStr) return '';
  return `<time ${attrs} data-iso="${esc(dateStr)}">${esc(fmtDate(dateStr))}</time>`;
}
const money = (n) => '฿' + Number(n).toLocaleString('en-US');

function nav(user) {
  const items = [];
  const a = (testid, href, label) => items.push(`<a data-testid="${testid}" href="${href}">${label}</a>`);
  switch (user.role) {
    case 'citizen': a('nav-my-cases', '/citizen', 'คำขอของฉัน'); break;
    case 'officer': a('nav-queue', '/officer/queue', 'คิวงาน'); break;
    case 'head': a('nav-queue', '/officer/queue', 'คิวงาน'); a('nav-approvals', '/head/approvals', 'รออนุมัติ'); break;
    case 'executive': a('nav-dashboard', '/dashboard', 'Dashboard'); break;
    case 'auditor': a('nav-audit', '/audit', 'Audit Trail'); break;
    case 'admin':
      a('nav-admin-services', '/admin/services', 'บริการ');
      a('nav-admin-holidays', '/admin/holidays', 'วันหยุด');
      a('nav-admin-users', '/admin/users', 'ผู้ใช้');
      break;
    default: break;
  }
  if (user.role === 'officer' || user.role === 'head') {
    const n = db.get('SELECT COUNT(*) AS n FROM notifications WHERE username = ?', user.username).n;
    items.push(`<a data-testid="nav-bell" href="/notifications">แจ้งเตือน <span data-testid="bell-count">${n}</span></a>`);
  }
  return items.join('\n      ');
}

function header(user) {
  if (!user || user.kind !== 'full') return '';
  const dept = user.role === 'officer' ? ` data-dept="${esc(user.dept)}"` : '';
  return `<header data-testid="app-header" class="app-header">
  <div class="brand">e-Service เทศบาลนครตัวอย่าง</div>
  <nav aria-label="เมนูหลัก" class="app-nav">
      ${nav(user)}
  </nav>
  <div class="app-user">
    <span data-testid="user-name">${esc(user.name)}</span>
    <span data-testid="user-role" data-role="${esc(user.role)}"${dept}>${esc(ROLE_LABEL[user.role] || user.role)}</span>
    <button type="button" data-testid="logout-btn" id="logout-btn">ออกจากระบบ</button>
  </div>
</header>`;
}

/** ส่งหน้าเต็ม · body = HTML ของเนื้อหา (อยู่ใน <main>) */
function page(req, res, { title, body, scripts = [], head = '', status = 200 }) {
  const user = req && req.user;
  const scriptTags = ['/static/app.js', ...scripts].map((s) => `<script src="${esc(s)}" defer></script>`).join('\n');
  const html = `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · e-Service เทศบาลนครตัวอย่าง</title>
<link rel="stylesheet" href="/static/style.css">
${head}
</head>
<body>
<a class="skip-link" href="#main">ข้ามไปยังเนื้อหาหลัก</a>
${header(user)}
<main id="main" tabindex="-1">
<div data-testid="action-error" role="alert" class="msg msg-error" hidden></div>
<div data-testid="action-success" role="status" class="msg msg-success" hidden></div>
${body}
</main>
${scriptTags}
</body>
</html>`;
  res.status(status).type('html').send(html);
}

function forbidden(req, res) {
  page(req, res, {
    title: 'ไม่มีสิทธิ์', status: 403,
    body: '<h1>403</h1><p data-testid="forbidden-msg">ไม่มีสิทธิ์เข้าถึงหน้านี้</p>',
  });
}
function notFound(req, res, text = 'ไม่พบคำขอ') {
  page(req, res, {
    title: 'ไม่พบ', status: 404,
    body: `<h1>404</h1><p data-testid="not-found-msg">${esc(text)}</p>`,
  });
}

module.exports = { page, forbidden, notFound, esc, fmtDateTime, fmtDate, dt, dd, money, ROLE_LABEL, LANDING, MONTHS };
