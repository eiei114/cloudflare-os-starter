import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { fetchPiConsole, type PiConsoleEnv } from "../src/pi-console.js";

const origin = "https://os.example.com";
const prefix = "/gatekeeper/custom/pi";
const env: PiConsoleEnv = {
  PI_RUNNER_URL: "https://private-tunnel.example", PI_RUNNER_TOKEN: "separate-proxy-token",
  CF_ACCESS_ISS: "https://test.cloudflareaccess.com", CF_ACCESS_AUD: "os-audience",
  ADMINS: ["owner@example.com"], PUBLIC_BASE_URL: origin,
};
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwk: Awaited<ReturnType<typeof exportJWK>>;
beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  jwk = { ...await exportJWK(keys.publicKey), kid: "test", alg: "RS256", use: "sig" };
});
afterEach(() => vi.unstubAllGlobals());
async function jwt(email = "owner@example.com", aud = "os-audience", expires = "5m") {
  return new SignJWT({ email }).setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(env.CF_ACCESS_ISS!).setAudience(aud).setIssuedAt().setExpirationTime(expires)
    .sign(keys.privateKey);
}
function fakeFetch() {
  const forwarded: Request[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: Request | URL) => {
    if (String(input).includes("/cdn-cgi/access/certs")) {
      return Response.json({ keys: [jwk] });
    }
    forwarded.push(input as Request);
    return new Response("pi upstream", { headers: { "set-cookie": "private=1" } });
  }));
  return forwarded;
}
async function request(route = `${prefix}/api/projects?limit=1`, init: RequestInit = {}, token?: string) {
  const headers = new Headers(init.headers);
  headers.set("cf-access-jwt-assertion", token ?? await jwt());
  return new Request(`${origin}${route}`, { ...init, headers });
}

describe("owner-only Pi console", () => {
  it("does not match sibling paths; missing configuration and anonymous callers fail closed", async () => {
    expect(await fetchPiConsole(new Request(`${origin}${prefix}-other`), env)).toBeUndefined();
    expect((await fetchPiConsole(new Request(`${origin}${prefix}/`), {}))!.status).toBe(503);
    expect((await fetchPiConsole(new Request(`${origin}${prefix}/`), env))!.status).toBe(401);
  });
  it("verifies signature, audience, expiry and owner; invalid identities never reach the Mac", async () => {
    const forwarded = fakeFetch();
    for (const [token, status] of [
      [await jwt("stranger@example.com"), 403], [await jwt(undefined, "wrong"), 401],
      [await jwt(undefined, undefined, "-1m"), 401], ["invalid-token", 401],
    ] as const) {
      expect((await fetchPiConsole(await request(undefined, {}, token), env))!.status).toBe(status);
    }
    expect(forwarded).toHaveLength(0);
  });
  it("strips the prefix, keeps query, injects only the proxy key and removes sensitive cookies", async () => {
    const forwarded = fakeFetch();
    const response = await fetchPiConsole(await request(undefined, { headers: {
      cookie: "CF_Authorization=private", authorization: "Bearer attacker", "x-unsafe": "private",
    } }), env);
    expect(response!.status).toBe(200);
    expect(response!.headers.get("set-cookie")).toBeNull();
    expect(response!.headers.get("cache-control")).toBe("no-store");
    expect(forwarded[0].url).toBe("https://private-tunnel.example/api/projects?limit=1");
    expect(forwarded[0].headers.get("authorization")).toBe("Bearer separate-proxy-token");
    for (const name of ["cookie", "cf-access-jwt-assertion", "x-unsafe"]) {
      expect(forwarded[0].headers.get(name)).toBeNull();
    }
  });
  it("requires canonical Origin for writes and WebSocket upgrades", async () => {
    const forwarded = fakeFetch();
    for (const init of [{ method: "POST" }, { headers: { upgrade: "websocket" } },
      { headers: { origin: "https://attacker.example" } },
      { method: "POST", headers: { origin: "https://attacker.example" } }]) {
      expect((await fetchPiConsole(await request(undefined, init), env))!.status).toBe(403);
    }
    expect(forwarded).toHaveLength(0);
    expect((await fetchPiConsole(await request(undefined, { method: "POST", body: "{}",
      headers: { origin, "content-type": "application/json" } }), env))!.status).toBe(200);
    expect(await forwarded[0].text()).toBe("{}");
  });
  it("preserves an authenticated WebSocket upgrade response", async () => {
    const pair = new WebSocketPair();
    const upgraded = new Response(null, { status: 101, webSocket: pair[0] });
    vi.stubGlobal("fetch", vi.fn(async (input: Request | URL) => {
      if (String(input).includes("/cdn-cgi/access/certs")) return Response.json({ keys: [jwk] });
      expect((input as Request).url).toBe("https://private-tunnel.example/api/socket");
      expect((input as Request).headers.get("origin")).toBe(origin);
      expect((input as Request).headers.get("authorization")).toBe("Bearer separate-proxy-token");
      return upgraded;
    }));
    const response = await fetchPiConsole(await request(`${prefix}/api/socket`, { headers: {
      origin, upgrade: "websocket", "sec-websocket-key": "test", "sec-websocket-version": "13",
    } }), env);
    expect(response).toBe(upgraded);
  });
  it("redirects a slashless entry before proxying and fails safely if upstream is unavailable", async () => {
    const forwarded = fakeFetch();
    const response = await fetchPiConsole(await request(prefix), env);
    expect(response!.status).toBe(302);
    expect(response!.headers.get("location")).toBe(`${origin}${prefix}/`);
    expect(forwarded).toHaveLength(0);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("private diagnostic"); }));
    const failed = await fetchPiConsole(await request(), env);
    expect(failed!.status).toBe(502);
    expect(await failed!.text()).not.toContain("private diagnostic");
  });
});
