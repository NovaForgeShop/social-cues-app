# Manual Pilot Results

Open **Results** from **Plan and delivery**, the sidebar, or the mobile view menu.
This is an operator-maintained record, not a provider-verification result.

## Record A Post

1. Post manually only after checking the real queue for duplicate delivery.
2. Check the campaign and select its variant. Plan preselects the active campaign
   for a new, untouched receipt; you can change it. Drafts and edited receipts keep
   their association when returning from Plan. The platform comes from the variant.
3. Enter the actual HTTPS post URL and posting date/time.
4. Select the UTC offset that applied at posting, including daylight-saving time.
5. Leave **Observed result (optional)** collapsed when results are unknown.
   The optional operator note is available without opening the disclosure.
6. Select **Save receipt** and wait for the saved confirmation.

Recording evidence does not approve, queue, publish, connect accounts or fetch
metrics. It does not change the variant's delivery status. The existing model.proof
and saveModel flow persist the receipt; existing JSON exports retain it.

## Add Or Correct Results

Use **Edit receipt** to correct its association, URL, time, note or observation.
Open **Observed result (optional)** to add a measurement. It opens automatically
when editing a measured result, including zero, or when its fields fail validation.
An observed result requires all four: metric/unit, numeric value, measurement time
and measurement UTC offset. Zero is a valid measured value; blank is unknown.
Dates must be valid and in the past, with measurement no earlier than posting.
Collapsing the disclosure preserves all entered values; it does not clear a result.
Use **Clear observation** to empty all four measurement fields, then save the
correction to return to a posting receipt. Clearing leaves association, posting
facts and note intact; stored evidence is unchanged until save succeeds.
**New receipt** clears the form and collapses observations, including all timezone
and metric values. URL, posting time and historical UTC offset are always deliberate
operator inputs, never inferred from the active campaign.

A failed save keeps the entered form data and offers retry. A new receipt retains
its identity across retries in the current form, including hidden observation
values or an explicitly cleared observation. A lost response is not proof that
the server rejected the save; reload to review stored evidence if uncertain.
Unsaved drafts are not persisted and are cleared when the workspace changes.

Legacy evidence remains visible and unchanged. Unassociated legacy entries are
labelled as such; this form neither guesses associations nor edits legacy records.
New manual entries cannot satisfy the frontend's Facebook provider-proof shortcut.
Actual provider evidence is retained.

## Create An Evidence-Based Draft

1. In **Recorded evidence**, select **Use in self-launch draft** on the saved
   manual receipts/results you intend to use. Selection may span campaigns only
   when you explicitly choose their records. Legacy notes are not selectable.
2. Select **Preview selected evidence**. Review the exact draft text, source IDs,
   recorded URLs/platforms/times, snapshot time and draft platforms.
3. Select **Create editable draft** once and wait for saved confirmation.
4. Select **Edit created draft** to use the existing campaign editor and review path.

The initial campaign brief and every new variant contain the preview text.
All variants are drafts. Creation does not change evidence, approve or queue
content, fetch results, connect a provider, or request AI-generated copy.
Manual observations are not independently verified or evidence of product impact.
Operator notes are quoted as unverified. A receipt without a complete observation
says **Performance: unreported**; a measured zero remains zero.

The campaign stores the selected source record IDs and a detached factual snapshot.
Correcting a source receipt later does not rewrite the preview or existing campaign.
Refresh the preview before first creation to use a correction, or deliberately
change the selection to begin a new draft. Editing the campaign does not alter its
original evidence snapshot. The existing editor normalizes brief whitespace on save.

In the Campaign editor, expand **Saved evidence snapshot** below Brief to inspect
the persisted capture after reload or server restart. This is separate from the
transient Results preview. Capture time, source IDs and manual facts are text only;
recorded URLs are not visited. Enter/Space toggles the native disclosure and Tab
reaches the text. Opening/closing preserves unfinished title/brief input and makes
no save or request. Selecting a different campaign retains its existing save
behavior. Ordinary campaigns say no saved snapshot; malformed/unsupported
snapshots show unavailable without claiming valid evidence or changing storage.

