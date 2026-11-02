const { GoogleGenAI, Type } = require('@google/genai');
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const crypto = require('crypto');
// ---- privacy ----
const userToken = (phone) => crypto.createHmac('sha256', process.env.PEPPER || 'dev-pepper').update(phone).digest('hex');
const maskedId = (tok) => 'Citizen #' + tok.slice(0, 6).toUpperCase();
// ---- geo ----
// PLACEHOLDER rough India outline [lng,lat]; replace with the real national GeoJSON.
const INDIA = [[68.1,23.6],[72.5,21],[72.8,15.5],[77,8],[78,8.1],[80.3,10],[80.1,15.5],[86,20],[89,21.7],[92,21.9],[92.5,24],[97.3,28],[95.5,29.4],[91.7,27.8],[88.8,27.3],[88,26.5],[81,30.3],[79,32.7],[78.5,35.5],[74,37],[73.5,34.5],[74.5,32.5],[74,31],[71.5,28],[69.5,27.5],[70.3,25]];
function inPoly(lat, lng, poly = INDIA) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const dist = (a, b, c, d) => { const R = 6371000, r = Math.PI / 180, dLa = (c - a) * r, dLo = (d - b) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
// DEMO ward boxes [minLat,minLng,maxLat,maxLng]; replace with ward/MLA GeoJSON + point-in-polygon.
const WARDS = [{ id: 'W1', name: 'Ward 1 (demo)', mla: 'Constituency A (demo)', box: [22.28, 87.28, 22.34, 87.33] },
               { id: 'W2', name: 'Ward 2 (demo)', mla: 'Constituency A (demo)', box: [22.34, 87.28, 22.40, 87.33] }];
const wardOf = (lat, lng) => (WARDS.find(w => lat >= w.box[0] && lat < w.box[2] && lng >= w.box[1] && lng < w.box[3]) || { id: 'UNMAPPED', name: 'Unmapped' }).id;
// Local POI table (offline fallback for OSM Overpass).
const POIS = [{ t: 'hospital', lat: 22.3150, lng: 87.3108 }, { t: 'school', lat: 22.3300, lng: 87.3200 }];
const M = { hospital: 2.5, school: 2.0, arterial: 1.8, residential: 1.0 };
async function proximity(lat, lng) {
  try { // OSM Overpass, 250m buffer
    const q = `[out:json][timeout:6];(nwr(around:250,${lat},${lng})[amenity~"hospital|clinic"];nwr(around:250,${lat},${lng})[amenity~"school|kindergarten"];nwr(around:250,${lat},${lng})[highway~"trunk|primary"];);out tags 20;`;
    const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q), signal: AbortSignal.timeout(5000) });
    const els = (await r.json()).elements || [];
    const tags = els.map(e => e.tags || {});
    if (tags.some(t => /hospital|clinic/.test(t.amenity || ''))) return M.hospital;
    if (tags.some(t => /school|kindergarten/.test(t.amenity || ''))) return M.school;
    if (tags.some(t => /trunk|primary/.test(t.highway || ''))) return M.arterial;
    return M.residential;
  } catch {
    const near = POIS.filter(p => dist(lat, lng, p.lat, p.lng) <= 250).map(p => M[p.t]);
    return near.length ? Math.max(...near) : M.residential;
  }
}
// ---- severity (spec §6.6/6.7) ----
// ASSUMPTION: spec formula yields max 50 for S_base=10 at a hospital, contradicting AC#1 (>=80).
// We scale S_base (1-10) by BASE_SCALE so the AC holds. Confirm with owner.
const BASE_SCALE = 4;
const velocity = (n) => Math.min(25, 5 * Math.log(n + 1));
const severity = ({ sBase, mGeo, mVuln = 0, n = 0 }) => Math.max(1, Math.min(100, Math.round(sBase * BASE_SCALE * mGeo + mVuln + velocity(n))));
const tierOf = (s) => (s >= 80 ? 1 : s >= 50 ? 2 : 3);
const SLA_H = { 1: 12, 2: 48, 3: 168 };
// ---- AI adapter (Gemini if key, else heuristic mock) ----
const DEPT = { road: 'Public Works', water: 'Water Supply', electrical: 'Electricity Board', drain: 'Sanitation & Drainage', general: 'Municipal Control Room' };
function mockTriage(text) {
  const t = (text || '').toLowerCase();
  const cat = /gadh|pothole|sadak|road|rasta/.test(t) ? 'road' : /pani|water|leak|pipe/.test(t) ? 'water' : /wire|tar |current|electric|pole/.test(t) ? 'electrical' : /drain|naali|manhole|nala/.test(t) ? 'drain' : 'general';
  const vuln = /ambulance|hospital|accident|current|wire|open manhole/.test(t) ? 25 : /wheelchair|bujurg|elderly|bachch|school/.test(t) ? 15 : 0;
  return { isCivic: true, category: cat, confidence: cat === 'general' ? 0.5 : 0.8, sBase: cat === 'general' ? 5 : 7, mVuln: vuln, landmark: '', language: 'auto', mock: true };
}
async function triage(img, text) {
  if (!process.env.GEMINI_API_KEY) {
  return {
    isCivic: false,
    category: 'general',
    confidence: 0,
    sBase: 1,
    mVuln: 0,
    landmark: '',
    language: 'auto',
    error: 'Image validation requires GEMINI_API_KEY'
  };
}

  const prompt = `
You are validating citizen reports of civic infrastructure problems.

Examine the attached image carefully. The user's text is:
"${text}"

Accept only images that visibly show a real civic infrastructure issue,
such as a pothole, damaged road, water leak, overflowing drain,
broken streetlight, exposed electrical wire, or public waste problem.

Reject unrelated images such as wallpapers, selfies, portraits,
pets, food, screenshots, memes, and ordinary scenery.

Do not assume an image is a civic issue just because the user says so.
If the image is unclear or does not visibly show a civic defect,
return isCivic: false.

Return JSON only:
{
  "isCivic": true,
  "category": "road",
  "confidence": 0.9,
  "sBase": 8,
  "mVuln": 0,
  "landmark": "",
  "language": "auto"
}
`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { data: img.toString("base64"), mimeType: "image/jpeg" } },
            { text: prompt }
          ]
        }
      ]
    });

    const clean = response.text.replace(/```json/g, "").replace(/```/g, "").trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error("Gemini triage error, using fallback:", err.message);
    return {
  isCivic: false,
  category: 'general',
  confidence: 0,
  sBase: 1,
  mVuln: 0,
  landmark: '',
  language: 'auto'
}
  }
}
// Crude embedding (byte histogram) for the mock; swap for a real image-embedding model.
function embed(buf) { const v = new Array(64).fill(0); for (let i = 0; i < buf.length; i += 7) v[buf[i] >> 2]++; return v; }
const cosine = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] ** 2; y += b[i] ** 2; } return x && y ? d / Math.sqrt(x * y) : 0; };
async function visualDiff(before, after, tk, pos) {
  if (dist(tk.lat, tk.lng, pos.lat, pos.lng) > 50) return { ok: false, reason: 'Visual diff failed: Surrounding landmarks do not match original defect location' };
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { ok: true, mock: true }; // mock trusts geotag only
  const p = 'Image 1 is BEFORE, image 2 is AFTER. Do background landmarks match? Is the defect fixed? JSON only: {"landmarksMatch":bool,"defectFixed":bool}';
  const part = (b) => ({ inlineData: { mimeType: 'image/jpeg', data: b.toString('base64') } });
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: p }, part(before), part(after)] }], generationConfig: { responseMimeType: 'application/json' } }) });
  const j = JSON.parse((await r.json()).candidates[0].content.parts[0].text);
  if (!j.landmarksMatch) return { ok: false, reason: 'Visual diff failed: Surrounding landmarks do not match original defect location' };
  if (!j.defectFixed) return { ok: false, reason: 'Visual diff failed: Defect still present' };
  return { ok: true };
}
async function scrub(buf) { // strips EXIF by re-encoding; face/plate blur NOT implemented (see README)
  try { return await require('sharp')(buf).rotate().jpeg({ quality: 82 }).toBuffer(); } catch { return buf; }
}
async function verifyRepairDiff(beforeImageBuffer, afterImageBuffer) {
  const prompt = `Compare these two images of a civic defect site.
Image 1 is the reported defect (BEFORE).
Image 2 is the contractor repair proof (AFTER).

Verify:
1. Are background landmarks (buildings, poles, road curbs) matching to ensure it's the exact same location?
2. Has the defect (pothole, burst pipe, trash pile) been satisfactorily repaired?

Return a boolean 'isVerified' and a short explanation.`;

  const response = await ai.models.generateContent({
    model: "gemini-3.8-flash",
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { data: beforeImageBuffer.toString("base64"), mimeType: "image/jpeg" } },
          { inlineData: { data: afterImageBuffer.toString("base64"), mimeType: "image/jpeg" } },
          { text: prompt }
        ]
      }
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          landmarksMatch: { type: Type.BOOLEAN },
          defectResolved: { type: Type.BOOLEAN },
          isVerified: { type: Type.BOOLEAN },
          auditNotes: { type: Type.STRING }
        },
        required: ["landmarksMatch", "defectResolved", "isVerified", "auditNotes"]
      }
    }
  });

  return JSON.parse(response.text);
}
module.exports = {
  userToken,
  maskedId,
  inPoly,
  dist,
  SLA_H,
  wardOf,
  WARDS,
  proximity,
  severity,
  tierOf,
  cosine,
  scrub,
  embed,
  triage,
  visualDiff,
  verifyRepairDiff
};