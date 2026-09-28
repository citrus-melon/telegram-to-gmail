# Telegram to Gmail

A webhook-based Telegram bot hosted entirely in Google Apps Script. It forwards new channel posts through the deploying account's Gmail to any valid recipient email address.

## Features
* Best-effort rich text, with HTML and plain-text email bodies.
* Photos and documents as attachments; explicit notices for unsupported or unavailable content.
* One-minute collection windows per channel to combine bursts into one email per mapping.
* Public and private channels, with independent mappings (including identical duplicates).
* Admin-only private-chat commands and inline buttons, with global forwarding on/off.
* Script Properties storage; no Mini App, browser UI, or additional infrastructure.

Delivery is best-effort, intended for around two posts per day. Edits and historical posts are not forwarded. Disabling forwarding discards incoming posts and clears pending batches. Telegram groups crossing a collection boundary can produce multiple emails. Delivery normally takes about one to two minutes, but scheduled trigger timing is approximate.
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

4. Run `setup` in the Apps Script editor as the deploying account. Authorize Gmail, outbound HTTP requests, and trigger management. Setup seeds the admin list, generates `WEBHOOK_SECRET`, registers commands and the webhook, and installs one minute-based `flushPending` trigger. Forwarding starts enabled. Repeating setup preserves configuration and the secret, and does not deliberately drop pending Telegram updates.

5. Open a private chat with the bot and send `/start`. Add the bot to each source channel (usually as an administrator). Use `/channels` after a channel membership update or post, or enter a channel ID/public username:

   ```text
   /addmapping @my_channel reader@example.com
   /addmapping -1001234567890 reader@example.com
   ```

   The bot verifies channel access before adding a mapping. Existing posts are not imported. Private-channel source links require the recipient to have channel membership.

6. Complete the live verification below before relying on forwarding. Mocked tests do not establish that your deployment receives Telegram webhooks successfully.

Keep bot credentials and the secret webhook URL in Script Properties, out of source files and command-line arguments. Local clasp credentials and project configuration are ignored by Git.

## Bot commands

All configuration is restricted to authorized admins in private chats. Every admin has equal permissions; new admins must open their own private chat with the bot.

| Command | Action |
| --- | --- |
| `/start`, `/help` | Show usage |
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

The bot downloads the largest photo variant or a document during delivery. It uses a 20 MiB aggregate attachment budget and at most 250 attachments per email, subject to Telegram's own download limit. Unsupported, oversized, and failed attachments receive omission notices while text/captions and source links are retained. Long bodies split into multiple emails to preserve text. [Telegram file downloads](https://core.telegram.org/bots/api#file) and [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas) impose additional limits.

Check **Executions** for structured events such as `update_failed`, `configuration_save_failed`, `content_omitted`, `email_failed`, and `email_sent`. Logs contain identifiers and outcomes, without credentials or full message bodies. A completed execution can still contain logged delivery failures. Failed recipients and claimed batches are not retried.

Run `webhookStatus` in the editor to log pending update count and error presence/timestamp, excluding the secret URL and raw error text. If `/start` gets no response, check deployment access, authorization, token, and `WEB_APP_URL`, then rerun `setup`. For missing email, check mappings, global state, the trigger, sender authorization, and email quota.

State uses versioned chunks and an atomic generation pointer. Failed pre-commit saves retain the committed configuration. Keeping old and new generations during a save consumes extra storage, so usable capacity is below the Properties total limit. If capacity is reached, let pending batches flush and remove unused entries; inspect logs for discarded updates.

For admin recovery, set `INITIAL_ADMIN_ID` to the recovery user's ID and run `recoverAdmin` in the editor. It adds that user without removing others. Changing the property or rerunning `setup` alone does not change an initialized admin list. Do not manually edit `STATE_POINTER` or `STATE_CHUNK_*`.

## Development

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

The build produces `dist/Code.js` and `dist/appsscript.json`, then verifies that the bundle loads without Node globals and exposes Apps Script entrypoints. Tests inject mocked Google and Telegram services. See [architecture](dev-docs/architecture.md) and [requirements](dev-docs/requirements.md).

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

## Live verification

Use a controlled channel and recipient. Live delivery remains unverified until these checks pass:

1. Verify `/start`, `/status`, and button navigation in an admin's private chat. Verify another user and a group chat cannot configure the bot.
2. Add a mapping; post formatted text with emoji, a photo, and a document within a minute. Verify text order, attachments, source links, UTC timestamps, and one collected email per mapping.
3. Post unsupported content and verify an omission notice. Add an identical mapping and verify two independent emails for the next batch.
4. Remove one duplicate with confirmation. Verify `/cancel`, last-admin protection, and `/off` discarding pending/new posts.
5. Run `webhookStatus`: pending updates should drain and the error timestamp should not keep advancing. Repeated Telegram delivery should not repeat mutations or emails within the deduplication window.

A successful `setWebhook` call does not prove that Telegram receives successful acknowledgments. Resolve live delivery errors before ongoing use.
