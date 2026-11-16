'use strict';
/**
 * Test hook (CONTRACT §8 · DECISIONS §15) — เฉพาะ TEST_MODE=1
 *   POST /api/test/reset  → 200 {"ok":true,"now":"2026-12-01T09:00:00+07:00"} · ล้างทุกอย่าง + seed ใหม่ + ล้าง session ทุกคน
 *   GET  /api/test/clock  → 200 {"now":"…"}
 *   PUT  /api/test/clock  {"now":"<ISO มี offset>"} → 200 {"now":"…"} (แช่แข็ง) · ไม่ถูกต้อง → 400 INVALID_TIME
 * ที่เหลือใน §8 (payments/<ref>/pay → B05 · documents/<docNo>/tamper → B07) ให้โมดูลนั้น ๆ ลงทะเบียนเองใต้ /api/test/*
 * เมื่อไม่ได้ตั้ง TEST_MODE ทุก /api/test/* ตอบ 404 (guard อยู่ใน server.js ก่อนโมดูลทั้งหมด)
 */
const express = require('express');
const clock = require('./clock');
const { apiError } = require('./http');

function register(app, ctx) {
  const r = express.Router();

  r.post('/reset', (_req, res) => {
    ctx.resetAll();
    res.json({ ok: true, now: clock.nowIso() });
  });

  r.get('/clock', (_req, res) => res.json({ now: clock.nowIso() }));

  r.put('/clock', (req, res) => {
    const iso = req.body && req.body.now;
    const out = typeof iso === 'string' ? clock.set(iso) : null;
    if (out === null) return apiError(res, 400, 'INVALID_TIME', 'รูปแบบเวลาไม่ถูกต้อง (ต้องเป็น ISO 8601 พร้อม offset)');
    res.json({ now: out });
  });

  app.use('/api/test', r);
}

module.exports = { register };
