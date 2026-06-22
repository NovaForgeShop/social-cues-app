# Social Cues Supabase Setup

This is the production data path for Social Cues. The local alpha still works without Supabase, but once these values are configured the backend will save the shared app model in Supabase instead of only on this computer.

## 1. Create the database tables

Done through Codex Supabase connector for project `arbkgucejiovqakwvibw`.

Applied migration:

```text
20260613005642_Social Cues_alpha_schema
```

## 2. Add server environment values

Copy `.env.example` to `.env` beside `server.mjs`, then fill in the service-role key from Supabase. The local server automatically reads this `.env` file when it starts.

```text
SUPABASE_URL=https://arbkgucejiovqakwvibw.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR-SERVER-ONLY-SERVICE-ROLE-KEY
SUPABASE_ENABLED=true
```

Supabase's newer server keys look like `sb_secret_...`. If you use one of those, put it in either `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_SECRET_KEY`; Social Cues will send it using the server-safe `apikey` header.

Do not place the service-role key in the Social Cues browser file or any other client-side file.

## 3. Test the connection

Start Social Cues and open:

```text
http://127.0.0.1:4177/api/supabase/status
```

If Supabase is connected, `configured` will be `true` and `persistence.driver` will be `supabase` after the app reads or saves data.

## 4. What this unlocks

- Same workspace data across desktop and phone.
- A real path to hosted login, billing, and account records.
- Safer future storage for social-account connections and media records.

The current implementation stores one shared alpha model in `app_state`. The schema also includes normalized tables for the next step: real multi-user workspaces, campaigns, social accounts, media assets, action items, and billing customers.
