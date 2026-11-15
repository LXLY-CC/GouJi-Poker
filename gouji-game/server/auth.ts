/**
 * Platform JWT verification for WebSocket upgrades.
 * Follows docs/server-auth.md. When no COMMUNITY_ISSUER is configured the
 * server runs in dev mode: it accepts unauthenticated local connections and
 * says so loudly. Dev mode must never be presented as production-secure.
 */
import type { JsonWebKey } from "node:crypto";
import {
  PlatformAuthError,
  verifyPlatformWebSocketRequest,
} from "@discourse-mini-app/sdk/server";

export interface ServerConfig {
  issuer: string;
  audience: string;
  appId: string;
  channel: "production" | "sandbox";
  devMode: boolean;
}

export interface Identity {
  sub: string;
  iss: string;
}

export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  const issuer = (env.COMMUNITY_ISSUER ?? "").trim();
  const audience = (env.SERVER_ORIGIN ?? "https://api.example.com").replace(/\/$/, "");
  const appId = (env.APP_ID ?? "01900000-0000-7000-8000-000000000000").trim();
  const channel = env.CHANNEL === "sandbox" ? "sandbox" : "production";
  const devMode = issuer === "" || env.DEV_MODE === "1";
  return { issuer, audience, appId, channel, devMode };
}

let cachedKey: JsonWebKey | null = null;
let cachedAt = 0;

async function loadPublicKey(issuer: string): Promise<JsonWebKey> {
  if (cachedKey && Date.now() - cachedAt < 60 * 60 * 1000) return cachedKey;
  const response = await fetch(`${issuer}/mini-app-api/jwks`, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`JWKS request failed: ${response.status}`);
  const body = (await response.json()) as { keys?: JsonWebKey[] } | null;
  const key = Array.isArray(body?.keys) && body.keys.length === 1 ? body.keys[0] : undefined;
  if (
    !key || key.kty !== "EC" || key.crv !== "P-256" || key.alg !== "ES256" ||
    key.use !== "sig" || typeof key.kid !== "string" || !key.kid ||
    typeof key.x !== "string" || typeof key.y !== "string" ||
    Object.hasOwn(key, "d")
  ) {
    throw new Error("Invalid community JWKS");
  }
  cachedKey = key;
  cachedAt = Date.now();
  return key;
}

function randomId(prefix: string): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `${prefix}-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Authenticate a WebSocket upgrade request. Returns the platform identity,
 * or a dev identity when dev mode is on. Throws PlatformAuthError (401) on
 * any verification failure in secure mode.
 */
export async function authenticateUpgrade(
  req: Request,
  config: ServerConfig
): Promise<Identity> {
  if (config.devMode) {
    return { sub: randomId("dev"), iss: "dev-mode" };
  }
  const url = new URL(req.url);
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(config.issuer).origin) {
    throw new PlatformAuthError();
  }
  const externalUrl = `${config.audience}${url.pathname}${url.search}`;
  const publicKey = await loadPublicKey(config.issuer);
  try {
    const identity = await verifyPlatformWebSocketRequest({
      issuer: config.issuer,
      audience: config.audience,
      appId: config.appId,
      channel: config.channel,
      publicKey,
      url: externalUrl,
    });
    return { sub: identity.sub, iss: identity.iss };
  } catch (error) {
    if (error instanceof PlatformAuthError) {
      // One JWKS refresh for key rotation, then give up.
      cachedKey = null;
      const refreshed = await loadPublicKey(config.issuer);
      const identity = await verifyPlatformWebSocketRequest({
        issuer: config.issuer,
        audience: config.audience,
        appId: config.appId,
        channel: config.channel,
        publicKey: refreshed,
        url: externalUrl,
      });
      return { sub: identity.sub, iss: identity.iss };
    }
    throw error;
  }
}