If saving is not confirmed, selection and snapshot stay fixed and **Retry saving
draft** reuses the same campaign and variant IDs in that form. A lost response can
mean the server already saved the draft. Pending form state is not persisted across
reload: inspect saved campaigns before starting another draft. Workspace changes
clear the selection and pending identity. Keyboard users can select checkboxes with
Space, activate Preview with Enter, and Tab from the focused preview to Create.

## Pilot Review

Keep the posting pack and actual URL/time receipt together. At the agreed observation
window, enter the measured result with its unit and measurement time. CSV receipt
import is an explicit reviewed action described below, not automatic collection.
No links are verified, metrics fetched or provider publishing added.

## Review A Manual CSV

In Results, **CSV template** downloads a header-only UTF-8 file. Select a campaign
and variant in the ordinary receipt form to inspect their exact IDs above the form.
The importer never substitutes those selections for missing CSV associations.
Use only IDs belonging to the current signed-in workspace. Columns, in order:

```text
campaignId,variantId,postedUrl,postedLocal,postedTimezone,metric,metricValue,observedLocal,observedTimezone,note
```

Every row has ten cells. The first five are required: an existing campaign and its
variant, a safe HTTPS post URL, a valid past local posting date/time and explicit
UTC offset (`+00:00`, `-04:00`, etc.). Local date/time format is
`YYYY-MM-DDTHH:mm`, with optional seconds and milliseconds. Platform is derived
from that variant. The next four observation cells are all blank, or all complete:
metric/unit, finite numeric value, past local measurement time and its offset.
Measurement cannot precede posting. Zero is measured; blank is unknown. Note is
optional. Existing manual-entry limits apply: URL/note 2000 characters, metric
120 and numeric text 80. Offsets range from -14:00 to +14:00.

The parser accepts BOM, CRLF/LF, quoted commas/newlines and escaped double quotes.
It does not evaluate formulas, HTML or cell text. Files are limited to 1 MiB UTF-8,
200 nonblank data records and 4000 characters per cell. Unknown/reordered headers
and malformed quoting reject the file. Rows with the wrong width (up to the
twenty-cell parser limit) are shown invalid; greater widths reject the file.
There is no automatic column mapping or ZIP/XLSX support.

1. Choose **Review CSV** and select the file. The review loads current saved content.
2. Inspect every row's exact cells, association, validation errors and duplicate
   status. No rows are selected automatically. Invalid/unmapped and exact duplicate
   rows cannot be selected.
3. Select a valid subset, then **Import selected**. Only those records are appended.
   Existing proof, campaigns, approvals, queue state and frozen snapshots are retained.
4. Wait for confirmation. Imported records remain manual/operator-supplied and not
   provider-verified. Use their ordinary **Edit receipt** action for corrections,
   or explicitly select them for an evidence preview. Import never creates a draft.

Duplicate detection compares validated manual facts: type, campaign/variant/platform,
URL, posting time/offset, observation fields and note. IDs, record timestamps and
campaign titles are excluded; whitespace edges and CRLF are normalized. This is
exact fact comparison, not fuzzy matching: equivalent numeric spellings or time
spellings need not match. The first valid in-file record wins; later exact copies
are disabled. Existing manual records are also excluded after reload/restart.
Correcting a saved record can make its previous CSV facts distinct again. Review
the full list before import; no claim of universal semantic deduplication is made.

Cancel/Escape close without saving; **Resume CSV review** retains the parsed input
in the live page. A changed saved revision requires **Review latest saved** and
deliberate confirmation again. A different unresolved save must first be reconciled
using the original-save notice. CSV review cannot clear or replace it.
An uncertain import offers **Retry original import**, resending only its identical
operation/request and stable record IDs. Closing that review does not cancel a
possibly committed import. Keep the page open until reconciled; there is no durable
browser operation journal. After reload inspect saved evidence and re-review the
file, rather than assuming an earlier request failed. CSV input is not retained
across browser reload. A workspace-context change hides the old review and prevents
confirmation; return to that workspace and inspect its saved state.

Confirmed import requires authenticated local conditional-save capability. It is
disabled where that capability is absent; this does not enable hosted persistence.
No receipt URL is visited, metrics fetched or external provider request dispatched.
On mobile the rows scroll separately from the actions; Space toggles a focused
checkbox, Tab reaches actions and Escape cancels when no save is in progress.

## Export Reviewed Manual Receipts

