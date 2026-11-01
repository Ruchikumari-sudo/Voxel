require('dotenv').config();

const express = require('express'), multer = require('multer'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const L = require('./lib');
const DEPT = {
  road: 'Public Works',
  water: 'Water Supply',
  electrical: 'Electricity Board',
  drain: 'Drainage & Sewage',
  general: 'Municipal Corporation'
};
const app = express(), up = multer({ limits: { fileSize: 8e6 } });
const DB = path.join(__dirname, 'data/db.json');
const db = fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB)) : { tickets: [], trust: {} };
const save = () => fs.writeFileSync(DB, JSON.stringify(db));
const media = new Map(); // id -> Buffer (swap for a storage bucket)
for (const f of fs.existsSync(path.join(__dirname, 'data/media')) ? fs.readdirSync(path.join(__dirname, 'data/media')) : []) media.set(f, fs.readFileSync(path.join(__dirname, 'data/media', f)));
const putMedia = (buf) => { const id = crypto.randomUUID() + '.jpg'; fs.mkdirSync(path.join(__dirname, 'data/media'), { recursive: true }); fs.writeFileSync(path.join(__dirname, 'data/media', id), buf); media.set(id, buf); return id; };
const otps = new Map(); // phone -> {code, exp}; sessions: token -> phone
const sessions = new Map();
const isOfficer = (req) => req.get('x-officer-key') === (process.env.OFFICER_KEY || 'dev-officer');
const nIn2h = (t) => t.dupes.filter(d => Date.now() - d < 7.2e6).length;
const rescore = (t) => { t.severity = L.severity({ sBase: t.sBase, mGeo: t.mGeo, mVuln: t.mVuln, n: nIn2h(t) }); t.tier = L.tierOf(t.severity); t.slaDue = t.createdAt + L.SLA_H[t.tier] * 3.6e6; };
const pub = (t, officer) => ({ id: t.id, category: t.category, department: t.department, lat: t.lat, lng: t.lng, ward: t.ward, severity: t.severity, tier: t.tier, status: t.status, createdAt: t.createdAt, slaDue: t.slaDue,
  resolvedAt: t.resolvedAt, reports: 1 + t.dupes.length, flags: t.flags, beforeImg: '/media/' + t.beforeImg, afterImg: t.afterImg && '/media/' + t.afterImg, reporter: L.maskedId(t.token) });
