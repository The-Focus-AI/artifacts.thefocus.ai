import {
  authenticatePublisherToken,
  InvalidPublisherTokenError,
  RevokedPublisherTokenError,
  type PublisherTokenStore,
} from "./auth.js";
import { isPwaWildcardHost, pwaRouteFromUrl } from "./pwa-host.js";
import type { PublicationMetadataStore } from "./storage/publication-metadata.js";
import type {
  PwaPushSubscriptionRecord,
  PwaPushSubscriptionStore,
} from "./storage/pwa-push-subscriptions.js";

export const vapidPublicKeyEnv = "VAPID_PUBLIC_KEY";
export const vapidPrivateKeyEnv = "VAPID_PRIVATE_KEY";
export const vapidSubjectEnv = "VAPID_SUBJECT";

export const defaultPwaPushSendLimit = 20;
export const defaultPwaPushSendWindowMs = 60_000;

export interface VapidKeyConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface PwaPushSubscribeBody {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
}

export interface ParsedPushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface SendPwaPushInput {
  publicationUrl: string;
  title: string;
  body: string;
  url?: string;
  data?: unknown;
}

export interface SendPwaPushResult {
  publicationUrl: string;
  opaqueId: string;
  title: string;
  body: string;
  url?: string;
  subscriptionCount: number;
  delivered: number;
  gone: number;
  failed: number;
  implementation: "stubbed" | "web-push";
  message?: string;
}

export interface WebPushDeliveryResult {
  endpoint: string;
  status: "sent" | "gone" | "failed";
  statusCode?: number;
  error?: string;
}

export interface WebPushSender {
  send(input: {
    subscription: PwaPushSubscriptionRecord;
    payload: SendPwaPushInput;
    vapid: VapidKeyConfig;
  }): Promise<WebPushDeliveryResult>;
}

export interface PwaPushSendRateLimiter {
  consume(publisherEmail: string, opaqueId: string): boolean;
}

export interface HandlePwaPushRequestInput {
  request: Request;
  metadataStore: PublicationMetadataStore;
  subscriptionStore: PwaPushSubscriptionStore;
  tokenStore: PublisherTokenStore;
  env?: NodeJS.ProcessEnv;
  sender?: WebPushSender;
  rateLimiter?: PwaPushSendRateLimiter;
}

export class PwaPushRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "PwaPushRequestError";
    this.status = status;
  }
}

export function readVapidPublicKey(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const value = env[vapidPublicKeyEnv]?.trim();
  return value || null;
}

export function readVapidConfig(
  env: NodeJS.ProcessEnv = process.env,
): VapidKeyConfig | null {
  const publicKey = env[vapidPublicKeyEnv]?.trim();
  const privateKey = env[vapidPrivateKeyEnv]?.trim();
  const subject = env[vapidSubjectEnv]?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

export function parsePushSubscription(
  body: PwaPushSubscribeBody | null | undefined,
): ParsedPushSubscription {
  const endpoint =
    typeof body?.endpoint === "string" ? body.endpoint.trim() : "";
  const p256dh =
    typeof body?.keys?.p256dh === "string" ? body.keys.p256dh.trim() : "";
  const auth =
    typeof body?.keys?.auth === "string" ? body.keys.auth.trim() : "";
  if (!isHttpsUrl(endpoint) || !p256dh || !auth) {
    throw new PwaPushRequestError(
      400,
      "Subscribe requires a PushSubscription JSON body with endpoint and keys.p256dh / keys.auth",
    );
  }
  return { endpoint, p256dh, auth };
}

export function parseSendPwaPushInput(body: unknown): SendPwaPushInput {
  const record = asRecord(body);
  const publicationUrl =
    typeof record.publicationUrl === "string"
      ? record.publicationUrl.trim()
      : "";
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const notificationBody =
    typeof record.body === "string" ? record.body.trim() : "";
  if (!publicationUrl || !title || !notificationBody) {
    throw new PwaPushRequestError(
      400,
      "Send requires publicationUrl, title, and body",
    );
  }
  if (title.length > 200 || notificationBody.length > 2000) {
    throw new PwaPushRequestError(
      400,
      "title or body exceeds the send size cap",
    );
  }
  const url = typeof record.url === "string" ? record.url.trim() : undefined;
  return {
    publicationUrl,
    title,
    body: notificationBody,
    url: url || undefined,
    data: record.data,
  };
}

export function opaqueIdFromPwaRequestHost(request: Request): string | null {
  const host = requestHost(request);
  if (!isPwaWildcardHost(host)) return null;
  return pwaRouteFromUrl(request.url)?.opaqueId ?? null;
}

export function createInMemoryPwaPushSendRateLimiter(
  options: { max?: number; windowMs?: number; now?: () => number } = {},
): PwaPushSendRateLimiter {
  const max = options.max ?? defaultPwaPushSendLimit;
  const windowMs = options.windowMs ?? defaultPwaPushSendWindowMs;
  const now = options.now ?? Date.now;
  const hits = new Map<string, number[]>();
  return {
    consume(publisherEmail: string, opaqueId: string): boolean {
      const key = `${publisherEmail}:${opaqueId}`;
      const cutoff = now() - windowMs;
      const recent = (hits.get(key) ?? []).filter((at) => at > cutoff);
      if (recent.length >= max) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now());
      hits.set(key, recent);
      return true;
    },
  };
}

