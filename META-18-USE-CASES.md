# Social Cues Meta 18-Use-Case Map

This tracks the broad Meta app capabilities as Social Cues modules. It separates what is already wired from what needs token exchange, app review, or policy review.

Status endpoint:

```text
http://127.0.0.1:4177/api/meta/use-cases
```

## Core And Publishing

1. OAuth login and account consent
2. Facebook Page connection
3. Facebook Page publishing
4. Facebook Page analytics
5. Instagram professional account connection
6. Instagram content publishing
7. Instagram analytics
8. Threads account connection
9. Threads publishing
10. Threads insights

## Growth, Ads, Business

11. Ads reporting
12. Ads campaign management
13. Business asset management
14. Lead ads intake
15. Webhooks and event intake
16. Fundraising workflows
17. Commerce attribution signals
18. App review evidence and permission governance

## Current Social Cues State

Ready now:

- Local `.env` can hold Meta and Threads app credentials.
- OAuth start/callback routes exist for Meta and Threads.
- Social Cues can detect configuration status.
- Social Cues Queue exists as the scheduling layer.

Next backend work:

- Exchange OAuth codes for access tokens.
- Encrypt and store tokens server-side.
- Store connected Page, Instagram, and Threads account IDs.
- Create platform adapters from Social Cues Queue to Meta/Threads publishing endpoints.
- Add webhooks and app-review evidence screens.

## Policy Notes

Fundraising, ads management, and business asset controls should be gated behind explicit user approval, app review, and production security. They should not auto-run inside alpha.