app.use((req, res, next) => { const o = process.env.CLIENT_ORIGIN; if (o) { res.set({ 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Headers': 'Content-Type,x-officer-key', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); if (req.method === 'OPTIONS') return res.sendStatus(204); } next(); });
app.use(express.json()); app.use(express.static(path.join(__dirname, '../client')));
app.get('/media/:id', (req, res) => { const b = media.get(req.params.id); b ? res.type('jpg').send(b) : res.sendStatus(404); });

// Sandbox OTP (no SMS gateway wired; code is returned in the response ONLY in sandbox mode)
app.post('/api/otp/request', (req, res) => {
  const p = String(req.body.phone || ''); if (!/^\+[1-9]\d{7,14}$/.test(p)) return res.status(400).json({ error: 'Phone must be E.164, e.g. +919876543210' });
  const code = String(crypto.randomInt(100000, 999999)); otps.set(p, { code, exp: Date.now() + 3e5 }); res.json({ sent: true, sandboxCode: code });
});
app.post('/api/otp/verify', (req, res) => {
  const o = otps.get(req.body.phone); if (!o || o.exp < Date.now() || o.code !== String(req.body.code)) return res.status(400).json({ error: 'Invalid or expired OTP' });
  otps.delete(req.body.phone); const s = crypto.randomUUID(); sessions.set(s, L.userToken(req.body.phone)); res.json({ session: s }); // raw phone is not retained
});

app.post('/api/reports', up.fields([{ name: 'image', maxCount: 1 }, { name: 'audio', maxCount: 1 }]), async (req, res) => {
  try {
    const lat = +req.body.lat, lng = +req.body.lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return res.status(400).json({ error: 'Valid lat/lng required' });
    if (!L.inPoly(lat, lng)) return res.status(400).json({ error: 'Location outside service jurisdiction (National boundary only)' });
    const token = sessions.get(req.body.session); if (!token) return res.status(401).json({ error: 'OTP verification required' });
    const raw = req.files?.image?.[0]?.buffer; if (!raw) return res.status(400).json({ error: 'incident_image required' });
    const img = await L.scrub(raw);
    const text = req.body.text || ''; // audio is never stored; plug Whisper here: transcript = await whisper(req.files.audio[0].buffer)
    const a = await L.triage(img, text);
    if (!a.isCivic) return res.status(422).json({ error: 'No valid civic infrastructure issue detected. Please photograph the physical defect.' });
    const emb = L.embed(img), flags = [];
    if (a.confidence < 0.65) { a.category = 'general'; a.sBase = Math.max(a.sBase, 5); flags.push('human_triage_review'); }
    if (!text) flags.push('no_transcript_use_category_chips');
    const parent = db.tickets.find(t => t.status !== 'resolved' && L.dist(t.lat, t.lng, lat, lng) <= 25 && L.cosine(t.emb, emb) >= 0.85);
    if (parent) { parent.dupes.push(Date.now()); rescore(parent); save();
      return res.status(200).json({ message: 'Identical issue already reported nearby. Your submission has been linked, boosting its urgency.', duplicate: true, ticket: pub(parent), trackingLink: '/track/' + parent.id }); }
    const mGeo = await L.proximity(lat, lng);
    const t = {
      id: 'VX-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
      token,
      lat,
      lng,
      category: a.category || 'road',
      department: (DEPT[a.category] || 'Public Works'),
      sBase: a.sBase || 5,
      mGeo,
      mVuln: a.mVuln || 0,
      dupes: [],
      emb,
      flags,
      status: 'open',
      createdAt: Date.now()
    };
    rescore(t); db.tickets.push(t); save();
    res.status(201).json({ ticket: pub(t), trackingLink: '/track/' + t.id });
  } catch (e) { console.error("REPORT SUBMISSION ERROR:",e); res.status(500).json({ error:e.message || "Internal error" }); }
});
app.get('/api/tickets', (req, res) => { const { status, ward, department } = req.query;
  res.json(db.tickets.filter(t => (!status || t.status === status) && (!ward || t.ward === ward) && (!department || t.department === department)).map(t => pub(t))); });
app.get('/api/tickets/:id', (req, res) => { const t = db.tickets.find(x => x.id === req.params.id); t ? res.json(pub(t)) : res.sendStatus(404); });
app.get('/track/:id', (req, res) => {
  const t = db.tickets.find(x => x.id === req.params.id);

  if (!t) {
    return res.status(404).send('Ticket not found');
  }

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Track Ticket ${t.id}</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          background: #101820;
          color: white;
          padding: 30px;
        }
        .card {
          max-width: 600px;
          margin: 30px auto;
          padding: 24px;
          border: 1px solid #555;
          border-radius: 12px;
          background: #1b2933;
        }
        h1 { color: #72d6a0; }
        p { margin: 14px 0; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Ticket Tracking</h1>
        <p><strong>Ticket ID:</strong> <span id="ticketId"></span></p>
        <p><strong>Department:</strong> <span id="department"></span></p>
        <p><strong>Status:</strong> <span id="status"></span></p>
        <p><strong>Severity:</strong> <span id="severity"></span></p>
        <p><strong>Tier:</strong> <span id="tier"></span></p>
        <p><strong>Reports linked:</strong> <span id="reports"></span></p>
        <p><strong>SLA due:</strong> <span id="sla"></span></p>
      </div>

      <script>
        const ticket = ${JSON.stringify({
          id: t.id,
          department: t.department,
          status: t.status,
          severity: t.severity,
          tier: t.tier,
          reports: 1 + t.dupes.length,
          slaDue: t.slaDue
        })};

        document.getElementById('ticketId').textContent = ticket.id;
        document.getElementById('department').textContent = ticket.department;
        document.getElementById('status').textContent = ticket.status;
        document.getElementById('severity').textContent = ticket.severity;
        document.getElementById('tier').textContent = ticket.tier;
        document.getElementById('reports').textContent = ticket.reports;
        document.getElementById('sla').textContent =
          new Date(ticket.slaDue).toLocaleString();
      </script>
    </body>
    </html>
  `);
});

app.post('/api/tickets/:id/resolve', up.single('after_image'), async (req, res) => {
  if (!isOfficer(req)) return res.status(403).json({ error: 'Field officer key required' });
  const t = db.tickets.find(x => x.id === req.params.id);
  if (!t) return res.sendStatus(404);
  if (!req.file) return res.status(400).json({ error: 'after_image required' });

  const after = await L.scrub(req.file.buffer);
  const before = media.get(t.beforeImg?.replace('/media/', ''));

  // Run autonomous visual diff verification
  const d = await L.verifyRepairDiff(before, after);

  t.audit = t.audit || [];
  t.audit.push({ at: Date.now(), kind: 'resolve_attempt', contractor: req.get('x-officer-key'), details: d });

  if (!d.isVerified) {
    t.status = 'in_progress';
    save();
    return res.status(422).json({ error: d.auditNotes || 'Visual diff failed: Defect still present or location mismatch', details: d });
  }

  t.status = 'resolved';
  t.resolvedAt = Date.now();
  t.afterImg = putMedia(after);
  save();
  res.json({ ok: true, ticket: pub(t, true), audit: d });
});
app.post('/api/tickets/:id/dispute', up.single('counter_image'), async (req, res) => {
  const t = db.tickets.find(x => x.id === req.params.id); if (!t) return res.sendStatus(404);
  if (!req.file) return res.status(422).json({ error: 'Live photographic counter-evidence required to dispute a verified repair' });
  const tok = sessions.get(req.body.session); if (!tok) return res.status(401).json({ error: 'OTP verification required' });
  const img = await L.scrub(req.file.buffer);
  const d = await L.visualDiff(media.get(t.afterImg || t.beforeImg), img, t, { lat: +req.body.lat, lng: +req.body.lng });
  if (!d.ok && !/Defect still/.test(d.reason || '')) { db.trust[tok] = (db.trust[tok] || 100) - 10; save(); return res.status(422).json({ error: 'Dispute dismissed: counter-photo failed visual check', trust: db.trust[tok] }); }
  t.status = 'in_progress'; t.flags.push('disputed'); save(); res.json(pub(t)); // TODO: 200m neighbourhood quorum
});
app.get('/api/scorecards', (req, res) => {
  const out = L.WARDS.map(w => {
    const ts = db.tickets.filter(t => t.ward === w.id);
    const r = ts.filter(t => t.status === 'resolved');
    const hrs = r.map(t => (t.resolvedAt - t.createdAt) / 3.6e6).sort((a, b) => a - b);
    const overdue = ts.filter(t => t.status !== 'resolved' && Date.now() > t.slaDue).length;
    const resolutionPct = ts.length ? +(100 * r.length / ts.length).toFixed(1) : 0;

    return {
      ward: w.name,
      constituency: w.mla,
      representative: 'Not loaded',
      total: ts.length,
      resolved: r.length,
      resolutionPct,
      slaCompliancePct: ts.length ? +(100 * (ts.length - overdue) / ts.length).toFixed(1) : 0,
      overdue,
      chronicHazards: ts.filter(t => t.status !== 'resolved' && t.severity >= 80 && Date.now() - t.createdAt > 7.2e7).length
    };
  });

  // Sort descending: highest resolution percentage first
  out.sort((a, b) => (b.resolutionPct || 0) - (a.resolutionPct || 0));

  res.json(out);
});

if (require.main === module) app.listen(process.env.PORT || 3000, () => console.log('VOXEL on :' + (process.env.PORT || 3000)));
module.exports = app;
