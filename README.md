# AntiKobongan

Forest fire risk monitoring. An ESP32 node publishes temperature, air humidity, gas and smoke, and soil moisture over MQTT. A Python logger stores the history in Supabase and can send Telegram alerts. A web dashboard shows the live data and the history. Everything the dashboard shows is real sensor data; there is no simulation mode.

[Bahasa Indonesia](README.id.md)

## Architecture

```
ESP32 --MQTT--> broker (public, or private with TLS) <--WSS-- dashboard (Vercel)
                         |                                      ^
                         v                                      | /api/*
              Python logger (laptop or PC)                      |
               +--> Supabase -----------------------------------+
               +--> Telegram (optional)
```

| Part | Location |
| --- | --- |
| Dashboard (HTML, CSS, ES modules, no build step) | `public/` |
| Serverless API, used by Vercel and by `server.js` | `api/*.js`, `lib/handlers/*.js` |
| Logger (MQTT, validation, Supabase and Telegram) | `backend/` |
| ESP32 firmware | `esp32_firmware.ino` and `secrets.h` |
| Database schema | `sql/001_schema.sql`, `sql/002_series.sql` |
| Deployment guide | `docs/DEPLOY.md` |

Topics are `<prefix>/<node>/sensor` (JSON) and `<prefix>/<node>/status` (`online` or `offline`, set as the last will).

## Dashboard

- Current risk: one main number, a level (Normal, Medium, High, Critical, shown by color and shape), a one-hour trend, data age and advice. If the data is older than five minutes the dashboard says it is not the current condition.
- A status chain Node, Broker, Logger, Database that shows where the data flow stops.
- Readings and score contributions: the four components of the firmware formula. Old rows without `gas_excess` are marked n/a, not guessed.
- Trend charts with threshold bands at 40, 60 and 80, min and max bands per bucket, gaps shaded as "no data", ranges of 1 hour, 6 hours, 24 hours, 7 days, 30 days or custom.
- Alerts and events from the database, plus alerts computed by the dashboard from the live score.
- A node list and a Leaflet map, shown only when a node has coordinates.
- Node management behind a PIN that the server checks, and a diagnostics view.

## Running locally

```sh
npm install
cp backend/.env.example backend/.env   # then fill in the values
npm start                               # http://localhost:3000
```

`server.js` reads `backend/.env`, uses the same API handlers as Vercel and sends the same security headers from `vercel.json`.

Logger on macOS or Linux:

```sh
python3 -m venv .venv && .venv/bin/pip install -r backend/requirements.txt
./backend/jalankan.sh
```

On Windows use `run_backend.bat`. The logger has to keep running for history and notifications to be recorded; when it stops, the Logger link of the status chain turns red.

## Configuration

All values are listed in `backend/.env.example`. For Vercel, set them as environment variables.

| Variable | Used by | Notes |
| --- | --- | --- |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | logger, API | Server side only |
| `SUPABASE_ANON_KEY` | API | Optional, used for reads when set |
| `ADMIN_PIN`, `ADMIN_TOKEN_SECRET` | API | Node management PIN and session token secret |
| `MQTT_HOST`, `MQTT_PORT`, `MQTT_TLS`, `MQTT_USERNAME`, `MQTT_PASSWORD` | logger | Broker for the logger |
| `MQTT_WS_URL`, `MQTT_WEB_USERNAME`, `MQTT_WEB_PASSWORD` | API to browser | WebSocket broker for the dashboard; use a subscribe-only account |
| `TOPIC_PREFIX`, `NODE_ID` | logger, API | Must match the firmware |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | logger | Optional |
| `STALE_SECONDS`, `RETENTION_DAYS`, `ALERT_*` | logger | Offline detection, retention, alert thresholds |

The firmware reads `secrets.h` (copy `secrets.example.h`): WiFi and broker host, TLS and account. It is listed in `.gitignore`.

## API

| Endpoint | Returns |
| --- | --- |
| `GET /api/latest?node_id=` | Latest reading, `latest_at`, totals, logger heartbeat, node status |
| `GET /api/series?node_id=&range=1h\|6h\|24h\|7d\|30d` or `&from=&to=` | Aggregates per bucket (avg, min, max, n), at most 720 buckets |
| `GET /api/events?node_id=&limit=20&before=` | Newest events first, paginated |
| `GET /api/nodes`, `POST /api/nodes` | List nodes, save nodes (needs an admin token) |
| `POST /api/admin` | `{pin}` returns a 30-minute session token; at most 5 failures per 15 minutes per IP |
| `GET /api/mqtt-config` | WebSocket broker address and the read-only account |
| `GET /api/health` | Configuration status |

If `sql/002_series.sql` has not been applied, `/api/series` and `/api/latest` still work with server-side aggregation, only slower.

## Tests

```sh
npm test                                              # API and dashboard modules
npm run check                                         # syntax check
.venv/bin/python -m unittest discover -s backend/tests -t . -v
```
