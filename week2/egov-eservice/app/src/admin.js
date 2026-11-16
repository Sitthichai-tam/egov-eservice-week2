'use strict';

// B10: CONTRACT §2.11 / §6.5. Only configuration is changed here; existing
// drafts, payment amounts, case due dates and session role snapshots stay intact.
const ROLES = ['citizen', 'officer', 'head', 'executive', 'auditor', 'admin'];
const DEPTS = ['', 'registry', 'works'];
const MESSAGES = {
  INVALID_FEE: 'ค่าธรรมเนียมต้องเป็นจำนวนเต็ม 0–100,000 บาท',
  INVALID_SLA: 'SLA ต้องเป็นจำนวนเต็ม 1–60 วันทำการ',
  DUPLICATE_HOLIDAY: 'มีวันหยุดนี้อยู่แล้ว',
  SELF_ROLE_CHANGE: 'ไม่สามารถเปลี่ยนบทบาทของตัวเองได้',
};
const inRange = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00+07:00');
  return Number.isFinite(date.getTime()) && new Date(date.getTime() + 7 * 3600000).toISOString().slice(0, 10) === value;
}

function register(app, ctx) {
  const { db, http, view, audit } = ctx;
  const esc = view.esc;
  const fail = (res, status, code, message) => http.apiError(res, status, code, message || MESSAGES[code]);
  const services = () => db.all('SELECT * FROM services ORDER BY sort, id');
  const holidays = () => db.all('SELECT date, name FROM holidays ORDER BY date');
  // Whitelist response columns: never disclose hashes or encrypted personal data.
  const users = () => db.all('SELECT username, name, role, dept FROM users ORDER BY username');
  const serviceJson = (row) => ({ id: row.id, fee: row.fee, feePerSqm: row.fee_per_sqm, sla: row.sla });
  const changed = (req, detail, fn) => db.tx(() => {
    fn();
    audit.log(req.user, { event: 'ADMIN_CHANGE', detail });
  });

  app.get('/api/admin/services', (_req, res) => res.json({ items: services().map(serviceJson) }));
  app.put('/api/admin/services/:id', (req, res) => {
    const row = db.get('SELECT * FROM services WHERE id = ?', req.params.id);
    if (!row) return fail(res, 404, 'NOT_FOUND', 'ไม่พบบริการ');
    const body = req.body || {};
    const feeKey = row.id === 'SV-03' && has(body, 'feeBase') ? 'feeBase' : 'fee';
    const fee = has(body, feeKey) ? body[feeKey] : row.fee;
    const per = has(body, 'feePerSqm') ? body.feePerSqm : row.fee_per_sqm;
    const sla = has(body, 'sla') ? body.sla : row.sla;
    if (!inRange(fee, 0, 100000) || !inRange(per, 0, 100000)) return fail(res, 400, 'INVALID_FEE');
    if (!inRange(sla, 1, 60)) return fail(res, 400, 'INVALID_SLA');
    const detail = [];
    if (fee !== row.fee) detail.push(`${row.id} fee ${row.fee} → ${fee}`);
    if (per !== row.fee_per_sqm) detail.push(`${row.id} feePerSqm ${row.fee_per_sqm} → ${per}`);
    if (sla !== row.sla) detail.push(`${row.id} sla ${row.sla} → ${sla}`);
    changed(req, detail.join('; ') || `${row.id} unchanged`, () => {
      db.run('UPDATE services SET fee = ?, fee_per_sqm = ?, sla = ? WHERE id = ?', fee, per, sla, row.id);
    });
    return res.json({ id: row.id, fee, feePerSqm: per, sla });
  });

  app.get('/api/admin/holidays', (_req, res) => res.json({ items: holidays() }));
  app.post('/api/admin/holidays', (req, res) => {
    const { date, name } = req.body || {};
    if (!validDate(date)) return fail(res, 400, 'INVALID_DATE', 'วันที่ไม่ถูกต้อง');
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 200) return fail(res, 400, 'INVALID_NAME', 'กรุณาระบุชื่อวันหยุดไม่เกิน 200 ตัวอักษร');
    if (db.get('SELECT date FROM holidays WHERE date = ?', date)) return fail(res, 409, 'DUPLICATE_HOLIDAY');
    changed(req, `holiday add ${date}`, () => db.run('INSERT INTO holidays(date, name) VALUES(?, ?)', date, name.trim()));
    return res.status(201).json({ date, name: name.trim() });
  });
  app.delete('/api/admin/holidays/:date', (req, res) => {
    const date = req.params.date;
    if (!db.get('SELECT date FROM holidays WHERE date = ?', date)) return fail(res, 404, 'NOT_FOUND', 'ไม่พบวันหยุด');
    changed(req, `holiday delete ${date}`, () => db.run('DELETE FROM holidays WHERE date = ?', date));
    return res.json({ deleted: true, date });
  });

  app.get('/api/admin/users', (_req, res) => res.json({ items: users() }));
  app.put('/api/admin/users/:username', (req, res) => {
    if (req.params.username === req.user.username) return fail(res, 409, 'SELF_ROLE_CHANGE');
    const row = db.get('SELECT username, role, dept FROM users WHERE username = ?', req.params.username);
    if (!row) return fail(res, 404, 'NOT_FOUND', 'ไม่พบผู้ใช้');
    const { role, dept = '' } = req.body || {};
    if (!ROLES.includes(role)) return fail(res, 400, 'INVALID_ROLE', 'บทบาทไม่ถูกต้อง');
    if (!DEPTS.includes(dept) || (role === 'officer' && !dept) || (role !== 'officer' && dept !== '')) {
      return fail(res, 400, 'INVALID_DEPT', 'แผนกไม่ถูกต้อง');
    }
    let detail = `${row.username} role ${row.role} → ${role}`;
    if (row.dept !== dept) detail += `; dept ${row.dept} → ${dept}`;
    changed(req, detail, () => db.run('UPDATE users SET role = ?, dept = ? WHERE username = ?', role, dept, row.username));
    return res.json({ username: row.username, role, dept });
  });

  // Forms use novalidate so rejected boundary values reach the API and display
  // the exact CONTRACT action-error, rather than a browser-specific tooltip.
  const number = (testid, label, value, min, max) => `<div class="field"><label for="${testid}">${esc(label)}</label><input id="${testid}" data-testid="${testid}" type="number" min="${min}" max="${max}" step="1" value="${value}"></div>`;
  const script = `<script>
  (function () {
    // ใช้กล่อง action-error/action-success กลางของ view.js (ต้องมีอย่างละกล่องเดียวต่อหน้า)
    function box(id) { return document.querySelector('[data-testid="' + id + '"]'); }
    function message(ok, text) {
      const on = box(ok ? 'action-success' : 'action-error'), off = box(ok ? 'action-error' : 'action-success');
      off.hidden = true; off.textContent = '';
      on.textContent = text; on.hidden = !text;
    }
    if (new URLSearchParams(location.search).get('saved') === '1') message(true, 'บันทึกสำเร็จ');
    function value(id) { return document.getElementById(id).value; }
    function numeric(id) { const v = value(id); return v.trim() === '' ? null : Number(v); }
    async function send(url, method, body, refresh) {
      try {
        const r = await fetch(url, {method, credentials:'same-origin', headers:{'Content-Type':'application/json'}, body:body === undefined ? undefined : JSON.stringify(body)});
        const data = await r.json();
        message(r.ok, r.ok ? 'บันทึกสำเร็จ' : data.message);
        if (r.ok && refresh) location.href = location.pathname + '?saved=1';
      } catch (_) { message(false, 'ไม่สามารถเชื่อมต่อระบบได้ กรุณาลองใหม่'); }
    }
    document.querySelectorAll('form[data-service-id]').forEach(form => form.addEventListener('submit', e => {
      e.preventDefault(); const id = form.dataset.serviceId;
      const body = {sla:numeric('svc-sla-' + id)};
      body[id === 'SV-03' ? 'feeBase' : 'fee'] = numeric('svc-fee-' + id);
      if (id === 'SV-03') body.feePerSqm = numeric('svc-fee-per-sqm-' + id);
      send('/api/admin/services/' + id, 'PUT', body);
    }));
    const holiday = document.getElementById('holiday-form');
    if (holiday) holiday.addEventListener('submit', e => {
      e.preventDefault(); send('/api/admin/holidays', 'POST', {date:value('holiday-date-input'), name:value('holiday-name-input')}, true);
    });
    document.querySelectorAll('[data-testid="holiday-delete-btn"]').forEach(button => button.addEventListener('click', () => send('/api/admin/holidays/' + encodeURIComponent(button.dataset.date), 'DELETE', undefined, true)));
    document.querySelectorAll('[data-testid="user-save-btn"]').forEach(button => button.addEventListener('click', () => {
      const row = button.closest('[data-username]');
      send('/api/admin/users/' + encodeURIComponent(row.dataset.username), 'PUT', {role:row.querySelector('[data-testid="user-role-select"]').value, dept:row.querySelector('[data-testid="user-dept-select"]').value});
    }));
  })();
  </script>`;
  function page(req, res, title, content) {
    view.page(req, res, { title, body: `<h1>${esc(title)}</h1>${content}${script}` });
  }

  app.get('/admin', (_req, res) => res.redirect('/admin/services'));
  app.get('/admin/services', (req, res) => page(req, res, 'จัดการบริการ', services().map(row => `
    <section class="card" data-testid="service-row" data-service-id="${esc(row.id)}">
      <h2>${esc(row.id)} ${esc(row.name)}</h2><form data-service-id="${esc(row.id)}" novalidate>
      ${number('svc-fee-' + row.id, row.id === 'SV-03' ? 'ค่าธรรมเนียมฐาน (บาท สำหรับพื้นที่ 1–100 ตร.ม.)' : row.id === 'SV-01' ? 'ค่าธรรมเนียมต่อฉบับ (บาท)' : 'ค่าธรรมเนียม (บาท)', row.fee, 0, 100000)}
      ${row.id === 'SV-03' ? number('svc-fee-per-sqm-' + row.id, 'ค่าธรรมเนียมต่อ ตร.ม. ส่วนที่เกิน 100 ตร.ม. (บาท)', row.fee_per_sqm, 0, 100000) : ''}
      ${number('svc-sla-' + row.id, 'SLA (วันทำการ)', row.sla, 1, 60)}
      <button type="submit" data-testid="svc-save-${esc(row.id)}">บันทึก</button></form>
    </section>`).join('')));

  app.get('/admin/holidays', (req, res) => page(req, res, 'จัดการวันหยุด', `
    <form class="card" id="holiday-form" novalidate>
      <div class="field"><label for="holiday-date-input">วันที่ (ค.ศ.)</label><input id="holiday-date-input" data-testid="holiday-date-input" type="date"></div>
      <div class="field"><label for="holiday-name-input">ชื่อวันหยุด</label><input id="holiday-name-input" data-testid="holiday-name-input" maxlength="200"></div>
      <button type="submit" data-testid="holiday-add-btn">เพิ่มวันหยุด</button>
    </form><div class="table-wrap"><table><caption>วันหยุดของเทศบาล</caption><thead><tr><th scope="col">วันที่</th><th scope="col">ชื่อวันหยุด</th><th scope="col">จัดการ</th></tr></thead><tbody>
    ${holidays().map(row => `<tr data-testid="holiday-row" data-date="${esc(row.date)}"><td>${esc(row.date)}</td><td>${esc(row.name)}</td><td><button type="button" data-testid="holiday-delete-btn" data-date="${esc(row.date)}" aria-label="ลบวันหยุด ${esc(row.date)}">ลบ</button></td></tr>`).join('')}
    </tbody></table></div>`));

  function options(values, selected) {
    return values.map(value => `<option value="${value}"${selected === value ? ' selected' : ''}>${value || 'ไม่มีแผนก'}</option>`).join('');
  }
  app.get('/admin/users', (req, res) => page(req, res, 'จัดการผู้ใช้และบทบาท', `
    <p>การเปลี่ยนบทบาทและแผนกมีผลเมื่อเข้าสู่ระบบครั้งถัดไป</p>
    <div class="table-wrap"><table><caption>ผู้ใช้ในระบบ</caption><thead><tr><th scope="col">ชื่อผู้ใช้</th><th scope="col">ชื่อ</th><th scope="col">บทบาท</th><th scope="col">แผนก</th><th scope="col">จัดการ</th></tr></thead><tbody>
    ${users().map(row => `<tr data-testid="user-row" data-username="${esc(row.username)}"><th scope="row">${esc(row.username)}</th><td>${esc(row.name)}</td>
      <td><label for="role-${esc(row.username)}">บทบาท ${esc(row.username)}</label><select id="role-${esc(row.username)}" data-testid="user-role-select">${options(ROLES, row.role)}</select></td>
      <td><label for="dept-${esc(row.username)}">แผนก ${esc(row.username)}</label><select id="dept-${esc(row.username)}" data-testid="user-dept-select">${options(DEPTS, row.dept)}</select></td>
      <td><button type="button" data-testid="user-save-btn" aria-label="บันทึก ${esc(row.username)}">บันทึก</button></td></tr>`).join('')}
    </tbody></table></div>`));
}

module.exports = { register };
