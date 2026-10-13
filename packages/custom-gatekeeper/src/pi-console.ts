import { createRemoteJWKSet, jwtVerify } from 'jose';

const PREFIX = '/gatekeeper/custom/pi';
const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** Private human console configuration, separate from the credential-free example RPC API. */
export type PiConsoleEnv = {
  /** Fixed HTTPS origin of the bearer-protected Mac proxy. */
  PI_RUNNER_URL?: string;
  /** Proxy bearer key; never a model provider credential. */
  PI_RUNNER_TOKEN?: string;
  /** Cloudflare Access team issuer shared with the existing OS. */
  CF_ACCESS_ISS?: string;
  /** Expected existing OS Access application audience. */
  CF_ACCESS_AUD?: string;
  /** Owner emails permitted to control the Mac. */
  ADMINS?: string[];
  /** Canonical OS origin for CSRF and WebSocket Origin checks. */
  PUBLIC_BASE_URL?: string;
};

/**
 * Serve the separate Pi console through existing Access, without replacing OS chat or granting
 * an agent-facing capability. Every HTTP/WS request verifies Access JWT issuer, audience, expiry,
 * signature and owner email; modifying requests additionally require the OS Origin.
 */
export async function fetchPiConsole(request: Request, env: PiConsoleEnv): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return undefined;
  if (!env.PI_RUNNER_URL || !env.PI_RUNNER_TOKEN || !env.CF_ACCESS_ISS || !env.CF_ACCESS_AUD ||
      !env.PUBLIC_BASE_URL || !env.ADMINS?.length) {
    return new Response('Pi console is not configured.', { status: 503 });
  }
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) return new Response('Cloudflare Access authentication required.', { status: 401 });
  const issuer = env.CF_ACCESS_ISS.replace(/\/$/, '');
  try {
    let jwks = jwksByIssuer.get(issuer);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
      jwksByIssuer.set(issuer, jwks);
    }
    const { payload } = await jwtVerify(token, jwks, { issuer, audience: env.CF_ACCESS_AUD,
      algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'email'] });
    if (typeof payload.email !== 'string' || !env.ADMINS.includes(payload.email)) {
      return new Response('This Pi console is owner-only.', { status: 403 });
    }
  } catch { return new Response('Invalid Cloudflare Access authentication.', { status: 401 }); }

  const webSocket = request.headers.get('upgrade')?.toLowerCase() === 'websocket';
  const origin = request.headers.get('origin');
  if ((origin !== null || webSocket || !['GET', 'HEAD'].includes(request.method)) &&
      origin !== env.PUBLIC_BASE_URL) {
    return new Response('Origin not allowed.', { status: 403 });
  }
  if (url.pathname === PREFIX) {
    url.pathname += '/';
    return Response.redirect(url.href, 302);
  }
  let target: URL;
  try { target = new URL(env.PI_RUNNER_URL); }
  catch { return new Response('Invalid Pi proxy configuration.', { status: 503 }); }
  if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash ||
      target.pathname !== '/') return new Response('Invalid Pi proxy configuration.', { status: 503 });
  target.pathname = url.pathname.slice(PREFIX.length);
  target.search = url.search;
  // Allowlist forwarding. Never leak Access JWT/cookies, or accept a caller-supplied proxy key.
  const headers = new Headers({ authorization: `Bearer ${env.PI_RUNNER_TOKEN}` });
  for (const name of ['accept', 'content-type', 'origin', 'range', 'upgrade', 'connection',
    'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  try {
    const upstream = await fetch(new Request(target, { method: request.method, headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual' }));
    if (upstream.status === 101) return upstream;
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete('set-cookie');
    responseHeaders.set('cache-control', 'no-store');
    const location = responseHeaders.get('location');
    if (location) {
      const redirect = new URL(location, target);
      if (redirect.origin === target.origin) {
        responseHeaders.set('location', `${env.PUBLIC_BASE_URL}${PREFIX}${redirect.pathname}${redirect.search}${redirect.hash}`);
      }
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch { return new Response('Pi is unavailable. Check that the Mac and tunnel are running.', { status: 502 }); }
}