const processLocalSendRateLimiter = createInMemoryPwaPushSendRateLimiter();

export async function handlePwaPushRequest(
  input: HandlePwaPushRequestInput,
): Promise<Response> {
  const cors = corsHeaders(input.request);
  if (input.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  try {
    const action = pushActionFromRequest(input.request);
    if (input.request.method === "GET" && action === "vapid-public-key") {
      return json(await vapidPublicKeyResponse(input), 200, cors);
    }
    if (input.request.method === "POST" && action === "subscribe") {
      return json(await subscribePwaPush(input), 200, cors);
    }
    if (input.request.method === "POST" && action === "unsubscribe") {
      return json(await unsubscribePwaPush(input), 200, cors);
    }
    if (input.request.method === "POST" && action === "send") {
      return json(await sendPwaPush(input), 200, cors);
    }
    throw new PwaPushRequestError(404, "Not found");
  } catch (error) {
    if (error instanceof PwaPushRequestError) {
      return json({ error: error.message }, error.status, cors);
    }
    if (
      error instanceof InvalidPublisherTokenError ||
      error instanceof RevokedPublisherTokenError
    ) {
      return json({ error: error.message }, 401, cors);
    }
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      400,
      cors,
    );
  }
}

async function vapidPublicKeyResponse(
  input: HandlePwaPushRequestInput,
): Promise<{ publicKey: string }> {
  await requireActivePwaFromHost(input);
  const publicKey = readVapidPublicKey(input.env ?? process.env);
  if (!publicKey) {
    throw new PwaPushRequestError(
      503,
      "Platform VAPID public key is not configured (VAPID_PUBLIC_KEY)",
    );
  }
  return { publicKey };
}

async function subscribePwaPush(input: HandlePwaPushRequestInput): Promise<{
  status: "subscribed";
  opaqueId: string;
}> {
  const publication = await requireActivePwaFromHost(input);
  const subscription = parsePushSubscription(
    (await readJsonBody(input.request)) as PwaPushSubscribeBody,
  );
  await input.subscriptionStore.upsert({
    opaqueId: publication.opaqueId,
    endpoint: subscription.endpoint,
    p256dh: subscription.p256dh,
    auth: subscription.auth,
    userAgent: input.request.headers.get("user-agent"),
  });
  return { status: "subscribed", opaqueId: publication.opaqueId };
}

async function unsubscribePwaPush(input: HandlePwaPushRequestInput): Promise<{
  status: "unsubscribed";
  opaqueId: string;
}> {
  const publication = await requireActivePwaFromHost(input);
  const body = (await readJsonBody(input.request)) as PwaPushSubscribeBody;
  const endpoint =
    typeof body?.endpoint === "string" ? body.endpoint.trim() : "";
  if (!endpoint) {
    throw new PwaPushRequestError(400, "Unsubscribe requires endpoint");
  }
  await input.subscriptionStore.deleteByEndpoint({
    opaqueId: publication.opaqueId,
    endpoint,
  });
  return { status: "unsubscribed", opaqueId: publication.opaqueId };
}

