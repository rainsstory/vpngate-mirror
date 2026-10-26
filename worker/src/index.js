/**
 * vpngate-mirror — live proxy in front of the public VPN Gate aggregate API.
 *
 * Why this exists: www.vpngate.net is unreachable from some networks (notably
 * RU). A Cloudflare Worker fetches upstream from the edge and republishes the
 * identical CSV so a client can point at the Worker instead.
 *
 * Routes:
 *   GET /api/iphone/   -> the CSV (same bytes as upstream)
 *   GET /              -> tiny text banner
 *
 * Behaviour:
 *   - tries https first, then http (some networks block only 443)
 *   - edge cache 300s, serves stale on upstream failure for up to 24h
 *   - CORS open, and never caches an empty/HTML error page as valid data
 */

const UPSTREAM_PATHS = ["/api/iphone/"];
const CACHE_TTL = 300;
const STALE_TTL = 86400;
const UA = "vpngate-mirror-worker/1.0";

function isCsvLike(text) {
  return typeof text === "string"
    && text.startsWith("*vpn_servers")
    && text.includes("#HostName,IP,Score");
}

async function fetchUpstream() {
  let lastError = null;
  for (const scheme of ["https", "http"]) {
    for (const path of UPSTREAM_PATHS) {
      const target = `${scheme}://www.vpngate.net${path}`;
      try {
        const res = await fetch(target, {
          headers: { "User-Agent": UA, Accept: "text/csv,*/*" },
          cf: { cacheTtl: 0 },
        });
        if (!res.ok) {
          lastError = `${target} -> HTTP ${res.status}`;
          continue;
        }
        const text = await res.text();
        if (!isCsvLike(text)) {
          lastError = `${target} -> payload is not VPN Gate CSV`;
          continue;
        }
        return { text, source: target };
      } catch (err) {
        lastError = `${target} -> ${err && err.message ? err.message : String(err)}`;
      }
    }
  }
  return { error: lastError || "no upstream attempted" };
}

function csvResponse(body, extraHeaders = {}) {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_TTL}`,
      "access-control-allow-origin": "*",
      "x-vpngate-mirror": "worker",
      ...extraHeaders,
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,HEAD,OPTIONS",
          "access-control-allow-headers": "*",
        },
      });
    }

    if (!url.pathname.startsWith("/api/iphone")) {
      return new Response(
        "vpngate-mirror worker\nGET /api/iphone/ for the VPN Gate aggregate CSV\n",
        { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    const cache = caches.default;
    const cacheKey = new Request(new URL("/api/iphone/", url.origin).toString(), {
      method: "GET",
    });

    const cached = await cache.match(cacheKey);
    if (cached) {
      return new Response(cached.body, {
        status: 200,
        headers: { ...Object.fromEntries(cached.headers), "x-vpngate-mirror": "cache" },
      });
    }

    const upstream = await fetchUpstream();
    if (upstream.error) {
      // Serve stale rather than fail: better an old list than no list.
      const stale = await cache.match(cacheKey, { ignoreMethod: true });
      if (stale) {
        return new Response(stale.body, {
          status: 200,
          headers: {
            ...Object.fromEntries(stale.headers),
            "x-vpngate-mirror": "stale",
            "x-vpngate-mirror-error": String(upstream.error).slice(0, 200),
          },
        });
      }
      return new Response(`upstream unavailable: ${upstream.error}\n`, {
        status: 502,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    const response = csvResponse(upstream.text, { "x-vpngate-upstream": upstream.source });
    const toCache = new Response(upstream.text, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "cache-control": `public, max-age=${STALE_TTL}`,
      },
    });
    ctx.waitUntil(cache.put(cacheKey, toCache));
    return response;
  },
};
