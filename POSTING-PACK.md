# Manual Posting Pack

Select a campaign, open **Calendar / Plan and delivery**, and use **Export Markdown**
or **Export CSV calendar** under **Manual posting pack**. Each action downloads one
file. The content-bundle JSON backup remains available in the data/export controls.

The export includes only the active campaign's variants with status **approved** or
**queued**. It does not include drafts, published items, quick posts, standalone
queue records, other campaigns, workspace objects, account objects or credentials.
It does not generate copy, change state, post content or fetch media.

- Markdown contains exact copy blocks, media references and an operator checklist.
- CSV contains one row per post, preserving quoted multiline copy.
- Recorded schedule offsets are converted to UTC; original timezone names are not
  stored by the campaign editor. Unzoned times say **Not recorded**.
- Missing/invalid schedules say **Not scheduled**. Empty exports have no post rows.
- Public HTTPS media links without queries, fragments, embedded credentials or
  known private/local paths are eligible. Operator filenames are retained where
  safe. This is not a remote accessibility check. Reattach omitted assets manually.
- Formula-like spreadsheet cells receive a leading apostrophe. Use Markdown for
  exact copy if your CSV application displays that protective prefix.

Before manual delivery, check the real queue to avoid duplicates. Coordinate live
queue changes separately; export does not pause or cancel queued delivery.
After posting, fill **posted_url**, **actual_posted_at**, **performance_observed_at**,
and **actual_performance** with real observations. Unknown results remain blank.

Open **Results** from Plan and delivery to save a manual receipt. A new untouched
receipt preselects the active campaign; existing drafts and edits retain their
association. Check or change the campaign, select the variant, enter the real
post URL and posting time, and select the UTC
offset that applied at posting. The platform comes from the selected variant.
Use **Edit receipt** to correct it or later add a metric with its unit, numeric
value, measurement time and UTC offset under **Observed result (optional)**.
Leave that disclosure collapsed for a simple receipt. Collapse retains values;
**Clear observation** empties the measurement draft and requires saving to change
stored evidence. A measured zero is not blank.
The existing proof ledger stores these as manually recorded, not provider-verified.
Legacy entries remain visible without invented campaign associations. CSV files
are not imported automatically. Keep the completed calendar for the pilot review.

To prepare a subsequent self-launch draft, explicitly select saved manual records
in Results, preview their evidence, then create and edit the draft. Receipts alone
do not establish performance; missing results stay unreported. The saved campaign
keeps its source IDs and original factual snapshot after later receipt corrections.
Creation does not approve or queue variants. These drafts remain excluded from the
posting pack until they pass the existing operator review/approval path.

## Local Verification

Run **node --test posting-pack.contract.test.mjs**, then
**node posting-pack.browser.test.mjs**, and **npm.cmd run test:pricing-presentation**.
Browser checks require the already installed Playwright dependency and cached
Chromium/WebKit browsers. They use intercepted local fixtures, not a live service.
Samples, screenshots and detailed results go to ignored **test-results/posting-pack/**.
