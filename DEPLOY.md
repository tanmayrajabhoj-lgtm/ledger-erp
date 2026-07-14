# Deploying Ledger ERP (free, multi-device)

This app now has two pieces:

- **`index.html`** — the frontend. Goes on **GitHub Pages**.
- **`backend/`** — the API + database logic. Goes on **Render** (free web service), talking to a **Neon** (free Postgres) database.

Do these in order: **Neon → Render → GitHub Pages**. Each step depends on the one before it.

---

## 1. Create the database (Neon)

1. Go to https://neon.tech and sign up (free tier is enough).
2. Create a new project. Any region is fine — pick one close to you.
3. Once created, open the **SQL Editor** in the Neon dashboard.
4. Open `backend/schema.sql` from this project, copy its contents, paste into the SQL Editor, and run it. This creates the tables.
5. Go to **Connection Details** (or **Dashboard → Connect**) and copy the **connection string**. Make sure you grab the one for a **pooled connection** (it usually has `-pooler` in the hostname) — this matters for Render's free tier. It looks like:
   ```
   postgresql://neondb_owner:AbCdEf123@ep-something-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require
   ```
   Keep this handy for step 2.

---

## 2. Deploy the backend (Render)

1. Push this project to a GitHub repository (the whole folder — both `index.html` and `backend/`).
2. Go to https://render.com and sign up / log in.
3. **New +** → **Web Service** → connect your GitHub repo.
4. Configure:
   - **Root Directory:** `backend`
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. Under **Environment Variables**, add:
   - `DATABASE_URL` = the Neon connection string from step 1
   - `JWT_SECRET` = any long random string. You can generate one by running this locally:
     ```
     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
     ```
6. Click **Create Web Service**. Wait for the build/deploy to finish (a few minutes).
7. Once live, Render gives you a URL like `https://ledger-erp-backend.onrender.com`. Test it by opening that URL in a browser — you should see `Ledger ERP API is running.`
8. Copy this URL — you need it for step 3.

**Free tier note:** Render's free web services sleep after 15 minutes of no traffic. The next request wakes it up but takes ~30–50 seconds. The first person to open the app after a quiet period will see a delay before login responds — that's expected, not a bug.

---

## 3. Point the frontend at your backend

1. Open `index.html` in a text editor.
2. Find this line near the top of the `<script>` section:
   ```js
   const API_BASE_URL = 'https://YOUR-BACKEND.onrender.com';
   ```
3. Replace it with your actual Render URL from step 2 (no trailing slash), e.g.:
   ```js
   const API_BASE_URL = 'https://ledger-erp-backend.onrender.com';
   ```
4. Save the file.

---

## 4. Deploy the frontend (GitHub Pages)

1. In the same GitHub repo (or a new one — either works, it doesn't need to be the same repo as the backend), make sure the updated `index.html` is committed and pushed.
2. On GitHub: **Settings → Pages**.
3. Under **Source**, choose **Deploy from a branch**, pick your branch (usually `main`) and folder `/ (root)` — or `/docs` if that's where `index.html` lives.
4. Save. GitHub gives you a URL like `https://yourusername.github.io/your-repo/`.
5. Open it. You should see the Ledger ERP login screen.

---

## 5. First login

- **Admin:** username `admin`, password `admin123` (seeded automatically the first time the backend starts). **Change this immediately** from Settings → Admin Login once you're in.
- **Students:** created from the admin's Students tab — each one gets a username + temporary password shown once in a popup, which you share with them.

Every device that opens your GitHub Pages link and logs in reads and writes the same Neon database, so admin changes and student submissions are visible to everyone, from any device, and persist through restarts.

---

## Updating the app later

- **Frontend changes:** edit `index.html`, commit, push — GitHub Pages redeploys automatically in a minute or two.
- **Backend changes:** edit files in `backend/`, commit, push — Render redeploys automatically.
- **Database:** you don't need to touch Neon again unless you're changing the data model.

## Costs

Everything above is on free tiers: GitHub Pages (frontend hosting), Render free web service (backend), Neon free tier (database, 0.5 GB storage). No credit card is required for any of them at this scale.
