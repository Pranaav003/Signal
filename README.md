# Signal

Reddit lead intelligence for small businesses.

## Local development (quick checklist)

From the repository root (after `git clone`, the folder is usually `Signal` or `signal`):

### Terminal 1 — Backend API

```bash
cd backend
cp .env.example .env
# Edit .env: set DATABASE_URL, REDIS_URL, REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET,
# REDDIT_USER_AGENT, ANTHROPIC_API_KEY (and JWT_SECRET for future auth).
npm install
npm run migrate
npm run dev
```

You should see:

- `Signal backend running on port 3001`
- `✓ Database connected`
- `✓ Scheduler started: N monitors active` (N may be 0 until you create a keyword set)

### Terminal 2 — Background worker

```bash
cd backend
node src/jobs/worker.js
```

You should see:

- `✓ Database connected` (from loading the DB pool)
- `✓ Signal worker started`

### Terminal 3 — Frontend

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173** (Vite proxies `/api` to the backend in dev).

### Optional — Reddit smoke test

```bash
cd backend
npm run test:scan
```

Prints scored Reddit results to the console (requires Reddit credentials in `.env`).

---

## Render deploy (checklist)

1. **Push** this repository to **GitHub** on the **`main`** branch.
2. Go to **render.com → New → Blueprint**.
3. Point Render at the **repo root** (it will pick up **`render.yaml`**).
4. In the Render dashboard, **manually add** these secrets (they are `sync: false` in the blueprint):
   - `REDDIT_CLIENT_ID`
   - `REDDIT_CLIENT_SECRET`
   - `ANTHROPIC_API_KEY`
5. Click **Deploy**.
6. **Logs to verify**
   - **signal-backend:** `✓ Database connected` and `✓ Scheduler started: …`
   - **signal-worker:** `✓ Signal worker started`
7. Open the **signal-frontend** URL, create your first **keyword set**, then wait for the first scan (or trigger via queue as configured).

---

## Environment variables

| Variable | Description |
|----------|-------------|
| DATABASE_URL | PostgreSQL connection string |
| REDIS_URL | Redis connection string |
| REDDIT_CLIENT_ID | From reddit.com/prefs/apps |
| REDDIT_CLIENT_SECRET | From reddit.com/prefs/apps |
| REDDIT_USER_AGENT | Format: `Signal/1.0 by YourUsername` (Render blueprint sets a default; override if you prefer) |
| ANTHROPIC_API_KEY | From console.anthropic.com |
| JWT_SECRET | Random string; auto-generated on Render for the web service |

For the **static frontend** build, **`VITE_API_URL`** is wired from the **`signal-backend`** service URL in **`render.yaml`**.
