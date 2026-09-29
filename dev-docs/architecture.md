# Architecture

## Runtime and deployment

The application runs entirely in Google Apps Script V8. esbuild bundles TypeScript and `@telegraf/entity` into an IIFE with global wrappers for `doPost`, `setup`, `flushPending`, `webhookStatus`, and `recoverAdmin`. No Node runtime APIs or external modules are required. clasp uploads only the bundle and manifest from `dist`.

The build injects one project metadata object and emits a leading generated-file comment from it. `/start` and `/help` use that same object. Package metadata supplies name, description, and version; Git supplies the available HEAD revision. Repository URLs prefer package metadata, then Git origin, and are sanitized to exclude credentials, query parameters, fragments, and filesystem remotes. Missing Git details are omitted. Source-level tests use deterministic package-based defaults. The emitted revision identifies Git HEAD; uncommitted source changes are not represented by a separate revision.

The Web App executes as the deploying account and permits anonymous access. A generated secret query parameter authenticates requests before body parsing. Apps Script's documented event does not expose arbitrary request headers, so the bot does not depend on Telegram's secret header. The URL is a bearer credential and must stay out of logs. `doPost` returns `HtmlOutput` to avoid Content Service redirects. Developers can check acknowledgment behavior using a deployed bot and `webhookStatus`.

Configuration commands and callbacks require the authenticated sender to be an admin in a private chat. Authorization is rechecked before changes. Commands take arguments; buttons support paginated browsing and expiring, per-admin removal confirmations. There is no Mini App or browser UI.

`setup` seeds state only once, preserves the secret, registers explicit update subscriptions and commands, and recreates only the current account's `flushPending` triggers to ensure one minute-based trigger. Setup and deployment must use the same account. `recoverAdmin` is an editor-only recovery function, not a bot operation.

### Scheduling tradeoff

The recurring trigger is retained for implementation simplicity. It runs about 1,440 times per day and reads the pointer plus state chunks when idle: roughly 2,880 property reads per day for a one-chunk state. Idle flushes perform no state writes, downloads, or email/API calls. Runtime usage depends on actual execution durations, which developers can inspect in Apps Script execution history.

On-demand scheduling would avoid idle executions but require coordination of pending triggers and later batches, cancellation/cleanup, and recovery from scheduling failures. Those paths add complexity at this project's expected volume. The recurring trigger also naturally checks pending work again after a transient pre-claim failure; claimed deliveries remain best-effort without retries.

Google currently lists 50,000 daily property operations and 90 minutes of total trigger runtime for consumer accounts; limits can change and are shared with other work under the account. See [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas). An on-demand trigger's `after` delay is a minimum, not an exact execution time; see [ClockTriggerBuilder](https://developers.google.com/apps-script/reference/script/clock-trigger-builder#afterdurationmilliseconds).

## State and concurrency

All persistent state resides in Script Properties. `STATE_POINTER` identifies `STATE_CHUNK_<generation>_<index>` chunks containing version-1 state: enabled flag, admin IDs, individually identified mappings, discovered channels, pending batches, the last 256 processed update IDs, and removal confirmations. Persistent Telegram IDs are strings; update IDs remain safe integers.

Chunks are at most 7,500 UTF-8 bytes. Under a script lock, the storage helper removes abandoned generations, checks a conservative 450,000-byte budget including property keys and existing data, writes new chunks, and commits by switching the pointer. It then deletes old chunks. Pre-commit failures retain the previous state. Old and new generations temporarily coexist, reducing usable capacity below the platform total; this is not historical backup storage.

`LockService` protects state decisions and mutations. External APIs, downloads, and Gmail calls occur outside locks. Channel lookup checks admin authorization first, then resolves externally and rechecks authorization/deduplication before committing. State changes and their processed update IDs are saved together. Deduplication is bounded and not an exact-once guarantee.

## Collection and email

The first mapped channel post opens a fixed 60-second window measured at receipt. Subsequent posts inside it join the batch; posts at or after the boundary start another. This reduces spam without album-specific state or text suppression. Telegram UI groups may cross boundaries.

Pending posts store text/captions, entities, timestamps, source/channel metadata, file IDs/metadata, and omission notices. File bytes are never stored in Properties. Discovery continues while off; incoming content is discarded. `/off` clears pending batches.

The worker claims one completed batch at a time, snapshots current mappings, and removes it under lock before external work. Other workers cannot claim it again. Changes affect unclaimed batches; `/off` cannot recall claimed sends. It stops claiming after four minutes to leave runtime headroom; unusually large claimed work may still time out.

Claimed batches and failed recipients are not retried. A crash after claim can lose content; send failures are logged while other recipients continue. Identical mappings each get a separate email. These best-effort semantics match expected low volume.

Posts render in channel message-ID order. A custom `@telegraf/entity` serializer produces escaped email-safe HTML and allows HTTP, HTTPS, and mailto links. Its no-entity path passes raw text directly to the serializer, so that path explicitly escapes text. Malformed/crossing entities fall back to escaped text. Plain text is retained independently.

Photos use the largest variant and render after text/caption and before the footer, using CID image references and Gmail's `inlineImages` map. They are excluded from ordinary attachments. Documents retain filenames and remain attachments regardless of MIME type, including images sent as files. Downloads happen during rendering and blobs are reused across recipients. Inline photos and attachments share a conservative 20 MiB budget and a count limit of 250. Plain-text bodies include short photo descriptions; unsupported, oversized, and failed content gets explicit notices.

Large bodies split at post boundaries where possible, with escaped-text segments for an unusually large single post. Inline images stay with the part containing their CID markup, including the single-post fallback. Each post retains channel title, readable original timestamp, and a public or membership-restricted private source link. Formatting uses `Utilities.formatDate` with `Session.getScriptTimeZone()` and `MMM d, yyyy, h:mm a z`; HTML and plain-text footers share the formatted value. The manifest defaults to UTC. Time-zone preferences should be kept in the local manifest so uploads preserve them.

Subjects use the first nonempty text/caption line in message-ID order, channel name, post count, and any split-part suffix. Names are limited to 60 characters and full subjects to 200, with ellipsis truncation that preserves surrogate pairs. Textless batches retain the channel/count fallback. Batched post bodies keep paragraph spacing and individual footers, without HTML horizontal rules or plain-text rule lines.

## Monitoring and verification

Structured logs contain categories and update/batch/mapping identifiers, without message bodies, recipient addresses, tokens, or the webhook URL. Telegram/download exceptions are sanitized. `webhookStatus` logs pending count and error presence/timestamp without Telegram's raw URL or error.

Application tests inject ports; runtime tests mock Google globals. Build validation loads the bundle without Node globals. Developers can follow README's live verification checks to exercise Telegram acknowledgments, Google permissions, trigger scheduling, and email delivery against real services.
