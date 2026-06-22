# Social Cues Meta Integration Status

Last verified: 2026-06-20

## Working Now

- Meta OAuth identity is connected.
- The connected Meta token is valid for the configured app.
- Token material is stored server-side and public endpoints expose only `tokenStored` booleans.
- `/api/meta/health` returns token health as `tokenHealth`, not as a raw `token` field.
- `/api/model` and `/api/export` do not expose raw token fields or OAuth state.
- Meta data deletion clears Meta/Facebook/Instagram token material.
- Meta webhooks reject unsigned payloads.
- UI Accounts view shows only the Meta identity as connected.
- UI Integrations view shows live blockers instead of pretending Page/Instagram readiness.
- Graph API Explorer is on the Social Cues app and confirms `/me/accounts?fields=id,name,tasks,instagram_business_account{id,username,name}` returns an empty `data` array with the current user token.
- The Social Cues UI now restores the original MVP-style platform rule surface inside the server-connected app: TikTok, Instagram, Threads, YouTube, Facebook, X, and Shopify all render rules and generated-copy lanes.
- The open launcher now points users to the server-connected app first. The direct HTML file is marked as offline drafting only.
- Meta oEmbed Read is added as use case 19 for front-end previews of public Facebook and Instagram pages, posts, and videos.
- `/api/meta/oembed` now exposes readiness, supported public embed kinds, and validated public-URL embed reads through Meta.
- Meta Basic settings now show `arbkgucejiovqakwvibw.supabase.co` in App Domains, matching the configured privacy and data-deletion callback host.
- A Social Cues Terms of Service route now exists at `/terms` and is included in the Meta review pack as `${META_PUBLIC_APP_URL}/terms`.
- Meta's oEmbed customize page shows Meta oEmbed Read as `Ready for testing`; Threads oEmbed Read is available with an `Add` action but has not been enabled from the dashboard yet.
- Access Token Debugger confirms the current token is a valid Social Cues user token with `pages_show_list`, `pages_read_engagement`, and `public_profile`; granular scopes apply to all objects.
- Graph API Explorer confirms `/me/permissions` returns those three permissions as `granted`.
- Graph API Explorer confirms `/me/businesses` is blocked by missing permission until Social Cues reauthorizes with `business_management`.
- App Roles confirms Cory Barton is an Administrator, so development-mode app role access is not the blocker.
- ChatGPT and Claude review agreed the next checks are Page access in Business Suite, `/me/businesses` with `business_management`, and a full remove/re-authorize flow if the Page picker was skipped.
- User confirmed this is not a Business Page path; the default Meta login no longer requests `business_management`.
- Social Cues now exposes `/api/meta/diagnostic-agent` so the app can state the Page-vs-profile blocker, oEmbed fallback, and paid infrastructure needs without repeating the same dead end.
- Meta Sharing Debugger was used on the public privacy URL and returned a concrete hosting issue: HTTP `400` plus old bridge Open Graph metadata.
- Replacement Supabase Edge Function source now exists locally at `supabase/functions/meta-oauth-callback/index.ts`, but deployment is not complete because the Supabase connector returned a tool/resource mismatch and the Supabase CLI is not installed.

## Blocked By Meta State

- Facebook Page asset discovery: Meta Graph returned zero Pages from `/me/accounts`.
- Instagram professional asset discovery: no linked Instagram professional asset was returned.
- The next likely Meta-side action is Page/account selection or Page admin verification during reauthorization, because the token is valid and has Page read permissions but Meta still returns zero Page assets.
- If there is no Facebook Page, code cannot make a personal profile appear in `/me/accounts`; the next product action is creating/connecting a Page or using oEmbed/profile-preview fallback features.
- Public Supabase Edge Function deployment is blocked until the connector/CLI deploy path works.
- Facebook publishing remains blocked until a real Page asset and `pages_manage_posts` are available.
- Facebook Page analytics remains blocked until a real Page asset is available.
- Instagram analytics/publishing remain blocked until a professional Instagram asset and required permissions are available.
- Threads remains blocked until HTTPS callback, Threads app credentials, token exchange, and Threads permissions are verified.

## Do Not Claim

- Do not claim Facebook Page connection until `/api/meta/pages` returns a real connected Page asset.
- Do not claim Instagram connection until `/api/meta/instagram/accounts` returns a real connected professional account.
- Do not claim analytics are live when the metric source is manual baseline input.
- Do not claim the app is fully production-ready until the user-visible server process is running the corrected backend.
- Do not use the direct standalone HTML file to judge Meta integration; it cannot perform OAuth callbacks or read live provider APIs.
- Do not treat oEmbed Read as account analytics or publishing. It is for public front-end embeds/metadata only.
- Do not put a Terms URL into Meta Basic settings until the public Supabase `/terms` path is verified reachable from a normal browser/network. Chrome reported `ERR_BLOCKED_BY_CLIENT` and direct workspace fetch could not verify the Supabase function URL.

## Verification Commands

```powershell
cmd /c npm test
```

```powershell
@'
process.env.PORT = '4181';
process.env.HOST = '127.0.0.1';
await import('./server.mjs');
await new Promise(resolve => setTimeout(resolve, 900));
const health = await fetch('http://127.0.0.1:4181/api/meta/health', { method: 'POST' }).then(r => r.json());
console.log(JSON.stringify({
  ok: health.ok,
  accounts: health.accounts?.map(a => ({ platform: a.platform, connected: a.connected, tokenStored: a.tokenStored })),
  blockers: health.health?.blockers || []
}, null, 2));
process.exit(0);
'@ | node --input-type=module -
```
