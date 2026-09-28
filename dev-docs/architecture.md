# Architecture

## Runtime and deployment

The application runs entirely in Google Apps Script V8. esbuild bundles TypeScript and `@telegraf/entity` into an IIFE with global wrappers for `doPost`, `setup`, `flushPending`, `webhookStatus`, and `recoverAdmin`. No Node runtime APIs or external modules are required. clasp uploads only the bundle and manifest from `dist`.

The Web App executes as the deploying account and permits anonymous access. A generated secret query parameter authenticates requests before body parsing. Apps Script's documented event does not expose arbitrary request headers, so the bot does not depend on Telegram's secret header. The URL is a bearer credential and must stay out of logs. `doPost` returns `HtmlOutput` to avoid Content Service redirects. Developers can check acknowledgment behavior using a deployed bot and `webhookStatus`.

Configuration commands and callbacks require the authenticated sender to be an admin in a private chat. Authorization is rechecked before changes. Commands take arguments; buttons support paginated browsing and expiring, per-admin removal confirmations. There is no Mini App or browser UI.

`setup` seeds state only once, preserves the secret, registers explicit update subscriptions and commands, and recreates only the current account's `flushPending` triggers to ensure one minute-based trigger. Setup and deployment must use the same account. `recoverAdmin` is an editor-only recovery function, not a bot operation.

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

Photos use the largest variant; documents retain filenames. Attachments download during rendering and are reused across recipients. Emails have a conservative 20 MiB attachment budget and at most 250 attachments. Unsupported, oversized, and failed content gets explicit notices. Large bodies split at post boundaries where possible, with escaped-text segments for an unusually large single post. Each post retains channel title, original UTC timestamp, and a public or membership-restricted private source link.

## Monitoring and verification

Structured logs contain categories and update/batch/mapping identifiers, without message bodies, recipient addresses, tokens, or the webhook URL. Telegram/download exceptions are sanitized. `webhookStatus` logs pending count and error presence/timestamp without Telegram's raw URL or error.

Application tests inject ports; runtime tests mock Google globals. Build validation loads the bundle without Node globals. Developers can follow README's live verification checks to exercise Telegram acknowledgments, Google permissions, trigger scheduling, and email delivery against real services.
