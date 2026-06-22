# Social Cues Meta Developer Setup

Use the logged-in Meta for Developers account to prepare Facebook Page and Instagram connection.

## Local Social Cues Values

Local app URL:

```text
http://127.0.0.1:4177
```

OAuth redirect URI:

```text
http://127.0.0.1:4177/api/oauth/meta/callback
```

Social Cues status check:

```text
http://127.0.0.1:4177/api/oauth/meta/status
```

## Add To `.env`

```text
PUBLIC_APP_URL=http://127.0.0.1:4177
META_APP_ID=
META_APP_SECRET=
META_API_VERSION=v23.0
```

Do not put `META_APP_SECRET` in browser code or chat.

## Meta App Setup

1. Create or open the Social Cues app in Meta for Developers.
2. Add Facebook Login / OAuth.
3. Add the redirect URI above as a valid OAuth redirect URI.
4. Add Instagram Graph API / Instagram product if available in the app dashboard.
5. Add or prepare these permission scopes for development/app review:
   - `pages_show_list`
   - `pages_read_engagement`
   - `pages_manage_posts`
   - `instagram_basic`
   - `instagram_content_publish`
6. Put the App ID and App Secret into `.env`.
7. Restart the Social Cues local server.
8. In Social Cues Accounts, click Connect on Instagram or Facebook Page.

## Current Backend State

Social Cues can now start the Meta OAuth redirect and receive the callback. The callback records that Meta returned an authorization code. The next production step is token exchange, encrypted token storage, page/account selection, and post publishing through the Social Cues Queue.
