# Social Cues Meta Connection Pack

This is the working handoff for connecting your existing Meta developer app to Social Cues.

## What Social Cues Needs From The Meta App

Add these values to `outputs/Social Cues-testable-app/.env`:

```text
PUBLIC_APP_URL=https://socialcuesapp.com
META_PUBLIC_APP_URL=https://socialcuesapp.com
BRAND_DOMAIN=socialcuesapp.com
BRAND_HOME_URL=https://socialcuesapp.com
SUPPORT_EMAIL=mr.barton@socialcuesapp.com
META_APP_ID=
META_APP_SECRET=
META_API_VERSION=v23.0
```

Keep `META_APP_SECRET` only in `.env` or hosting secrets. Do not paste it into chat or browser code.

## Redirect URIs To Add In Meta

Add these OAuth redirect URIs in the Meta developer dashboard:

```text
https://socialcuesapp.com/api/oauth/meta/callback
https://socialcuesapp.com/api/oauth/threads/callback
```

The production callbacks use the Vercel-hosted Social Cues domain because Facebook Login and Threads require HTTPS redirect targets.

## Basic Settings Security

In Meta App Settings > Basic, set App Domains to:

```text
socialcuesapp.com
```

Use only domains, with no `https://` and no path.

In Meta App Settings > Basic, set Privacy Policy URL to:

```text
https://socialcuesapp.com/privacy
```

In Meta App Settings > Basic, set Terms of Service URL to:

```text
https://socialcuesapp.com/terms
```

Set the contact email to:

```text
mr.barton@socialcuesapp.com
```

In Meta App Settings > Basic, set User Data Deletion Callback URL to:

```text
https://socialcuesapp.com/api/meta/data-deletion
```

Social Cues verifies Meta's `signed_request`, records the deletion request, disconnects Meta-linked accounts, and returns Meta's required confirmation URL/code response.

## Local Status Checks

After editing `.env` and restarting Social Cues, open:

```text
http://127.0.0.1:4177/api/oauth/meta/status
http://127.0.0.1:4177/api/oauth/threads/status
http://127.0.0.1:4177/api/meta/data-deletion
```

Both should show `configured: true` once their app id and secret values are present.

## Current Login Test Permissions

For the first Facebook Login test, Social Cues requests only:

```text
public_profile
pages_show_list
pages_read_engagement
```

Meta rejected `email`, `pages_manage_posts`, `instagram_basic`, and `instagram_content_publish` for the current SCv2 login configuration. Keep those out of the initial OAuth request until the matching Meta products/use cases and review path are ready.

## Later Permissions To Prepare

For Facebook Page and Instagram publishing:

```text
pages_show_list
pages_read_engagement
pages_manage_posts
instagram_basic
instagram_content_publish
```

For Threads:

```text
threads_basic
threads_content_publish
threads_manage_insights
```

For ads later:

```text
ads_read
ads_management
business_management
```

For fundraising or donations, keep that as a later feature gate. It may require extra review, policy checks, and region-specific compliance.

## What To Click In Meta Dashboard

1. Open the existing Meta app.
2. Confirm the App ID and App Secret.
3. Add `Facebook Login` or OAuth login capability.
4. Add the Social Cues local redirect URI.
5. Add or configure Instagram Graph API / Instagram product.
6. Add or configure Threads API capability.
7. Keep the app in development mode while testing with your own account or test users.
8. Add required test users/roles if Meta blocks OAuth for non-admin accounts.
9. Later, prepare app review notes showing:
   - user connects accounts voluntarily,
   - Social Cues drafts and schedules approved content,
   - user controls publish approval,
   - tokens are stored server-side only,
   - users can disconnect accounts.

## Current Social Cues Backend State

Social Cues can:

- Detect whether Meta and Threads credentials are present.
- Start Meta OAuth for Instagram/Facebook.
- Start Threads OAuth.
- Receive OAuth callbacks.
- Mark accounts as ready for token exchange.

Next backend step:

- Exchange OAuth codes for access tokens.
- Encrypt and store tokens server-side.
- Store Facebook Page, Instagram business account, and Threads user ids.
- Connect those accounts to Social Cues Queue publishing jobs.
