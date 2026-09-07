# Campaign Content Recovery

P11 local revisioned saves extend the P8 supported-content contract.
See [Local Revisioned Persistence](LOCAL-REVISIONED-PERSISTENCE.md) for storage,
writer coverage, current verification and release limits.
This is supported-content recovery, not account, infrastructure or media recovery.
All files remain private business data. Do not publish raw model dumps.

## Settings Controls

1. **Export recovery content** downloads a versioned
   `Social-Cues-campaign-content.json` file. Keep a copy of current content before
   any replacement. The export refuses content it cannot validate.
2. **Review recovery file** reads a local JSON file without submitting it. The
   preview identifies campaign/variant/evidence counts, recorded statuses, IDs,
   replacement counts and exclusions. Review all of it.
3. **Cancel** or Escape closes the preview without saving or changing current data.
   Invalid files cannot be applied. The limit is 5 MB and 2,000 entries per array.
4. **Replace supported content** requires a signed-in workspace with a server-issued
   revision and conditional-save capability. The operation is bound to the revision
   reviewed in the preview. No publishing or provider action is requested.
5. Success requires the acknowledged operation and expected projected content.
   A stale revision retains the draft, stops queued saves and loads current content
   separately. **Review current content** rebuilds the preview from the retained
   file; a second deliberate confirmation is required to replace it.
6. An uncertain response may already have committed. **Retry original save** sends
   the exact original operation ID, revision and request. A superseded receipt is
   historical evidence, never the original content represented as current. Export
   the retained draft before closing the page; it is an in-memory recovery aid.

Tab reaches the explicit apply/cancel controls; the preview is scrollable on
mobile. A workspace change invalidates the preview. A late response cannot restore
the previous workspace's content into a new browser workspace.

**Export private full model** still exports the model, including account and
operational information. Synthetic tests positively demonstrate this. Its values
are not safe for public sharing. **Export content bundle (JSON)** still exports one
active campaign and proof; it is explicitly rejected as a workspace recovery file.

## Exact Supported Data

Accepted input: `schemaVersion: social-cues.campaign-content.v1` with a `content`
object, or a model with exactly `version: 0.2.0-local` or
`version: 0.3.0-client-workspace`. The latter is the current committed server
workspace version. Other versions are rejected, not guessed.

Only these root fields are replaced: `campaigns`, `proof`, `activeCampaignId`.
The active ID must resolve, or be empty when campaigns are empty.

| Record | Supported fields |
| --- | --- |
| Campaign | `id`, `title`, `brief`, `goal`, `tone`, `disclosure`, `riskPosture`, `destinationUrl`, `destinationCta`, `createdAt`, `updatedAt`, `variants`, `evidenceSnapshot`, `recoveryRecordedAt` |
| Variant strings | `id`, `campaignId`, `platform`, `status`, `copy`, `bestTime`, `fit`, `language`, `locale`, `disclosure`, `contentApproach`, `connector`, `rationale`, `mediaDirection`, `generatedBy`, `createdAt`, `updatedAt`, `approvedAt`, `publishedAt`, `scheduledFor` |
| Variant arrays | String arrays `tags`, `flags`, `videoHashtags`; absent arrays become empty |
| Variant display metadata | `videoSpec`: `format`, `resolution`, `duration`, `outputName`, `safeArea`, `approach`; `destination`: `url`, `cta`, `placement` |
| Proof | `id`, `source`, `schemaVersion`, `type`, `campaignId`, `campaignTitle`, `variantId`, `platform`, `postedUrl`, `postedAt`, `postedTimezone`, `metric`, `metricValue`, `observedAt`, `observedTimezone`, `note`, `createdAt`, `updatedAt` |
| Frozen snapshot | Existing `social-cues.self-launch-evidence.v1`: `schemaVersion`, `source`, `capturedAt`, `sourceRecordIds`, `records` |
| Frozen record strings | `sourceRecordId`, `source`, `recordType`, `campaignId`, `variantId`, `platform`, `postedUrl`, `postedAt`, `postedTimezone`, `metric`, `metricValue`, `observedAt`, `observedTimezone`, `note`, `sourceUpdatedAt` |

