import { createHmac, timingSafeEqual } from "node:crypto";

const verifiedBodies = new WeakMap();

function rawBytes(rawBody) {
  if (typeof rawBody === "string") return Buffer.from(rawBody, "utf8");
  if (Buffer.isBuffer(rawBody)) return Buffer.from(rawBody);
  if (rawBody instanceof Uint8Array) return Buffer.from(rawBody);
  return null;
}

function requiredNotificationText(value, name) {
  if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f]/u.test(value)) {
    const error = new Error(`Squarespace notification ${name} is invalid.`);
    error.code = "SQUARESPACE_WEBHOOK_MALFORMED_NOTIFICATION";
    throw error;
  }
  return value;
}

export function verifySquarespaceWebhook({ rawBody, signature, secret } = {}) {
  const body = rawBytes(rawBody);
  if (!body) return false;
  if (typeof secret !== "string" || secret.length < 2 || secret.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(secret)) {
    return false;
  }
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/iu.test(signature)) return false;

  const expected = createHmac("sha256", Buffer.from(secret, "hex")).update(body).digest();
  const supplied = Buffer.from(signature, "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) return false;

  const verification = Object.freeze({ verified: true });
  verifiedBodies.set(verification, body);
  return verification;
}

export function parseSquarespaceNotification({ verification } = {}) {
  if (!verification || typeof verification !== "object" || !verifiedBodies.has(verification)) {
    const error = new Error("Squarespace notifications may be parsed only after successful signature verification.");
    error.code = "SQUARESPACE_WEBHOOK_UNVERIFIED";
    throw error;
  }
  const body = verifiedBodies.get(verification);
  verifiedBodies.delete(verification);

  let payload;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    const error = new Error("Squarespace returned malformed webhook JSON.");
    error.code = "SQUARESPACE_WEBHOOK_MALFORMED_NOTIFICATION";
    throw error;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    const error = new Error("Squarespace returned a malformed webhook notification.");
    error.code = "SQUARESPACE_WEBHOOK_MALFORMED_NOTIFICATION";
    throw error;
  }

  return Object.freeze({
    notificationId: requiredNotificationText(payload.id, "id"),
    topic: requiredNotificationText(payload.topic, "topic"),
    createdOn: requiredNotificationText(payload.createdOn, "createdOn"),
    providerWebsiteId: requiredNotificationText(payload.websiteId, "websiteId"),
    providerSubscriptionId: requiredNotificationText(payload.subscriptionId, "subscriptionId"),
    data: payload.data && typeof payload.data === "object" && !Array.isArray(payload.data) ? payload.data : {},
    workspaceId: null,
    connectionId: null,
    tenancyResolved: false
  });
}
