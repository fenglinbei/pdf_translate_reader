# PDF Translate Reader

Local-first web PDF reader scaffold for sentence-level translation workflows.

## Runtime support

The current project structure supports deployment on Windows, Linux, and macOS.
It is a Vite/React frontend plus a Node.js API proxy, with no native build
dependencies in the current `package.json`.

Required environment:

- Node.js 18.20+; Node.js 20 or 22 LTS is recommended.
- npm 10+.
- A modern browser with PDF.js worker, IndexedDB, and streaming `fetch` support.
- Network access from the API proxy to `https://api.deepseek.com`, unless
  `DEEPSEEK_API_BASE_URL` points to another compatible endpoint.
- `DEEPSEEK_API_KEY` configured in `.env.local` or the process environment.
- A Supabase project with Auth, Postgres, and Storage configured from
  `supabase/schema.sql`.
- Linux one-command nginx deployment additionally requires nginx, systemd, and
  sudo access.

## Development

```bash
npm install
npm run dev
```

The web app starts at `http://localhost:5173`. The local API proxy exposes
`GET /api/health` through the Vite proxy and `http://localhost:8787/api/health`
directly.

If the combined `npm run dev` script cannot locate `vite` on Windows, start the
two processes in separate terminals:

```powershell
npm run dev:api
npm run dev:web
```

## Production model

Production deployment has two parts:

1. Build and serve the static frontend from `dist/`.
2. Run `server/index.mjs` as the API proxy so the browser never receives the
   DeepSeek API key.

The frontend calls `/api/*`. In production, configure the static server or
reverse proxy so `/api` is forwarded to the Node.js API proxy.

The API proxy listens on `PORT`, defaulting to `8787`.

## Windows deployment

PowerShell:

```powershell
git clone https://github.com/fenglinbei/pdf_translate_reader.git
cd pdf_translate_reader
npm ci
Copy-Item .env.local.example .env.local
```

Edit `.env.local` and set:

```powershell
DEEPSEEK_API_KEY=your_key_here
PORT=8787
VITE_API_BASE_URL=/api
VITE_API_PROXY_TARGET=http://localhost:8787
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
```

Build:

```powershell
npm run build
```

Run the API proxy:

```powershell
node server/index.mjs
```

Serve `dist/` with IIS, nginx for Windows, Caddy, or another static file server.
Forward `/api/*` to `http://localhost:8787/api/*`.

For a local production preview only:

```powershell
npm run preview
```

Keep `node server/index.mjs` running in another terminal, because Vite preview
serves the frontend but does not replace the API proxy.

## Linux deployment

Bash:

```bash
git clone https://github.com/fenglinbei/pdf_translate_reader.git
cd pdf_translate_reader
cp .env.local.example .env.local
```

Edit `.env.local`:

```bash
DEEPSEEK_API_KEY=your_key_here
PORT=8787
VITE_API_BASE_URL=/api
VITE_API_PROXY_TARGET=http://localhost:8787
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
```

## Supabase setup

Run `supabase/schema.sql` in the Supabase SQL editor before using the app. It
creates the private `user-pdfs` Storage bucket, the `public.user_documents`
table, document-state sync tables for annotations, translation cache, paper
context, pinned translation cards, user settings, API logs, and RLS policies for
per-user access. `user_documents` also stores the last page, scroll offset, and
zoom used when reopening a PDF.

The browser uses `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` for login and
Storage access. The Node API proxy reads the same values from `.env.local`, or
`SUPABASE_URL` and `SUPABASE_ANON_KEY` if those are set by the host.

### Invite code signup hook

`supabase/schema.sql` creates an invite-code registration flow with:

- `public.signup_invites`: hashed invite codes, usage limits, expiry, and notes.
- `public.signup_invite_tickets`: 10-minute registration tickets created by the
  Node API after an invite code is checked.
- `public.signup_invite_redemptions`: invite redemption audit records.
- `public.create_signup_invite_ticket(signup_email text, invite_code text)`: a
  service-role-only RPC used by `POST /api/auth/invite-ticket`.
- `public.hook_restrict_signup_by_invite_ticket(event jsonb)`: the Supabase Auth
  Before User Created hook that consumes a ticket before a user is created.

To make registration invite-only by code:

1. Run `supabase/schema.sql` in the Supabase SQL editor.
2. Set `SUPABASE_SERVICE_ROLE_KEY` in the Node API process environment. Do not
   expose this value with a `VITE_` prefix.
3. In Supabase Dashboard, go to Authentication -> Hooks.
4. Enable Before User Created.
5. Choose the Postgres function
   `public.hook_restrict_signup_by_invite_ticket`.
6. Keep "Allow new users to sign up" enabled so invited users can self-register.

Create a single-use invite code:

```sql
insert into public.signup_invites (code_hash, note, max_uses, expires_at)
values (
  public.hash_signup_invite_code('PDF-2026-ABCD'),
  'first beta invite',
  1,
  now() + interval '14 days'
);
```

Create a reusable invite code:

