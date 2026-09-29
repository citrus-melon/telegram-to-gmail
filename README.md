# Telegram to Gmail

A webhook-based Telegram bot hosted entirely in Google Apps Script. It forwards new channel posts through the deploying account's Gmail to any valid recipient email address.

## Features
### Rich Message Mapping
* Best-effort mapping of rich text formatting, inline images, and attachments
* Explicit notices for unsupported or unavailable content.
* Message text in subject line
* Channel name/timestamp and link to original message in footer
* One-minute collection windows per channel to combine message bursts and prevent email spam.
* Best-effort delivery after the collection window ends, with on-demand scheduling and no periodic idle executions

### Telegram bot configuration interface
Minimal interface for configuration of:
* Users permitted to modify configuration
* Any number of mappings from Telegram channel to recipient address
* Temporary on/off

### Google Apps Script
Hosted completely in Google Apps Script; easy setup and no other infrastructure required


## Setup

You need Node.js 22 or newer, pnpm 9.10.0, a Google account with Gmail and Apps Script access, and a Telegram bot created with BotFather. The deploying Google account must also run setup and own the scheduled trigger.

1. Enable the [Apps Script API](https://script.google.com/home/usersettings), install dependencies, sign into clasp, and create a dedicated project:

   ```sh
   pnpm install --frozen-lockfile
   pnpm clasp login
   pnpm clasp create-script --type standalone --title "Telegram to Gmail" --rootDir dist
   pnpm upload
   ```

   For an existing dedicated project, copy `.clasp.example.json` to `.clasp.json`, replace `YOUR_SCRIPT_ID`, and run `pnpm upload`. Upload replaces remote code with this bot. Only the built JavaScript and manifest are uploaded.

2. Create a versioned deployment:

   ```sh
   pnpm clasp create-deployment --description "Initial bot deployment"
   ```

   The manifest specifies a Web App executing as the deploying user and accessible without Google sign-in. Verify these settings under **Deploy → Manage deployments** in the Apps Script editor. If necessary, create the Web App via **Deploy → New deployment**, choosing **Execute as: Me** and **Who has access: Anyone**. Workspace policy must permit anonymous Web Apps. Use the deployed `/exec` URL, not `/dev`. See [Google's deployment documentation](https://developers.google.com/apps-script/guides/web).

3. In **Project Settings → Script Properties**, add:

   | Property | Value |
   | --- | --- |
   | `BOT_TOKEN` | BotFather token |
   | `INITIAL_ADMIN_ID` | Your numeric Telegram user ID, not your username |
   | `WEB_APP_URL` | `https://script.google.com/macros/s/DEPLOYMENT_ID/exec`, without query parameters |

4. Run `setup` in the Apps Script editor as the deploying account. Authorize Gmail, outbound HTTP requests, and trigger management. Setup schedules pending content only when needed; an idle bot has no flush trigger. Timestamps follow the Apps Script project time zone. The manifest defaults to `Etc/UTC`; change `timeZone` in the local `appsscript.json` and redeploy to persist your preference across uploads. Changing the time zone only in the editor can be overwritten by a later upload.

5. Open a private chat with the bot and send `/start`. Add the bot to each source channel (usually as an administrator). Use `/channels` after a channel membership update or post, or enter a channel ID/public username:

   ```text
   /addmapping @my_channel reader@example.com
   /addmapping -1001234567890 reader@example.com
   ```

   The bot verifies channel access before adding a mapping. Existing posts are not imported. Private-channel source links require the recipient to have channel membership.

Keep bot credentials and the secret webhook URL in Script Properties, out of source files and command-line arguments. Local clasp credentials and project configuration are ignored by Git.

## Bot commands

All configuration is restricted to authorized admins in private chats. Every admin has equal permissions; new admins must open their own private chat with the bot.

| Command | Action |
| --- | --- |
| `/start`, `/help` | Show usage and project/version information, with revision and repository URL when available |
| `/status` | Forwarding state, mapping/admin counts, pending batches |
| `/channels` | Browse channels and select one for mapping instructions |
| `/mappings` | Browse mappings and their independent IDs |
| `/addmapping <channel-id-or-@username> <email>` | Add one mapping; duplicates are allowed |
| `/removemapping <mapping-id>` | Request removal, then confirm with a button |
| `/admins` | Browse administrators |
| `/addadmin <telegram-user-id>` | Add an administrator |
| `/removeadmin <telegram-user-id>` | Request removal; the last admin cannot be removed |
| `/on`, `/off` | Enable forwarding, or disable it and clear pending posts |
| `/cancel` | Cancel your pending removal confirmation |

Lists use Previous/Next buttons. Removal confirmations expire after five minutes; another removal replaces your previous confirmation. Mapping changes apply when pending batches are claimed. `/off` cannot recall emails from an already claimed batch.

## Limits and troubleshooting

The bot displays the largest Telegram photo variant inline in the HTML email. Documents remain attachments, including images sent as files. Photos also have a short description in the plain-text body. Inline images and ordinary attachments share a 20 MiB aggregate budget and a limit of 250 files per email, subject to Telegram's own download limit. Unsupported, oversized, and failed files receive omission notices while text/captions and source links are retained. Long bodies split into multiple emails to preserve text. [Telegram file downloads](https://core.telegram.org/bots/api#file) and [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas) impose additional limits.

Check **Executions** for structured events such as `update_failed`, `configuration_save_failed`, `content_omitted`, `email_failed`, and `email_sent`. Logs contain identifiers and outcomes, without credentials or full message bodies. A completed execution can still contain logged delivery failures. Failed recipients and claimed batches are not retried.

Run `webhookStatus` in the editor to log pending update count and error presence/timestamp, excluding the secret URL and raw error text. If `/start` gets no response, check deployment access, authorization, token, and `WEB_APP_URL`, then rerun `setup`. For missing email, check mappings, global state, the trigger, sender authorization, and email quota.

The bot creates a one-shot `flushPending` trigger for the earliest pending batch and reuses it for further posts in that window. After a flush, it schedules remaining work or removes the trigger when the queue is empty. `/off` clears pending work and cancels its trigger. Apps Script's trigger delay is a minimum, so delivery can take longer than the one-minute collection window. No periodic trigger runs while idle. See [ClockTriggerBuilder timing](https://developers.google.com/apps-script/reference/script/clock-trigger-builder#afterdurationmilliseconds).

If logs show `flush_schedule_failed`, queued content is retained. Later authenticated webhook updates attempt to repair scheduling; you can also run `setup` or `flushPending` in the editor. There is no periodic recovery poll. An idle bot having no trigger is normal, but pending batches with no trigger can indicate a scheduling failure.

State uses versioned chunks and an atomic generation pointer. Failed pre-commit saves retain the committed configuration. Keeping old and new generations during a save consumes extra storage, so usable capacity is below the Properties total limit. If capacity is reached, let pending batches flush and remove unused entries; inspect logs for discarded updates.

For admin recovery, set `INITIAL_ADMIN_ID` to the recovery user's ID and run `recoverAdmin` in the editor. It adds that user without removing others. Changing the property or rerunning `setup` alone does not change an initialized admin list. Do not manually edit `STATE_POINTER` or `STATE_CHUNK_*`.

## Development

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

The build produces `dist/Code.js` and `dist/appsscript.json`, then verifies that the bundle loads without Node globals, exposes Apps Script entrypoints, and shares project information between its leading comment and bot help. Metadata comes from package name/description/version and the available Git revision. The repository URL comes from `package.json`'s `repository` field, then Git origin; unavailable fields are omitted. Credentials, query parameters, fragments, and filesystem remotes are excluded. Builds also work without Git. Edit the source rather than emitted code. Tests inject mocked Google and Telegram services. See [architecture](dev-docs/architecture.md) and [requirements](dev-docs/requirements.md).

To update an existing deployment while retaining its URL:

```sh
pnpm upload
pnpm clasp update-deployment DEPLOYMENT_ID --description "Bot update"
```

Upload alone updates editor code; the versioned Web App needs redeployment. Rerun `setup` after command/subscription changes or replacing the URL. Use the same Google account each time: Apps Script cannot enumerate another account's triggers.

### Tech Stack
* Google Apps Script
* `clasp`
* `@telegraf/entity`
* TypeScript
* `pnpm`
* esbuild and Vitest

### Live verification

Developers can use the following checks with a controlled channel and recipient to exercise a deployed bot, for example after changing webhook handling or forwarding behavior:

1. Verify `/start`, `/status`, and button navigation in an admin's private chat. Verify another user and a group chat cannot configure the bot.
2. Add a mapping; post multiline text with emoji, a photo, and an image sent as a document within a minute. Check the subject preview, text order, inline photo, attached document, source links, script-time-zone timestamps, and one collected email per mapping.
3. Post unsupported content and verify an omission notice. Add an identical mapping and verify two independent emails for the next batch.
4. Remove one duplicate with confirmation. Verify `/cancel`, last-admin protection, and `/off` discarding pending/new posts.
5. Run `webhookStatus`: pending updates should drain and the error timestamp should not keep advancing. Repeated Telegram delivery should not repeat mutations or emails within the deduplication window.
6. Inspect Apps Script's triggers: a burst should share one pending flush trigger, and the bot should have none after its queue drains. Check that `/off` cancels it and posts arriving during delivery get a subsequent scheduled flush.

A successful `setWebhook` call confirms registration. Developers can use `webhookStatus` and execution logs to investigate acknowledgment or delivery errors.