export async function sendPwaPush(
  input: HandlePwaPushRequestInput,
): Promise<SendPwaPushResult> {
  const publisherEmail = await authenticatePublisherToken({
    token: bearerToken(input.request),
    store: input.tokenStore,
  });
  const payload = parseSendPwaPushInput(await readJsonBody(input.request));
  const route = pwaRouteFromUrl(payload.publicationUrl);
  if (!route) {
    throw new PwaPushRequestError(
      400,
      "Send requires a PWA Publication URL at https://{opaque}.artifacts.thefocus.ai/",
    );
  }
  const publication = await input.metadataStore.getByOpaqueId(route.opaqueId, {
    ignoreCase: true,
  });
  if (!publication || publication.status !== "active" || !publication.pwa) {
    throw new PwaPushRequestError(404, "PWA Publication not found");
  }
  if (publication.publisherEmail !== publisherEmail) {
    throw new PwaPushRequestError(
      403,
      "Only the Publisher who owns this PWA may send push",
    );
  }

  const limiter = input.rateLimiter ?? processLocalSendRateLimiter;
  if (!limiter.consume(publisherEmail, publication.opaqueId)) {
    throw new PwaPushRequestError(429, "Push send rate limit exceeded");
  }

  const subscriptions = await input.subscriptionStore.listByOpaqueId(
    publication.opaqueId,
  );
  const vapid = readVapidConfig(input.env ?? process.env);
  if (!input.sender || !vapid) {
    return {
      publicationUrl: payload.publicationUrl,
      opaqueId: publication.opaqueId,
      title: payload.title,
      body: payload.body,
      url: payload.url,
      subscriptionCount: subscriptions.length,
      delivered: 0,
      gone: 0,
      failed: 0,
      implementation: "stubbed",
      message:
        "Authorized send targeting is implemented. Live web-push fanout waits on VAPID_* and a WebPushSender. Gone (410) endpoints will be deleted on send.",
    };
  }

  let delivered = 0;
  let gone = 0;
  let failed = 0;
  for (const subscription of subscriptions) {
    const result = await input.sender.send({
      subscription,
      payload,
      vapid,
    });
    if (result.status === "sent") {
      delivered += 1;
      continue;
    }
    if (result.status === "gone") {
      gone += 1;
      await input.subscriptionStore.deleteById(subscription.id);
      continue;
    }
    failed += 1;
  }

  return {
    publicationUrl: payload.publicationUrl,
    opaqueId: publication.opaqueId,
    title: payload.title,
    body: payload.body,
    url: payload.url,
    subscriptionCount: subscriptions.length,
    delivered,
    gone,
    failed,
    implementation: "web-push",
  };
}

async function requireActivePwaFromHost(input: HandlePwaPushRequestInput) {
  const opaqueId = opaqueIdFromPwaRequestHost(input.request);
  if (!opaqueId) {
    throw new PwaPushRequestError(
      400,
      "Call this endpoint on the PWA origin https://{opaque}.artifacts.thefocus.ai/",
    );
  }
  const publication = await input.metadataStore.getByOpaqueId(opaqueId, {
    ignoreCase: true,
  });
  if (!publication || publication.status !== "active" || !publication.pwa) {
    throw new PwaPushRequestError(404, "PWA Publication not found");
  }
  return publication;
}

export function pushActionFromRequest(request: Request): string {
  const url = new URL(request.url);
  const fromQuery = url.searchParams.get("action")?.trim();
  if (fromQuery) return fromQuery;
  const segments = url.pathname.split("/").filter(Boolean);
  const pushIndex = segments.lastIndexOf("push");
  const after = pushIndex >= 0 ? segments[pushIndex + 1] : segments.at(-1);
  if (after && after !== "push") return after;
  return request.method === "GET" ? "vapid-public-key" : "";
}

function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = {
    vary: "Origin",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
  };
  if (origin && originMatchesRequestHost(origin, request)) {
    headers["access-control-allow-origin"] = origin;
  }
  return headers;
}

function originMatchesRequestHost(origin: string, request: Request): boolean {
  try {
    const parsed = new URL(origin);
    return parsed.host === requestHost(request);
  } catch {
    return false;
  }
}

function requestHost(request: Request): string {
  const url = new URL(request.url);
  return url.host;
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PwaPushRequestError(400, "Request body must be JSON");
  }
}

function json(body: unknown, status: number, cors: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...cors,
    },
  });
}

function isHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
