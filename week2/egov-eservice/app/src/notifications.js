'use strict';

// B08 · FR-19/20, BR-15, DECISIONS §8/A-30/A-31.
// The shared view renders bell-count from this table; reset clears it centrally.
const rules = require('./rules');

function recipients(caseRow, level, staff) {
  const heads = staff.filter((user) => user.role === 'head').map((user) => user.username);
  const result = new Set();
  if (caseRow.status === 'PENDING_APPROVAL') {
    heads.forEach((username) => result.add(username));
  } else if (caseRow.status === 'APPROVED') {
    if (caseRow.issuer) result.add(caseRow.issuer);
  } else if (caseRow.owner) {
    result.add(caseRow.owner);
  } else {
    staff.filter((user) => user.role === 'officer' && user.dept === caseRow.dept)
      .forEach((user) => result.add(user.username));
  }
  if (level === 'overdue') heads.forEach((username) => result.add(username));
  return [...result];
}

function evaluate(ctx) {
  const { db, clock } = ctx;
  // One clock snapshot and fresh holidays per evaluation, including admin changes.
  const nowMs = clock.now();
  const createdAt = clock.toIso(nowMs);
  return db.tx(() => {
    const holidays = rules.loadHolidays(db);
    const staff = db.all("SELECT username, role, dept FROM users WHERE role IN ('officer','head')");
    const cases = db.all(`SELECT case_no, status, due_at, owner, dept, issuer FROM cases
      WHERE due_at IS NOT NULL AND status IN ('SUBMITTED','IN_REVIEW','PENDING_APPROVAL','APPROVED')
      ORDER BY case_no`);
    let inserted = 0;
    for (const caseRow of cases) {
      const level = rules.slaLevel({ status: caseRow.status, dueAt: caseRow.due_at, nowMs, holidays });
      // Do not backfill near when the first request is already overdue.
      if (level !== 'near' && level !== 'overdue') continue;
      const text = `คำขอ ${caseRow.case_no} ${rules.slaLevelTh(level)}`;
      for (const username of recipients(caseRow, level, staff)) {
        inserted += Number(db.run(`INSERT INTO notifications
          (username, case_no, level, text, created_at, dedupe_key) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(username, dedupe_key) DO NOTHING`,
        username, caseRow.case_no, level, text, createdAt, `${caseRow.case_no}|${level}`).changes);
      }
    }
    return inserted;
  });
}

function listForUser(db, username) {
  return db.all(`SELECT id, case_no AS caseNo, level, text, created_at AS createdAt
    FROM notifications WHERE username = ? ORDER BY created_at DESC, id DESC`, username);
}

function register(app, ctx) {
  ctx.onRequest(() => evaluate(ctx));

  app.get('/api/notifications', ctx.http.requireApi('officer', 'head'), (req, res) => {
    res.json({ items: listForUser(ctx.db, req.user.username) });
  });

  app.get('/notifications', ctx.http.requirePage('officer', 'head'), (req, res) => {
    const { esc } = ctx.view;
    const items = listForUser(ctx.db, req.user.username);
    const body = items.length ? `<ul class="notification-list">${items.map((item) => `
      <li data-testid="noti-item" data-case-no="${esc(item.caseNo)}" data-level="${esc(item.level)}" data-created-at="${esc(item.createdAt)}" data-time="${esc(ctx.view.fmtDateTime(item.createdAt))}"><a href="/officer/cases/${encodeURIComponent(item.caseNo)}">${esc(item.text)}</a></li>`).join('')}</ul>` : '<p data-testid="noti-empty">ไม่มีแจ้งเตือน</p>';
    ctx.view.page(req, res, { title: 'แจ้งเตือน', body: `<h1>แจ้งเตือน</h1>${body}` });
  });
}

module.exports = { register, evaluate, recipients, listForUser };