IDs must be unique and associations must resolve. Manual proof uses the existing
manual validation, including explicit matching offsets, no future observations,
valid public post URLs, and numeric observation values. Numeric zero remains zero.
Legacy proof without source/schema is retained as legacy, including unassociated
entries; unknown provider-proof formats are not promoted into manual facts.
Frozen snapshots retain original captured facts even when the linked receipt has
later corrections. Their source records and original associations must resolve.

Supported variant statuses are `draft`, `needs revision`, `approved`,
`published`, `failed`, `blocked`. They remain recorded file history, not renewed
approval or independently verified provider delivery. The editor displays that
qualification; imported published variants receive qualified history text.
`recoveryRecordedAt` records content recovery and stays stable during retries.
Dates/scheduledFor are content history/planning, not scheduling commands.

## Exclusions And Conflicts

Every other root field stays as it was in the current model, including
`currentUser`, `workspace`, `workspaces`, auth/session material, memberships,
`security`, `billing`, `onboarding`, `profile`, `brandKit`, `baseline`,
`settings`, `integrations`, `connectedAccounts`, `activeProviderAccounts`,
`functionChecks`, `analytics`, `activity`, `actions`, `handoff`,
`quickPosts`, `publishQueue`, `mediaAssets` and `mediaRenderJobs`.
Unknown root fields are also ignored. Imported owner/user/workspace metadata,
provider receipts and unknown nested fields are not projected into content.

Queued, scheduled, retrying, processing, submitted and unknown variant statuses
are rejected. Nonempty dispatch confirmation/retry fields are rejected. Current
campaign dispatch state also blocks replacement. Existing queue, action or media
references to replaced campaign/variant IDs and quick-post ID collisions block
recovery. Nonoperational campaign-derived queue summaries are distinguished from
actual retained operational rows. Conflicts require separate operator resolution;
the importer never clears live state to make a file fit.

Variant `media`, `mediaEdit`, `videoUrl`, `imageUrl`, render outputs and provider
delivery receipts are excluded. Destination/post URLs and URLs already written in
copy or frozen facts are only references; JSON contains no uploaded file bytes,
storage ownership/permissions, render jobs or guarantee the referenced media still
exists. Import does not load media from a file. Reattach media separately through
an authorized workflow. Text itself may contain sensitive business information:
the allowlist does not make exports public or sanitize arbitrary private prose.

## Historical P8 Evidence

- [Pure contracts](C:/Users/barto/Documents/Codex/social-cues-app-content-recovery-p8-20260906-2225/content-recovery.contract.test.mjs): 9 tests; exact projection, versions, IDs, references, exclusions, statuses and syntax.
- [Browser matrix](C:/Users/barto/Documents/Codex/social-cues-app-content-recovery-p8-20260906-2225/test-results/content-recovery/evidence.json): 72 checks across Chromium/WebKit. Routes intercepted; rejected/lost/incomplete responses and context switch are synthetic, not real server failure proofs.
- [Real local pilot](C:/Users/barto/Documents/Codex/social-cues-app-content-recovery-p8-20260906-2225/test-results/local-pilot/1788734459674/evidence.json): 110 checks. Export, preview, cancel, invalid files, apply and actual restart are real browser/server paths. Two campaigns/two variants, manual and legacy proof, and a frozen snapshot survive. One recovery POST per profile, no provider/publishing action.

Legacy markers and simulated content loss are prepared using authenticated
synthetic model saves, not application-route mocks. Full-model downloads are
examined in memory for synthetic operational markers; no raw dumps are uploaded
or attached to reports. Only supported synthetic content is retained as evidence.
Existing exact synthetic Meta reads are intercepted by the unchanged pilot
guard; no real provider requests dispatch. This is not OS-level isolation.

P11 adds server-checked revisions and durable operation receipts to local storage.
The real two-context regression now proves intervening edits survive rejected
recovery, restart and explicit re-review. The historical evidence above is not a
claim about production. Hosted runtimes advertise `conditionalSave: false` and
cannot offer protected recovery. Account recovery, media recovery, hosted atomic
storage, live provider acceptance and retained-data rollout remain outside this
delivery. Windows power-loss durability remains qualified. R4 remains HOLD.