Use **Export receipts CSV** in Results to create a deliberately selected, compatible
copy of current saved manual receipts/results. Opening the review waits for earlier
saves, then loads the authenticated workspace's saved model. A different unresolved
save blocks review until its original operation is reconciled. Read-only export does
not require conditional-save capability and does not create a save operation.

The review shows every eligible record's campaign ID, variant ID, derived platform,
posting URL/local time/offset, optional metric/value/local time/offset, note and
manual/not-provider-verified status. Nothing is selected automatically. Select only
the records intended for the file, then choose **Download reviewed snapshot**.
Cancel or Escape closes without writing. Download does not edit evidence, mark it
verified, change campaigns or snapshots, approve/queue/publish content, fetch metrics,
visit recorded URLs, connect providers or change account/billing state.

Eligibility is limited to valid current-workspace manual records that round-trip
exactly through the ten-column import contract. Provider-derived and legacy evidence,
manual records without a current campaign/variant association, invalid facts and
non-roundtripping records are excluded. The dialog shows reason counts but not the
excluded records' contents. Record IDs, timestamps, account/provider/billing data,
approval and queue state, media, private model fields and frozen snapshots are never
CSV columns.

App-generated files begin with the exact single-cell marker:

```text
social-cues-manual-receipts-export.v1
```

The next row is the existing ten-column header in the same order. Values are quoted
as CSV and preserve embedded commas, quotes, normalized newlines, explicit offsets,
blank unknown results and measured zero. Formula-leading values (`=`, `+`, `-` or
`@`, including after ordinary whitespace) and the reserved escape family are prefixed
with the exact versioned literal marker `'social-cues-literal.v1:`. The importer
removes one prefix only inside a correctly marked app file and only when the decoded
value requires that protection. Malformed/unsupported markers, malformed escapes and
unescaped formula-leading marked cells reject. Unmarked external CSV behavior is
unchanged. The header-only **CSV template** remains unmarked.

The status names the reviewed saved revision and time. It deliberately calls the
file a reviewed snapshot, not the latest workspace state. Use **Review latest saved**
before download to check for changes made by another client; an explicit refresh
reprojects the current saved model and retains only still-eligible selections.
Workspace-context changes hide the old rows and disable download.

## Repeatable Checks

- node --test manual-proof.contract.test.mjs
- node --test manual-receipt-csv.contract.test.mjs
- node --test manual-receipt-csv-export.contract.test.mjs
- node manual-receipt-csv.browser.test.mjs
- node manual-receipt-csv-export.browser.test.mjs
- node manual-proof.browser.test.mjs
- node --test evidence-draft.contract.test.mjs
- node evidence-draft.browser.test.mjs
- node --test posting-pack.contract.test.mjs
- node posting-pack.browser.test.mjs
- npm.cmd run test:pricing-presentation

The original manual/evidence/posting browser checks use cached Playwright and synthetic request interception; no provider
or real application server is contacted. They prove frontend persistence behavior
against a fixture implementing the existing model save/load contract, not production
storage or authorization. Samples, screenshots and evidence are written to ignored
test-results/manual-proof/, test-results/evidence-draft/ and test-results/posting-pack/.

The separate **node scripts/run-local-pilot.mjs --rehearse** check uses the real
existing local server and proves JSON persistence across process restart.
See LOCAL-PILOT.md for synthetic-only launch/resume/stop instructions.

The P13 CSV browser check instead uses actual local signup, session and conditional
model routes with fresh task-owned synthetic data. It labels response-loss/queue
ordering and in-page context/capability seams separately, exercises another real
workspace and process restart, and blocks all nonlocal browser traffic. Evidence
and screenshots are written under `.tmp/p13-browser-*`; its pilot data is retained
only in that worktree. It is not hosted, provider-delivery or production proof.

The P14 export browser check uses the same real local boundary with fresh accounts,
Chromium desktop and WebKit mobile. It proves default-none/subset review, versioned
formula-safe download, exact re-import as duplicates, explicit refresh after another
client's save, workspace isolation, unknown-save reconciliation, failed-review
confirmation, restart persistence, inert cell text and zero provider activity.
Canonical evidence is `.tmp/p14-browser-1788747625333/evidence.json`; the stopped
retained pilot is `.tmp/local-pilot-YM8Yll`. These remain local synthetic evidence,
not hosted storage, production, provider delivery or spreadsheet-application proof.
