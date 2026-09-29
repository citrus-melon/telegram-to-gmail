# Development guide

See the [README](../README.md) for deployment instructions and local check commands, [requirements](requirements.md) for supported behavior, and [architecture](architecture.md) for runtime, storage, scheduling, and rendering details. Edit source files rather than generated files in `dist`.

## Troubleshooting and recovery

Use the Apps Script editor's **Executions** view to inspect events such as `update_failed`, `configuration_save_failed`, `content_omitted`, `email_failed`, and `email_sent`. A completed execution can still contain logged delivery failures.

- **Bot doesn't respond:** run `webhookStatus` to inspect pending updates and webhook error status. Check deployment access, Google authorization, `BOT_TOKEN`, and `WEB_APP_URL`, then rerun `setup`.
- **Email doesn't arrive:** check mappings, forwarding status, sender authorization, Gmail quota, and delivery logs.
- **Scheduling fails:** look for `flush_schedule_failed`. Run `setup` or `flushPending` to repair scheduling. Pending batches with no flush trigger can indicate failure; an idle bot having no trigger is normal.
- **Storage reaches capacity:** let pending batches flush and remove unused entries. Inspect logs for discarded updates. Do not manually edit `STATE_POINTER` or `STATE_CHUNK_*`.
- **Admin access is lost:** set `INITIAL_ADMIN_ID` to the recovery user's numeric ID and run `recoverAdmin` in the editor. This adds that user without removing others. Changing the property or rerunning `setup` alone does not change an initialized admin list.

## Live verification

Developers can use the following checks with a controlled channel and recipient to exercise a deployed bot, for example after changing webhook handling or forwarding behavior:

1. Verify `/start`, `/status`, and button navigation in an admin's private chat. Verify another user and a group chat cannot configure the bot.
2. Add a mapping; post multiline text with emoji, a photo, and an image sent as a document within a minute. Check the subject preview, text order, inline photo, attached document, source links, script-time-zone timestamps, and one collected email per mapping.
3. Post unsupported content and verify an omission notice. Add an identical mapping and verify two independent emails for the next batch.
4. Remove one duplicate with confirmation. Verify `/cancel`, last-admin protection, and `/off` discarding pending/new posts.
5. Run `webhookStatus`: pending updates should drain and the error timestamp should not keep advancing. Repeated Telegram delivery should not repeat mutations or emails within the deduplication window.
6. Inspect Apps Script's triggers: a burst should share one pending flush trigger, and the bot should have none after its queue drains. Check that `/off` cancels it and posts arriving during delivery get a subsequent scheduled flush.

A successful `setWebhook` call confirms registration. Developers can use `webhookStatus` and execution logs to investigate acknowledgment or delivery errors.
