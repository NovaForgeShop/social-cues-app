import { createSquarespaceApiClient } from "../squarespace-api-client.mjs";

const requiredFlags = new Set([
  "--allow-live-squarespace",
  "--confirm-read-only",
  "--founder-owned-test-site",
  "--oauth-callback-verified",
  "--confirm-no-production-customer-data"
]);
const suppliedFlags = new Set(process.argv.slice(2));
const missingFlags = [...requiredFlags].filter((flag) => !suppliedFlags.has(flag));

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || !value) throw new Error(`${name} is not configured.`);
  return value;
}

if (missingFlags.length) {
  console.error(
    JSON.stringify({
      ok: false,
      code: "SQUARESPACE_CANARY_NOT_AUTHORIZED",
      missingFlags
    })
  );
  process.exitCode = 1;
} else {
  try {
    requiredEnvironment("SQUARESPACE_CLIENT_ID");
    requiredEnvironment("SQUARESPACE_CLIENT_SECRET");
    const accessToken = requiredEnvironment("SQUARESPACE_CANARY_ACCESS_TOKEN");
    const binding = {
      workspaceId: requiredEnvironment("SQUARESPACE_CANARY_WORKSPACE_ID"),
      connectionId: requiredEnvironment("SQUARESPACE_CANARY_CONNECTION_ID"),
      websiteId: requiredEnvironment("SQUARESPACE_CANARY_WEBSITE_ID")
    };
    const client = createSquarespaceApiClient({
      accessToken,
      fetchImpl: fetch,
      binding,
      timeoutMs: 10_000,
      maxRetries: 1,
      maxRetryDelayMs: 1_000,
      maxPages: 1
    });

    await client.getAuthenticatedWebsite();
    const storePages = await client.listStorePages();
    const products = await client.listProducts();
    const inventory = await client.listInventory();
    const orders = await client.listOrders();
    const transactions = await client.listTransactions();
    const contacts = await client.listContacts({ pageSize: 50 });
    const discounts = await client.listDiscounts({ limit: 50 });
    const contactIds = contacts.contacts
      .map((contact) => contact?.id)
      .filter((contactId) => typeof contactId === "string" && contactId)
      .slice(0, 1_000);
    const analytics = contactIds.length
      ? await client.getTransactionSummaries({ contactIds })
      : { transactionsSummaryWrappers: [] };

    console.log(
      JSON.stringify({
        ok: true,
        provider: "squarespace",
        readOnly: true,
        counts: {
          storePages: storePages.storePages.length,
          products: products.products.length,
          inventoryItems: inventory.inventory.length,
          orders: orders.orders.length,
          transactionDocuments: transactions.documents.length,
          contacts: contacts.contacts.length,
          analyticsSummaries: analytics.transactionsSummaryWrappers.length,
          discounts: discounts.discounts.length
        }
      })
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        code: typeof error?.code === "string" ? error.code : "SQUARESPACE_CANARY_CONFIGURATION_ERROR",
        message: "The read-only Squarespace canary did not complete."
      })
    );
    process.exitCode = 1;
  }
}