```sql
insert into public.signup_invites (code_hash, note, max_uses, expires_at)
values (
  public.hash_signup_invite_code('LAB-TEAM-2026'),
  'lab team invite',
  20,
  now() + interval '60 days'
);
```

Revoke an invite code without deleting its audit history:

```sql
update public.signup_invites
set active = false,
    updated_at = now()
where code_hash = public.hash_signup_invite_code('PDF-2026-ABCD');
```

The browser never receives the Supabase service role key. It sends the entered
invite code to the Node API, receives a short-lived ticket, and passes only that
ticket to Supabase Auth signup metadata. Invite and ticket tables have RLS
enabled and no public policies, so browser clients cannot read or modify them.
The older `signup_email_allowlist` table and
`hook_restrict_signup_by_email_allowlist` function remain in the schema for
migration safety, but new deployments should use the invite-ticket hook above.

### One-command nginx deployment

On a Linux server with nginx and systemd already installed:

```bash
bash scripts/deploy-linux-nginx.sh
```

or:

```bash
npm run deploy:linux:nginx
```

The script:

1. Runs `npm ci`.
2. Builds the frontend with `npm run build`.
3. Publishes the frontend to `/var/www/pdf-translate-reader`.
4. Installs a systemd service for `server/index.mjs`.
5. Writes `/etc/nginx/conf.d/pdf-translate-reader.conf`.
6. Starts or reloads nginx.
7. Checks `http://127.0.0.1:8787/api/health`.

HTTPS is the default public mode. The default `HTTPS_MODE=edge` is intended for
Sakura FRP, a CDN, or another public reverse proxy that terminates HTTPS and
forwards plain HTTP to local nginx. In this mode, local nginx still listens on
port `80`, and the public URL is treated as `https://...`.

For a Sakura FRP HTTPS tunnel with a public URL such as
`https://example.natfrp.example:12345/`, run:

```bash
SERVER_NAME=example.natfrp.example PUBLIC_PORT=12345 bash scripts/deploy-linux-nginx.sh
```

`SERVER_NAME` does not include the port. Put the public port in `PUBLIC_PORT`.

The generated nginx config also serves `.mjs` files as
`application/javascript`, which is required by the PDF.js worker.

Optional deployment variables:

```bash
SERVER_NAME=example.com PORT=8787 WEB_ROOT=/var/www/pdf-translate-reader bash scripts/deploy-linux-nginx.sh
```

The API service runs as the current user by default. Override it if needed:

```bash
RUN_USER=www-data RUN_GROUP=www-data bash scripts/deploy-linux-nginx.sh
```

After deployment, inspect logs with:

```bash
sudo journalctl -u pdf-translate-reader.service -f
```

If nginx itself should terminate HTTPS, use `HTTPS_MODE=local` and provide a
certificate and private key:

```bash
HTTPS_MODE=local \
SERVER_NAME=example.com \
SSL_CERT_PATH=/etc/letsencrypt/live/example.com/fullchain.pem \
SSL_KEY_PATH=/etc/letsencrypt/live/example.com/privkey.pem \
bash scripts/deploy-linux-nginx.sh
```

To deploy plain HTTP only:

```bash
HTTPS_MODE=off SERVER_NAME=example.com bash scripts/deploy-linux-nginx.sh
```

### Manual Linux deployment

Install dependencies:

```bash
npm ci
```

Build:

```bash
npm run build
```

Run the API proxy:

```bash
node server/index.mjs
```

Serve `dist/` with nginx, Caddy, Apache, or another static file server. Forward
`/api/*` to `http://localhost:8787/api/*`.

Example nginx location blocks:

```nginx
location / {
  root /path/to/pdf_translate_reader/dist;
  try_files $uri $uri/ /index.html;
}

location /api/ {
  proxy_pass http://127.0.0.1:8787/api/;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}

location ~* \.mjs$ {
  default_type application/javascript;
  try_files $uri =404;
}
```

For a persistent API process, run `node server/index.mjs` under systemd, pm2, or
your deployment platform's process manager.

## macOS deployment

Terminal:

```bash
git clone https://github.com/fenglinbei/pdf_translate_reader.git
cd pdf_translate_reader
npm ci
cp .env.local.example .env.local
```

Edit `.env.local`:

```bash
DEEPSEEK_API_KEY=your_key_here
PORT=8787
VITE_API_BASE_URL=/api
VITE_API_PROXY_TARGET=http://localhost:8787
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
```

Build:

```bash
npm run build
```

Run the API proxy:

```bash
node server/index.mjs
```

Serve `dist/` with Caddy, nginx installed through Homebrew, Apache, or another
static file server. Forward `/api/*` to `http://localhost:8787/api/*`.

For a local production preview only:

```bash
npm run preview
```

Keep the API proxy running separately.

## Unsupported cases and modification plan

No structural blocker is currently required for Windows, Linux, or macOS
deployment.

If the project later needs single-command production startup, add a small static
file server to `server/index.mjs` or introduce a dedicated `npm run start`
script. If the project later needs packaged desktop distribution, add an
Electron or Tauri wrapper; the current project is a web deployment, not a native
desktop bundle.
