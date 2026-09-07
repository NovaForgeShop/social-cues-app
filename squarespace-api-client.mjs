import { squarespaceExtensionConfig } from "./squarespace-extension-config.mjs";

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const PRODUCT_TYPES = new Set(["PHYSICAL", "SERVICE", "GIFT_CARD", "DIGITAL"]);
const DISCOUNT_SORT_FIELDS = new Set(["CREATED_ON", "PROMO_CODE", "USES_COUNT"]);
const SORT_DIRECTIONS = new Set(["ASCENDING", "DESCENDING"]);
const DISCOUNT_STATUSES = new Set(["ALL", "ACTIVE", "EXPIRED", "SCHEDULED"]);

class SquarespaceApiError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "SquarespaceApiError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(message, code, details) {
  throw new SquarespaceApiError(message, code, details);
}

function requiredText(value, name, code = "SQUARESPACE_API_INVALID_REQUEST") {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${name} is invalid.`, code);
  }
  return value.trim();
}

function identifier(value, name) {
  const normalized = requiredText(value, name);
  if (normalized.length > 512) fail(`${name} is invalid.`, "SQUARESPACE_API_INVALID_REQUEST");
  return normalized;
}

function normalizeBinding(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    fail("A workspace and website binding is required.", "SQUARESPACE_API_BINDING_ERROR");
  }
  return Object.freeze({
    workspaceId: identifier(binding.workspaceId, "workspaceId"),
    connectionId: identifier(binding.connectionId, "connectionId"),
    websiteId: identifier(binding.websiteId, "websiteId")
  });
}

function boundedInteger(value, name, fallback, minimum, maximum) {
  const normalized = value === undefined ? fallback : value;
  if (!Number.isInteger(normalized) || normalized < minimum || normalized > maximum) {
    fail(`${name} must be an integer from ${minimum} through ${maximum}.`, "SQUARESPACE_API_CONFIGURATION_ERROR");
  }
  return normalized;
}

function normalizeBaseUrl(value, allowInsecureLocalhostForTests) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    fail("baseUrl is malformed.", "SQUARESPACE_API_CONFIGURATION_ERROR");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(allowInsecureLocalhostForTests === true && url.protocol === "http:" && loopback)) {
    fail("baseUrl must use HTTPS.", "SQUARESPACE_API_CONFIGURATION_ERROR");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    fail("baseUrl must be a credential-free API origin.", "SQUARESPACE_API_CONFIGURATION_ERROR");
  }
  return url.origin;
}

function plainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object.`, "SQUARESPACE_API_INVALID_REQUEST");
  }
  return value;
}

function isoDate(value, name) {
  if (value === undefined) return undefined;
  const normalized = requiredText(value, name);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(normalized) || Number.isNaN(Date.parse(normalized))) {
    fail(`${name} must be an ISO 8601 UTC date-time.`, "SQUARESPACE_API_INVALID_REQUEST");
  }
  return normalized;
}

function dateWindow(input) {
  const modifiedAfter = isoDate(input.modifiedAfter, "modifiedAfter");
  const modifiedBefore = isoDate(input.modifiedBefore, "modifiedBefore");
  if ((modifiedAfter && !modifiedBefore) || (!modifiedAfter && modifiedBefore)) {
    fail("modifiedAfter and modifiedBefore must be supplied together.", "SQUARESPACE_API_INVALID_REQUEST");
  }
  if (modifiedAfter && Date.parse(modifiedAfter) >= Date.parse(modifiedBefore)) {
    fail("modifiedAfter must be before modifiedBefore.", "SQUARESPACE_API_INVALID_REQUEST");
  }
  return { modifiedAfter, modifiedBefore };
}

function cursorValue(value) {
  return value === undefined ? undefined : identifier(value, "cursor");
}

function encodedIdentifiers(values, name, maximum = 50) {
  const list = Array.isArray(values) ? values : [values];
  if (list.length < 1 || list.length > maximum) {
    fail(`${name} must contain from 1 through ${maximum} identifiers.`, "SQUARESPACE_API_INVALID_REQUEST");
  }
  return list.map((value) => encodeURIComponent(identifier(value, name))).join(",");
}

function addQuery(url, query) {
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length) url.searchParams.set(key, value.join(","));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

function retryAfterMs(response, maximum, now) {
  const header = response.headers?.get?.("retry-after");
  if (!header) return Math.min(250, maximum);
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.round(seconds * 1000), maximum);
  const date = Date.parse(header);
  return Number.isNaN(date) ? Math.min(250, maximum) : Math.min(Math.max(0, date - now()), maximum);
}

function responseObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("Squarespace returned a malformed API response.", "SQUARESPACE_API_MALFORMED_RESPONSE");
  }
  return value;
}

function responseArray(payload, key) {
  responseObject(payload);
  if (!Array.isArray(payload[key])) {
    fail("Squarespace returned a malformed API response.", "SQUARESPACE_API_MALFORMED_RESPONSE");
  }
  return payload[key];
}

function nextCursor(payload) {
  if (!payload.pagination || payload.pagination.hasNextPage !== true) return null;
  const cursor = payload.pagination.nextPageCursor;
  if (typeof cursor !== "string" || !cursor) {
    fail("Squarespace returned an invalid pagination cursor.", "SQUARESPACE_API_MALFORMED_RESPONSE");
  }
  return cursor;
}

function enumValue(value, allowed, name) {
  if (value === undefined) return undefined;
  if (!allowed.has(value)) fail(`${name} is unsupported.`, "SQUARESPACE_API_INVALID_REQUEST");
  return value;
}

export function createSquarespaceApiClient(options = {}) {
  const accessToken = requiredText(
    options.accessToken,
    "accessToken",
    "SQUARESPACE_API_CONFIGURATION_ERROR"
  );
  if (typeof options.fetchImpl !== "function") {
    fail("fetchImpl must be explicitly injected.", "SQUARESPACE_API_CONFIGURATION_ERROR");
  }
  if (options.sleepImpl !== undefined && typeof options.sleepImpl !== "function") {
    fail("sleepImpl must be a function.", "SQUARESPACE_API_CONFIGURATION_ERROR");
  }
  if (options.nowImpl !== undefined && typeof options.nowImpl !== "function") {
    fail("nowImpl must be a function.", "SQUARESPACE_API_CONFIGURATION_ERROR");
  }
  const fetchImpl = options.fetchImpl;
  const sleepImpl = options.sleepImpl || ((durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)));
  const nowImpl = options.nowImpl || Date.now;
  const binding = normalizeBinding(options.binding);
  const baseUrl = normalizeBaseUrl(
    options.baseUrl ?? squarespaceExtensionConfig.api.baseUrl,
    options.allowInsecureLocalhostForTests
  );
  const userAgent = requiredText(
    options.userAgent ?? squarespaceExtensionConfig.api.userAgent,
    "userAgent",
    "SQUARESPACE_API_CONFIGURATION_ERROR"
  );
  const timeoutMs = boundedInteger(options.timeoutMs, "timeoutMs", 10_000, 1, 30_000);
  const maxRetries = boundedInteger(options.maxRetries, "maxRetries", 2, 0, 3);
  const maxRetryDelayMs = boundedInteger(options.maxRetryDelayMs, "maxRetryDelayMs", 3_000, 0, 10_000);
  const defaultMaxPages = boundedInteger(options.maxPages, "maxPages", 100, 1, 1_000);

  async function request({ path, method = "GET", query, body, retryableRead = true }) {
    const url = new URL(path, `${baseUrl}/`);
    addQuery(url, query);
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": userAgent,
      Accept: "application/json"
    };
    const serializedBody = body === undefined ? undefined : JSON.stringify(body);
    if (serializedBody !== undefined) headers["Content-Type"] = "application/json";

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers,
          body: serializedBody,
          signal: controller.signal
        });
      } catch (error) {
        clearTimeout(timer);
        const timedOut = controller.signal.aborted || error?.name === "AbortError";
        if (retryableRead && attempt < maxRetries) {
          await sleepImpl(Math.min(100 * 2 ** attempt, maxRetryDelayMs));
          continue;
        }
        fail(
          timedOut ? "The Squarespace API request timed out." : "The Squarespace API request failed before a response.",
          timedOut ? "SQUARESPACE_API_TIMEOUT" : "SQUARESPACE_API_NETWORK_ERROR"
        );
      } finally {
        clearTimeout(timer);
      }

      if (!response || typeof response.ok !== "boolean") {
        fail("Squarespace returned an invalid transport response.", "SQUARESPACE_API_MALFORMED_RESPONSE");
      }
      if (!response.ok) {
        if (retryableRead && RETRYABLE_STATUSES.has(response.status) && attempt < maxRetries) {
          await sleepImpl(retryAfterMs(response, maxRetryDelayMs, nowImpl));
          continue;
        }
        const code = response.status === 429 ? "SQUARESPACE_API_RATE_LIMITED" : "SQUARESPACE_API_PROVIDER_ERROR";
        fail("Squarespace rejected the read request.", code, { status: response.status });
      }

      let text;
      try {
        text = await response.text();
      } catch {
        fail("Squarespace returned an unreadable API response.", "SQUARESPACE_API_MALFORMED_RESPONSE");
      }
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        fail("Squarespace returned malformed JSON.", "SQUARESPACE_API_MALFORMED_RESPONSE");
      }
    }
    fail("The bounded retry loop ended unexpectedly.", "SQUARESPACE_API_NETWORK_ERROR");
  }

  async function paginate(fetchPage, collectionKey, requestedMaxPages) {
    const maxPages = boundedInteger(requestedMaxPages, "maxPages", defaultMaxPages, 1, 1_000);
    const items = [];
    const seenCursors = new Set();
    let cursor;
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      const page = responseObject(await fetchPage(cursor));
      items.push(...responseArray(page, collectionKey));
      const next = nextCursor(page);
      if (!next) return Object.freeze({ items, pages: pageNumber, truncated: false });
      if (seenCursors.has(next)) {
        fail("Squarespace repeated a pagination cursor.", "SQUARESPACE_API_CURSOR_LOOP");
      }
      seenCursors.add(next);
      cursor = next;
    }
    return Object.freeze({ items, pages: maxPages, truncated: true });
  }

  async function getAuthenticatedMember() {
    return responseObject(await request({ path: squarespaceExtensionConfig.api.paths.authenticatedMember }));
  }

  async function getAuthenticatedWebsite() {
    const website = responseObject(await request({ path: squarespaceExtensionConfig.api.paths.authenticatedWebsite }));
    if (website.id !== binding.websiteId) {
      fail("The access token belongs to a different Squarespace website.", "SQUARESPACE_API_BINDING_ERROR");
    }
    return website;
  }

  async function listStorePages(input = {}) {
    const payload = responseObject(
      await request({ path: squarespaceExtensionConfig.api.paths.storePages, query: { cursor: cursorValue(input.cursor) } })
    );
    responseArray(payload, "storePages");
    return payload;
  }

  function listAllStorePages(input = {}) {
    return paginate((cursor) => listStorePages({ cursor }), "storePages", input.maxPages);
  }

  async function listProducts(input = {}) {
    const cursor = cursorValue(input.cursor);
    const dates = dateWindow(input);
    if (cursor && dates.modifiedAfter) {
      fail("cursor cannot be combined with product date filters.", "SQUARESPACE_API_INVALID_REQUEST");
    }
    const types = input.types === undefined ? undefined : input.types;
    if (types !== undefined && (!Array.isArray(types) || !types.length || types.some((type) => !PRODUCT_TYPES.has(type)))) {
      fail("types contains an unsupported product type.", "SQUARESPACE_API_INVALID_REQUEST");
    }
    const payload = responseObject(
      await request({
        path: squarespaceExtensionConfig.api.paths.products,
        query: {
          cursor,
          modifiedAfter: dates.modifiedAfter,
          modifiedBefore: dates.modifiedBefore,
          query: input.query === undefined ? undefined : requiredText(input.query, "query"),
          type: types
        }
      })
    );
    responseArray(payload, "products");
    return payload;
  }

  async function getProducts(input = {}) {
    const ids = encodedIdentifiers(input.productIds, "productIds");
    const payload = responseObject(
      await request({ path: `${squarespaceExtensionConfig.api.paths.products}/${ids}` })
    );
    responseArray(payload, "products");
    return payload;
  }

  async function getProduct(input = {}) {
    const payload = await getProducts({ productIds: [input.productId] });
    return payload.products[0] ?? null;
  }

  function listAllProducts(input = {}) {
    const filters = { ...input };
    delete filters.maxPages;
    return paginate((cursor) => listProducts(cursor ? { cursor } : filters), "products", input.maxPages);
  }

  async function listInventory(input = {}) {
    const payload = responseObject(
      await request({ path: squarespaceExtensionConfig.api.paths.inventory, query: { cursor: cursorValue(input.cursor) } })
    );
    responseArray(payload, "inventory");
    return payload;
  }

  async function getInventory(input = {}) {
    const ids = encodedIdentifiers(input.variantIds, "variantIds");
    const payload = responseObject(
      await request({ path: `${squarespaceExtensionConfig.api.paths.inventory}/${ids}` })
    );
    responseArray(payload, "inventory");
    return payload;
  }

  async function getInventoryForVariant(input = {}) {
    const payload = await getInventory({ variantIds: [input.variantId] });
    return payload.inventory[0] ?? null;
  }

  function listAllInventory(input = {}) {
    return paginate((cursor) => listInventory({ cursor }), "inventory", input.maxPages);
  }

  function readVariantStock(item) {
    const inventoryItem = plainObject(item, "inventoryItem");
    return Object.freeze({
      variantId: identifier(inventoryItem.variantId, "variantId"),
      isUnlimited: inventoryItem.isUnlimited === true,
      quantity: inventoryItem.isUnlimited === true ? null : Number.isFinite(inventoryItem.quantity) ? inventoryItem.quantity : null
    });
  }

  async function listOrders(input = {}) {
    const cursor = cursorValue(input.cursor);
    const dates = dateWindow(input);
    if (cursor && dates.modifiedAfter) {
      fail("cursor cannot be combined with order date filters.", "SQUARESPACE_API_INVALID_REQUEST");
    }
    const payload = responseObject(
      await request({
        path: squarespaceExtensionConfig.api.paths.orders,
        query: {
          cursor,
          customerId: input.customerId === undefined ? undefined : identifier(input.customerId, "customerId"),
          modifiedAfter: dates.modifiedAfter,
          modifiedBefore: dates.modifiedBefore
        }
      })
    );
    responseArray(payload, "orders");
    return payload;
  }

  async function getOrder(input = {}) {
    const orderId = encodeURIComponent(identifier(input.orderId, "orderId"));
    return responseObject(await request({ path: `${squarespaceExtensionConfig.api.paths.orders}/${orderId}` }));
  }

  function listAllOrders(input = {}) {
    const filters = { ...input };
    delete filters.maxPages;
    return paginate((cursor) => listOrders(cursor ? { cursor } : filters), "orders", input.maxPages);
  }

  async function listTransactions(input = {}) {
    const cursor = cursorValue(input.cursor);
    const dates = dateWindow(input);
    if (cursor && dates.modifiedAfter) {
      fail("cursor cannot be combined with transaction date filters.", "SQUARESPACE_API_INVALID_REQUEST");
    }
    const payload = responseObject(
      await request({
        path: squarespaceExtensionConfig.api.paths.transactions,
        query: {
          cursor,
          orderId: input.orderId === undefined ? undefined : identifier(input.orderId, "orderId"),
          modifiedAfter: dates.modifiedAfter,
          modifiedBefore: dates.modifiedBefore
        }
      })
    );
    responseArray(payload, "documents");
    return payload;
  }

  async function getTransactionDocuments(input = {}) {
    const ids = encodedIdentifiers(input.documentIds, "documentIds");
    const payload = responseObject(
      await request({ path: `${squarespaceExtensionConfig.api.paths.transactions}/${ids}` })
    );
    responseArray(payload, "documents");
    return payload;
  }

  function getTransactionsForOrder(input = {}) {
    return listTransactions({ orderId: identifier(input.orderId, "orderId") });
  }

  function listAllTransactions(input = {}) {
    const filters = { ...input };
    delete filters.maxPages;
    return paginate((cursor) => listTransactions(cursor ? { cursor } : filters), "documents", input.maxPages);
  }

  async function listContacts(input = {}) {
    const pageSize = boundedInteger(input.pageSize, "pageSize", 50, 1, 1_000);
    const payload = responseObject(
      await request({
        path: squarespaceExtensionConfig.api.paths.contacts,
        query: { cursor: cursorValue(input.cursor), pageSize }
      })
    );
    responseArray(payload, "contacts");
    return payload;
  }

  async function queryContacts(input = {}) {
    const query = { ...plainObject(input.query, "query") };
    if (input.cursor !== undefined) query.cursor = cursorValue(input.cursor);
    if (query.pageSize !== undefined) query.pageSize = boundedInteger(query.pageSize, "pageSize", 50, 1, 1_000);
    const payload = responseObject(
      await request({
        path: squarespaceExtensionConfig.api.paths.contactQuery,
        method: "POST",
        body: query,
        retryableRead: true
      })
    );
    responseArray(payload, "contacts");
    return payload;
  }

  async function getContact(input = {}) {
    const contactId = encodeURIComponent(identifier(input.contactId, "contactId"));
    const payload = responseObject(
      await request({ path: `${squarespaceExtensionConfig.api.paths.contacts}/${contactId}` })
    );
    if (!payload.contact || typeof payload.contact !== "object" || Array.isArray(payload.contact)) {
      fail("Squarespace returned a malformed contact response.", "SQUARESPACE_API_MALFORMED_RESPONSE");
    }
    return payload.contact;
  }

  function readMarketingOptIn(contact) {
    const value = plainObject(contact, "contact").primaryEmail?.acceptsMarketing?.acceptsMarketing;
    return value === true;
  }

  function listAllContacts(input = {}) {
    return paginate(
      (cursor) => listContacts({ cursor, pageSize: input.pageSize }),
      "contacts",
      input.maxPages
    );
  }

  function queryAllContacts(input = {}) {
    return paginate(
      (cursor) => queryContacts({ query: input.query, cursor }),
      "contacts",
      input.maxPages
    );
  }

  async function getTransactionSummaries(input = {}) {
    const contactIds = Array.isArray(input.contactIds) ? input.contactIds : [];
    if (contactIds.length < 1 || contactIds.length > 1_000) {
      fail("contactIds must contain from 1 through 1000 identifiers.", "SQUARESPACE_API_INVALID_REQUEST");
    }
    const payload = responseObject(
      await request({
        path: squarespaceExtensionConfig.api.paths.analyticsTransactionSummaries,
        method: "POST",
        body: { contactIds: contactIds.map((value) => identifier(value, "contactId")), groupBy: "contactId" },
        retryableRead: true
      })
    );
    responseArray(payload, "transactionsSummaryWrappers");
    return payload;
  }

  async function listDiscounts(input = {}) {
    const offset = boundedInteger(input.offset, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = boundedInteger(input.limit, "limit", 50, 1, 1_000);
    const payload = responseObject(
      await request({
        path: squarespaceExtensionConfig.api.paths.discounts,
        query: {
          offset,
          limit,
          sortBy: enumValue(input.sortBy, DISCOUNT_SORT_FIELDS, "sortBy"),
          sortDirection: enumValue(input.sortDirection, SORT_DIRECTIONS, "sortDirection"),
          status: enumValue(input.status, DISCOUNT_STATUSES, "status"),
          search: input.search === undefined ? undefined : requiredText(input.search, "search"),
          limitedUseOnly: input.limitedUseOnly,
          criteria: input.criteria,
          template: input.template,
          trigger: input.trigger
        }
      })
    );
    responseArray(payload, "discounts");
    if (payload.hasNextPage !== undefined && typeof payload.hasNextPage !== "boolean") {
      fail("Squarespace returned malformed discount pagination.", "SQUARESPACE_API_MALFORMED_RESPONSE");
    }
    return payload;
  }

  async function getDiscount(input = {}) {
    const discountId = encodeURIComponent(identifier(input.discountId, "discountId"));
    const payload = responseObject(
      await request({ path: `${squarespaceExtensionConfig.api.paths.discounts}/${discountId}` })
    );
    if (!payload.discount || typeof payload.discount !== "object" || Array.isArray(payload.discount)) {
      fail("Squarespace returned a malformed discount response.", "SQUARESPACE_API_MALFORMED_RESPONSE");
    }
    return payload.discount;
  }

  async function listAllDiscounts(input = {}) {
    const maxPages = boundedInteger(input.maxPages, "maxPages", defaultMaxPages, 1, 1_000);
    const limit = boundedInteger(input.limit, "limit", 50, 1, 1_000);
    const items = [];
    let offset = boundedInteger(input.offset, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
    const filters = { ...input };
    delete filters.maxPages;
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      const page = await listDiscounts({ ...filters, offset, limit });
      items.push(...page.discounts);
      if (page.hasNextPage !== true) return Object.freeze({ items, pages: pageNumber, truncated: false });
      if (page.discounts.length === 0) {
        fail("Squarespace returned an empty discount page with hasNextPage=true.", "SQUARESPACE_API_CURSOR_LOOP");
      }
      offset += page.discounts.length;
    }
    return Object.freeze({ items, pages: maxPages, truncated: true });
  }

  return Object.freeze({
    getAuthenticatedMember,
    getAuthenticatedWebsite,
    listStorePages,
    listAllStorePages,
    listProducts,
    getProducts,
    getProduct,
    listAllProducts,
    listInventory,
    getInventory,
    getInventoryForVariant,
    listAllInventory,
    readVariantStock,
    listOrders,
    getOrder,
    listAllOrders,
    listTransactions,
    getTransactionDocuments,
    getTransactionsForOrder,
    listAllTransactions,
    listContacts,
    queryContacts,
    getContact,
    readMarketingOptIn,
    listAllContacts,
    queryAllContacts,
    getTransactionSummaries,
    listDiscounts,
    getDiscount,
    listAllDiscounts
  });
}
