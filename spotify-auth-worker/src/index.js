function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
      ...extraHeaders
    }
  });
}

function text(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
      ...extraHeaders
    }
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8"
    }
  });
}

function getOrigin(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

function requireMirrorId(url) {
  const mirrorId = new URL(url).searchParams.get("mirrorId");
  if (!mirrorId) {
    throw new Error("Missing mirrorId");
  }
  return mirrorId;
}

async function getTokenRecord(env, mirrorId) {
  const raw = await env.SPOTIFY_KV.get(`mirror:${mirrorId}`);
  return raw ? JSON.parse(raw) : null;
}

async function putTokenRecord(env, mirrorId, record) {
  await env.SPOTIFY_KV.put(`mirror:${mirrorId}`, JSON.stringify(record));
}

async function deleteTokenRecord(env, mirrorId) {
  await env.SPOTIFY_KV.delete(`mirror:${mirrorId}`);
}

async function createState(env, mirrorId) {
  const state = crypto.randomUUID();
  await env.SPOTIFY_KV.put(
    `state:${state}`,
    JSON.stringify({
      mirrorId,
      createdAt: Date.now()
    }),
    { expirationTtl: 600 }
  );
  return state;
}

async function consumeState(env, state) {
  const key = `state:${state}`;
  const raw = await env.SPOTIFY_KV.get(key);
  if (!raw) return null;
  await env.SPOTIFY_KV.delete(key);
  return JSON.parse(raw);
}

function spotifyAuthorizeUrl(env, origin, mirrorId, state) {
  const redirectUri = `${origin}/api/spotify/callback`;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.SPOTIFY_CLIENT_ID,
    scope: "user-read-currently-playing user-read-playback-state",
    redirect_uri: redirectUri,
    state
  });
  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

async function exchangeCodeForToken(env, origin, code) {
  const redirectUri = `${origin}/api/spotify/callback`;
  const basicAuth = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri
  });

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "authorization": `Basic ${basicAuth}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });

  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

async function refreshAccessToken(env, record) {
  const basicAuth = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: record.refreshToken
  });

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "authorization": `Basic ${basicAuth}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });

  const data = await res.json();

  if (!res.ok || !data.access_token) {
    return { ok: false, status: res.status, data };
  }

  const updated = {
    ...record,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || record.refreshToken,
    updatedAt: new Date().toISOString()
  };

  return { ok: true, status: res.status, data: updated };
}

async function fetchSpotifyCurrent(accessToken) {
  const res = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
    headers: {
      "authorization": `Bearer ${accessToken}`
    }
  });

  if (res.status === 204) {
    return { ok: true, status: 204, data: null };
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  return { ok: res.ok, status: res.status, data };
}

