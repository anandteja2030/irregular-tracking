# NEURAL COMMAND console (Phase 5 foundation)

React + TypeScript shell for the surveillance intelligence console. It is
deliberately isolated from the Python engine: no source file under `src/`,
`config/` or `tests/` was changed for it, and Streamlit remains the working
interface during the migration.

## Run

```bash
cd frontend
npm install
npm run dev -- --host 0.0.0.0      # Vite on :5173
```

The dev server proxies `/api` to `http://127.0.0.1:8000` (override with
`NEURAL_API_URL`), so the browser stays same-origin and no new CORS origin is
required. Start the backend first:

```bash
.venv/bin/uvicorn src.api.main:app --host 127.0.0.1 --port 8000
```

Extra preview hostnames are passed at start time, never hard-coded:

```bash
PREVIEW_HOST=example.style.dev npm run dev -- --host 0.0.0.0
```

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server with API proxy |
| `npm run typecheck` | `tsc --noEmit` over app + config |
| `npm run build` | Typecheck then production bundle into `dist/` |
| `npm test` | Vitest + jsdom |

## Layout

```
src/
  lib/        api client, response types, formatters
  hooks/      useResource (cancellation, polling, stale-safe refresh)
  app/        navigation model, shared liveness provider
  components/ shell chrome, glass primitives, state views, icons
  pages/      one surface per workspace
  styles/     tokens, base, shell, components, pages
```

## Backend contract

Read-only calls only, through the versioned mirror:

| Surface | Endpoint |
| --- | --- |
| Command Overview, rail, top bar | `GET /api/v1/health` |
| Command Overview, System Settings | `GET /api/v1/system` |
| Command Overview, Video Studio | `GET /api/v1/sources` |
| Video Studio, Anomaly Center, Scene, Settings | `GET /api/v1/config` |
| Session switcher, Overview ledger | `GET /api/v1/sessions` |
| Track Explorer | `GET /api/v1/sessions/{id}/tracks`, `/tracks/{track}`, `/tracks/{track}/trajectory`, `/tracks/{track}/observations` |
| Anomaly Center | `GET /api/v1/sessions/{id}/anomalies` (`severity`, `sort`, `limit`, `offset`) |
| Scene Intelligence | `GET /api/v1/sessions/{id}/scene` |
| Evaluation & Reports | `GET /api/v1/sessions/{id}/evaluation`, `/export/csv`, `/report` |

The selected session lives in `?session=<id>` on every workspace, so links,
back/forward and reloads all preserve it.

No endpoint was added or changed, and nothing in the console mutates engine
state, the database or ground truth. Trajectories and learned calibration are
reported as unavailable for historical sessions because the API states they
are not persisted; the UI shows that reason instead of drawing placeholders.
