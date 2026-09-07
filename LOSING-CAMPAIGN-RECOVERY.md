# Losing Campaign Recovery (P12-R1)

P12-R1 corrects frontend save coordination in the P12 workflow on the unchanged P11 local conditional-save
boundary. It does not merge losing changes into the winner.

## Operator Flow

From the paused-save banner choose **Review losing campaign**. Select one retained
campaign and compare its text with the current saved source campaign. Preview,
download, refresh and cancel do not save. **Create new draft** copies exactly one
selected campaign and opens its ordinary editor only after confirmation.

The controller reads current authenticated `/api/model`, captures its revision,
and sends the normal P11 `model-save` envelope with one new campaign prepended.
The original campaigns/proof and unrelated state come from that fresh review.
A changed revision rejects; another explicit review and confirmation is required.
An unknown creation preserves the exact operation/request for **Retry original
creation**, not a new operation.

Review, confirmation and opening an existing copy join the normal save queue and
wait for direct conditional sends already in flight. They recheck context and
unresolved pending ownership after waits. A different unknown/unavailable normal
save cannot be cleared or bypassed: close the review, retry that original save,
then explicitly review again. No copy request is sent in the meantime. An already
acknowledged normal save invalidates an older preview rather than silently rebasing.
Only the matching confirmed operation's pending record is cleared; a different
known-rejected record remains retained in memory. Changing files is unavailable until reconciled.

New campaign and variant IDs derive from a fresh copy-intent UUID. Reusing the
same downloaded intent after reload detects the saved campaign ID and offers
**Open existing draft**, without a write. This avoids accidental duplicate
creation; it does not promise durable pending-request recovery after browser exit.

## Versioned Content-Only File

Exact top-level fields:

```text
schemaVersion = social-cues.losing-campaign.v1
workspaceScope = SHA-256 of schema and current user/workspace context
copyId = fresh UUID v4
sourceCampaignId = bounded source ID
campaign = supported text projection
```

Campaign fields are exactly `title`, `brief`, `goal`, `tone`, `disclosure`,
`riskPosture`, `destinationUrl`, `destinationCta`, and `variants`.
Each variant contains only `platform` and `copy`.
Each text field is at most 100,000 characters; at most 200 variants; formatted
UTF-8 file at most 2 MB. Platform/source IDs are bounded. A nonblank destination
must be HTTP/S without username/password. Text is rendered inertly with
`textContent`, never restored as executable form state.

The reader rejects unsupported version, extra fields, malformed values,
wrong workspace scope and raw model/form wrappers. No new aliases or legacy raw
backup import are supported.

Copy construction adds fresh IDs/timestamps, appends `(recovered draft)` to the
title, and sets all variants to `draft` with empty tags/flags. It excludes media,
proof, evidence snapshots, approvals, schedules, dispatch/delivery records,
credentials, and account/provider/billing state. The saved original retains its
manual facts, observed zero and immutable snapshot unchanged. Text itself is
not reclassified as verified evidence.

## Security And Continuity Limits

The scope fingerprint is provenance/context binding for accidental mix-ups, not
a secret, signature, encryption, or substitute for server authorization. Files
remain private editable business text. Deliberate edits to a file are not
cryptographically detectable.

The retained content and pending operation live in page memory only; no private
localStorage/sessionStorage journal is added. Unsubmitted editor fields are not
included. Export supported text before an ordinary reload, and reconcile unknown
outcomes before leaving the page. Hosted/non-conditional workspaces are unavailable.

[Current operator pilot](C:/Users/barto/Documents/Codex/social-cues-app-losing-campaign-p12-r1-20260906-204712/PILOT-HANDOFF.md)
[Release gates](C:/Users/barto/Documents/Codex/social-cues-app-losing-campaign-p12-r1-20260906-204712/RELEASE-READINESS.md)

## Focused Verification

```powershell
node --test losing-campaign-save-coordination.test.mjs losing-campaign.contract.test.mjs content-recovery.contract.test.mjs evidence-draft.contract.test.mjs manual-proof.contract.test.mjs posting-pack.contract.test.mjs
node losing-campaign.browser.test.mjs
node concurrent-recovery.browser.test.mjs
node content-recovery.browser.test.mjs
node local-pilot.browser.test.mjs
npm.cmd run test:pricing-presentation
node --check losing-campaign.contract.test.mjs
node --check losing-campaign.browser.test.mjs
node --check losing-campaign-save-coordination.test.mjs
git diff --check
```

Real tests use fresh task-owned synthetic pilots and zero external dispatch.
The P12-R1 response-loss injections suppress actual successful creation and normal
save responses, with a deliberate delay during both copy-preview phases.
Application routes are not mocked. The separate content-recovery browser suite
is mocked and reported separately. R4 remains HOLD.
