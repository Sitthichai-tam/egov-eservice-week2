'use strict';
// สคริปต์กลางทุกหน้า (B01) · เสนอ window.EG = { api, error, success }
(function () {
  function box(testid) { return document.querySelector('[data-testid="' + testid + '"]'); }
  function show(testid, text) {
    var other = box(testid === 'action-error' ? 'action-success' : 'action-error');
    if (other) { other.hidden = true; other.textContent = ''; }
    var el = box(testid);
    if (!el) return;
    el.textContent = text || '';
    el.hidden = !text;
  }
  // api('POST','/api/x',{…}) → {ok,status,data} · ไม่ throw
  async function api(method, url, body) {
    var opt = { method: method, headers: {}, credentials: 'same-origin' };
    if (body instanceof FormData) opt.body = body;
    else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    var r = await fetch(url, opt);
    var data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    return { ok: r.ok, status: r.status, data: data };
  }
  window.EG = {
    api: api,
    error: function (t) { show('action-error', t); },
    success: function (t) { show('action-success', t); },
  };
  var logout = document.getElementById('logout-btn');
  if (logout) {
    logout.addEventListener('click', async function () {
      await api('POST', '/api/auth/logout');
      location.href = '/login';
    });
  }
})();