function simplifyCurrentPlayback(data) {
  if (!data || !data.item) {
    return { isPlaying: false };
  }

  const item = data.item;
  const albumArtUrl = Array.isArray(item.album?.images) && item.album.images.length
    ? item.album.images[0].url
    : "";

  return {
    isPlaying: !!data.is_playing,
    title: item.name || "",
    artist: Array.isArray(item.artists) ? item.artists.map(a => a.name).join(", ") : "",
    album: item.album?.name || "",
    albumArtUrl,
    progressMs: data.progress_ms ?? 0,
    durationMs: item.duration_ms ?? 0
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type"
        }
      });
    }

    if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) {
      return json({ ok: false, error: "Worker secrets are missing." }, 500);
    }

    if (url.pathname === "/api/spotify/login-url") {
      try {
        const mirrorId = requireMirrorId(request.url);
        const origin = getOrigin(request.url);
        const state = await createState(env, mirrorId);
        const loginUrl = spotifyAuthorizeUrl(env, origin, mirrorId, state);
        return json({ ok: true, mirrorId, url: loginUrl });
      } catch (err) {
        return json({ ok: false, error: err.message }, 400);
      }
    }

    if (url.pathname === "/api/spotify/login-qr") {
      try {
        const mirrorId = requireMirrorId(request.url);
        const origin = getOrigin(request.url);
        const state = await createState(env, mirrorId);
        const loginUrl = spotifyAuthorizeUrl(env, origin, mirrorId, state);

        // Simple SVG QR via external service avoided. Return a tiny HTML page that phone can open directly if desired.
        // The local settings page can render this URL as a QR using img src to a free QR endpoint if you want,
        // but for simplicity we return the URL here too.
        return json({ ok: true, mirrorId, url: loginUrl });
      } catch (err) {
        return json({ ok: false, error: err.message }, 400);
      }
    }

    if (url.pathname === "/api/spotify/callback") {
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      if (error) {
        return html(`
          <html><body style="font-family:sans-serif;background:#111;color:#fff;display:grid;place-items:center;min-height:100vh">
            <div><h2>Spotify login failed</h2><p>${error}</p></div>
          </body></html>
        `, 400);
      }

      if (!code || !state) {
        return html(`
          <html><body style="font-family:sans-serif;background:#111;color:#fff;display:grid;place-items:center;min-height:100vh">
            <div><h2>Missing callback params</h2></div>
          </body></html>
        `, 400);
      }

      const stateRecord = await consumeState(env, state);
      if (!stateRecord?.mirrorId) {
        return html(`
          <html><body style="font-family:sans-serif;background:#111;color:#fff;display:grid;place-items:center;min-height:100vh">
            <div><h2>State expired or invalid</h2><p>Generate a new QR and try again.</p></div>
          </body></html>
        `, 400);
      }

      const origin = getOrigin(request.url);
      const tokenRes = await exchangeCodeForToken(env, origin, code);

      if (!tokenRes.ok) {
        return html(`
          <html><body style="font-family:sans-serif;background:#111;color:#fff;display:grid;place-items:center;min-height:100vh">
            <div><h2>Spotify token exchange failed</h2><pre>${JSON.stringify(tokenRes.data, null, 2)}</pre></div>
          </body></html>
        `, 400);
      }

      const record = {
        accessToken: tokenRes.data.access_token,
        refreshToken: tokenRes.data.refresh_token,
        connectedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      await putTokenRecord(env, stateRecord.mirrorId, record);

      return html(`
        <html>
          <body style="font-family:sans-serif;background:#111;color:#fff;display:grid;place-items:center;min-height:100vh">
            <div style="max-width:460px;background:#1b1b1b;padding:24px;border-radius:16px;border:1px solid #2a2a2a;text-align:center">
              <h2 style="color:#1ed760;margin-top:0">Spotify connected â</h2>
              <p>You can return to your mirror now.</p>
              <p style="color:#bbb;font-size:14px">Mirror ID: ${stateRecord.mirrorId}</p>
            </div>
          </body>
        </html>
      `);
    }

    if (url.pathname === "/api/spotify/status") {
      try {
        const mirrorId = requireMirrorId(request.url);
        const record = await getTokenRecord(env, mirrorId);
        return json({
          ok: true,
          mirrorId,
          connected: !!(record?.accessToken && record?.refreshToken),
          connectedAt: record?.connectedAt || null,
          updatedAt: record?.updatedAt || null
        });
      } catch (err) {
        return json({ ok: false, error: err.message }, 400);
      }
    }

    if (url.pathname === "/api/spotify/disconnect" && request.method === "POST") {
      try {
        const mirrorId = requireMirrorId(request.url);
        await deleteTokenRecord(env, mirrorId);
        return json({ ok: true, mirrorId });
      } catch (err) {
        return json({ ok: false, error: err.message }, 400);
      }
    }

    if (url.pathname === "/api/spotify/current") {
      try {
        const mirrorId = requireMirrorId(request.url);
        let record = await getTokenRecord(env, mirrorId);

        if (!record?.accessToken || !record?.refreshToken) {
          return json({ ok: true, mirrorId, connected: false, isPlaying: false });
        }

        let current = await fetchSpotifyCurrent(record.accessToken);

        if (current.status === 401) {
          const refreshed = await refreshAccessToken(env, record);
          if (!refreshed.ok) {
            return json({ ok: false, error: "Token refresh failed." }, 401);
          }
          record = refreshed.data;
          await putTokenRecord(env, mirrorId, record);
          current = await fetchSpotifyCurrent(record.accessToken);
        }

        if (current.status === 204) {
          return json({ ok: true, mirrorId, connected: true, isPlaying: false });
        }

        if (!current.ok) {
          return json({ ok: false, error: "Spotify API error", status: current.status }, current.status);
        }

        return json({
          ok: true,
          mirrorId,
          connected: true,
          ...simplifyCurrentPlayback(current.data)
        });
      } catch (err) {
        return json({ ok: false, error: err.message }, 400);
      }
    }

    return text("Not found", 404);
  }
};
