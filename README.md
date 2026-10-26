# vpngate-mirror

Mirror of the public **VPN Gate aggregate API** for networks where
`www.vpngate.net` is unreachable (RU in particular).

Upstream: `https://www.vpngate.net/api/iphone/` — public CSV of volunteer relays
(VPN Gate project, University of Tsukuba). This repo republishes the same bytes;
it adds nothing and stores nothing about users.

```
GET https://<owner>.github.io/<repo>/api/iphone/     ← GitHub Pages (static, cron-refreshed)
GET https://<worker>.workers.dev/api/iphone/         ← Cloudflare Worker (live, 5 min cache)
```

Both endpoints return the upstream payload unchanged:

```
*vpn_servers
#HostName,IP,Score,Ping,Speed,CountryLong,CountryShort,NumVpnSessions,Uptime,TotalUsers,TotalTraffic,LogType,Operator,Message,OpenVPN_ConfigData_Base64
vpn857476380,126.79.124.253,...
...
```

## Why the URL keeps a trailing slash

The client builds `baseUrl + "/api/iphone/"`. GitHub Pages has no rewrites, so
the mirrored file must live at `api/iphone/index.html` and the site is served at
`https://<owner>.github.io/<repo>/api/iphone/`. Content-Type will be `text/html`
(Pages picks it by filename); the client parses the body as text, not by MIME.

Client base URL to configure:

```
https://<owner>.github.io/<repo>
```

## Deploy — GitHub Pages (primary, best RU reachability)

1. Create a **public** repo, e.g. `vpngate-mirror`.
2. Push this folder:

   ```bash
   cd vpngate-mirror
   git init -b main
   git add -A
   git commit -m "vpngate mirror"
   git remote add origin https://github.com/<owner>/vpngate-mirror.git
   git push -u origin main
   ```

3. **Settings → Pages → Source: Deploy from a branch → `main` / `/ (root)`**.
4. **Actions** tab: enable workflows, run `mirror-vpngate-api` once manually.
5. Wait for the Pages deploy, then verify:

   ```powershell
   pwsh ./scripts/verify-mirror.ps1 -BaseUrl "https://<owner>.github.io/vpngate-mirror"
   ```

`api/iphone/index.html` is seeded with a real snapshot, so the URL works before
the first cron run.

Refresh cadence: `*/15 * * * *`. GitHub cron is best-effort — expect 15–40 min
of skew and occasional skips when the scheduler is busy. The workflow refuses to
publish a payload that lacks `*vpn_servers` / `#HostName,IP,Score` or has fewer
than 10 rows, so a transient upstream error cannot replace a good mirror with a
stub.

## Deploy — Cloudflare Worker (optional, fresher)

```bash
cd worker
npx wrangler login
npx wrangler deploy
# -> https://vpngate-mirror.<your-subdomain>.workers.dev
npx wrangler tail      # watch live requests
```

Client base URL: `https://vpngate-mirror.<your-subdomain>.workers.dev`

Worker behaviour:

- tries `https`, then `http` (some networks block only 443);
- validates the payload shape before serving or caching;
- edge cache 300 s, keeps a 24 h stale copy and serves it if upstream fails;
- CORS open, `OPTIONS` handled, so a browser client works too.

Optional: let the Worker write the Pages file instead of Actions. Set
`GH_OWNER` / `GH_REPO` / `GH_PATH` vars, `wrangler secret put GITHUB_TOKEN`
(PAT with `contents: write`), enable the cron in `wrangler.toml`.

### Which host will actually be reachable from RU

| Host | Notes |
|---|---|
| `*.github.io` | usually reachable; GitHub itself is not blocked, though some ISPs throttle |
| `*.workers.dev` | frequently blocked or throttled by RKN — treat as fallback |
| custom domain on Cloudflare | most durable option: a plain domain name in front of the Worker |

If `workers.dev` is blocked, attach a custom domain to the Worker (Cloudflare
Dashboard → Triggers → Custom Domains); that removes the `workers.dev` label
from the URL entirely.

## Verifying from the target region

Do this **from a Russian network**, since that is the only meaningful test:

```powershell
curl.exe -sS -o NUL -w "%{http_code} %{size_download}\n" "https://<host>/api/iphone/"
```

200 + ~1.3 MB = reachable. Then confirm the payload parses with
`scripts/verify-mirror.ps1`.

## Known limitations

- **Freshness.** Pages mirrors lag by the cron interval; a VPN list that changes
  hourly is acceptable, one that changes every few minutes is not. Use the Worker
  if you need minutes-level freshness, or reduce cron to `*/5`.
- **Size.** ~1.3 MB per fetch. GitHub Pages soft-limits to 100 GB/month; a client
  polling every launch is fine, a client polling every 30 s is not.
- **Upstream terms.** The data belongs to the VPN Gate project. This mirror does
  not bypass authentication or payment, but it does re-serve their bandwidth —
  keep the refresh interval polite and do not resell it.
- **No health check for downstream clients.** If the mirror freezes (Actions
  disabled, quota exhausted), the client keeps getting stale-but-valid data with
  no error signal.
