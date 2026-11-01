# VOXEL – The Citizen's Voice. The Camera's Truth.
Civic reporting MVP: camera + voice + GPS → AI triage → dynamic severity/SLA → verified repair → ward scorecards.

## Structure
```
voxel/
├── client/   static mobile-first web app (index.html, build-config.js, .env.example)
├── server/   Express API (server.js, lib.js, tests, .env.example, data/)
└── .gitignore
```

## Setup
Requires Node ≥ 20.6.
```bash
# 1. Server
cd server
npm install                # sharp is optional (EXIF stripping)
cp .env.example .env       # then fill PEPPER (openssl rand -hex 32) and OFFICER_KEY
npm test
npm start                  # http://localhost:3000 (also serves ../client)

# 2. Client (only needed if hosted separately from the server)
cd ../client
cp .env.example .env       # set VOXEL_API_BASE=https://your-api-host
node build-config.js       # writes config.js
```
If the client is on another origin, set `CLIENT_ORIGIN` in `server/.env` to enable CORS.

## Environment variables
| File | Variable | Purpose |
|---|---|---|
| server/.env | `PEPPER` | HMAC secret for user tokens (required in production) |
| server/.env | `OFFICER_KEY` | Shared key for field-officer endpoints (demo RBAC) |
| server/.env | `GEMINI_API_KEY` | Optional; enables Gemini triage + visual diff, else keyword mock |
| server/.env | `CLIENT_ORIGIN` | Optional CORS origin |
| client/.env | `VOXEL_API_BASE`, `VOXEL_TILE_URL` | Public values only – never put secrets here |

Never commit `.env` files; all external API keys stay server-side.

## API
`POST /api/otp/request|verify` · `POST /api/reports` · `GET /api/tickets[/:id]` · `POST /api/tickets/:id/resolve` (officer key) · `POST /api/tickets/:id/dispute` · `GET /api/scorecards`

## Implemented
Zero-login camera/voice/GPS client, OTP sandbox → HMAC token, geofence (400), non-civic rejection (422), EXIF scrub, 25 m dedup + velocity boost, dynamic severity/SLA, OSM Overpass proximity (local fallback), ward mapping, visual-diff closure gate, dispute 422, scorecards, Leaflet map, SLA-tier board.

## Assumptions / not yet built
- **Severity formula conflict:** spec §6 maxes at 50 for a hospital pothole but AC#1 needs ≥80. `BASE_SCALE=4` in `server/lib.js` bridges it – confirm with the owner.
- JSON-file storage instead of Postgres/PostGIS (Supabase).
- Placeholder national boundary and ward shapes; no representative/party data loaded.
- Not built: Whisper STT, face/plate blur, EXIF-GPS spoof check, real image embeddings, real SMS gateway, offline IndexedDB queue, 200 m quorum, PDF dossier, WhatsApp bot, map filters, per-user officer auth.
