# Requirements
See README.md first for high-level feature list and tech stack.

## Core forwarding functionality
* Any number of (Telegram channel -> recipient address) mappings, with no artificial application limit; capacity remains subject to platform quotas
* Each mapping has one channel and one recipient. Treat mappings independently, including identical duplicate pairs; duplicates can produce duplicate emails
* Send email from the Google account that deploys the script, to any valid email address (not limited to Gmail)
* Support public and private channels that the bot can access
* Forward new channel posts only; do not forward edits or backfill historical posts
* Make a best effort to map message formatting using `@telegraf/entity`, prioritizing preservation of text and captions
* Prioritize photos and documents for attachment forwarding
* Display Telegram photos inline in the HTML email, with a short description in plain text. Documents, including images sent as files, remain attachments; inline photos and attachments share file size/count budgets
* Include the first nonempty text/caption line in message order in the subject, alongside channel and post count. Truncate safely within 200 characters and retain split-email part numbers; textless batches use channel and count
* Include explicit omission notices for unsupported, oversized, or otherwise unavailable attachments; preserve available text/captions and the source link
* Avoid email spam from content grouped in Telegram's UI or notifications. Prefer one email per group (including media albums); a rate limit that prioritizes text is an acceptable alternative
* End emails with a minimal note containing the source channel name, message timestamp, and link. Private-channel links may require channel membership to open
* Render readable timestamps in the Apps Script project time zone; separate batched posts with paragraph spacing, without horizontal rules

## Delivery behavior
* Expected usage is low volume, around two Telegram messages per day
* Best-effort delivery with execution logs is sufficient; persistent delivery retries and exact-once guarantees are not required
* Log forwarding failures and attachment omissions so they can be diagnosed
* When global forwarding is off, discard incoming posts rather than queueing them for later delivery
* Use a fixed one-minute collection window per channel to reduce burst spam; schedule a one-shot flush for the earliest pending batch. Reuse that schedule across the burst and leave no periodic idle trigger; actual trigger timing may be delayed by Apps Script
* Cancel scheduled work when forwarding is disabled; keep a successor scheduled for remaining batches and posts received during delivery
* Preserve queued content on scheduling failures, log the failure, and allow repair through later webhook updates or manual setup/flush actions
* Apply current mappings when a batch is claimed for sending. Disabling forwarding clears pending batches but cannot recall claimed deliveries
* Deduplicate recently processed Telegram updates on a best-effort basis, independently of intentionally duplicated mappings

## Setup Flow
* User creates Google Apps Script project and deployment using `clasp`, and Telegram bot using BotFather
    * Google Apps Script Web App deployment as webhook endpoint, running as the deploying account and accessible to Telegram without Google sign-in
* User provides bot token and initial admin Telegram user id as Script Properties
* User also provides the deployed Web App URL as a Script Property; setup generates the webhook secret
* User triggers an initial Google Apps Script action to complete Telegram bot setup, including webhook registration and bot command registration

## Configuration
* Once initial setup is complete, admins manage further configuration through a Telegram bot interface, using commands and inline buttons
* Provide help/start instructions, configuration status, mapping listing/addition/removal, admin listing/addition/removal, and global forwarding on/off
* Identify mapping entries individually so identical duplicate pairs can be listed and removed independently
* Allow admins to select channels discovered by the bot or manually enter channel IDs/usernames
* All admins have equal permissions, including adding and removing other admins
* Prevent removal of the last admin. The initial admin may be removed if another admin remains; Script Properties provide an administrative recovery mechanism
* Authenticate configuration requests using the sender's Telegram user ID from validated webhook updates; check current admin authorization on every configuration command, callback, and conversational input
* Keep the interface minimal but functional, with clear success/error responses and a way to cancel any multi-step interaction
* Use commands with arguments for entering mappings and admin IDs; use inline buttons for paginated lists and removal confirmations
* Configuration is available only in authorized admins' private chats, with no Mini App or browser interface
* Include project name, description, version, and available revision/repository information in `/start` and `/help`

## General implementation notes
* Persist all data as Script Properties
* Use an autogenerated secret URL parameter to authenticate the Telegram webhook endpoint before processing updates
* Receive channel posts, private-chat bot commands/messages, and inline-button callback queries through the same webhook endpoint; private-chat configuration messages are not forwarded as channel content
* Include shared project metadata in a leading comment in emitted code and in bot help. Omit unavailable Git/remote details and exclude credentials and filesystem paths
