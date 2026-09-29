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

   For an existing dedicated project, copy `.clasp.example.json` to `.clasp.json`, replace `YOUR_SCRIPT_ID`, and run `pnpm upload`. Upload replaces remote code with this bot.

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

4. Run `setup` in the Apps Script editor as the deploying account. Authorize Gmail, outbound HTTP requests, and trigger management. Timestamps follow the Apps Script project time zone. The manifest defaults to `Etc/UTC`; change `timeZone` in the local `appsscript.json` and redeploy to persist your preference across uploads. Changing the time zone only in the editor can be overwritten by a later upload.

5. Open a private chat with the bot and send `/start`. Add the bot to each source channel (usually as an administrator). Use `/channels` after a channel membership update or post, or enter a channel ID/public username:

   ```text
   /addmapping @my_channel reader@example.com
   /addmapping -1001234567890 reader@example.com
   ```

   The bot verifies channel access before adding a mapping. Private-channel source links require the recipient to have channel membership.

Keep bot credentials and the secret webhook URL in Script Properties, out of source files and command-line arguments. Local clasp credentials and project configuration are ignored by Git.

### Updating a deployment

To update an existing deployment while retaining its URL:

```sh
pnpm upload
pnpm clasp update-deployment DEPLOYMENT_ID --description "Bot update"
```

Upload alone updates editor code; redeploy to update the running bot. Rerun `setup` after command/subscription changes or replacing the URL. Use the same Google account for setup and updates so it can manage the bot's triggers.

## Bot commands

Configuration is available only to authorized admins in private chats. All admins have equal permissions; new admins must open their own private chat with the bot.

| Command | Action |
| --- | --- |
| `/start`, `/help` | Show usage and project information |
| `/status` | Show forwarding status, mapping/admin counts, and pending batches |
| `/channels` | Browse channels and view mapping instructions |
| `/mappings` | Browse mappings and their IDs |
| `/addmapping <channel-id-or-@username> <email>` | Add a mapping; duplicates are allowed |
| `/removemapping <mapping-id>` | Remove a mapping after button confirmation |
| `/admins` | Browse administrators |
| `/addadmin <telegram-user-id>` | Add an administrator |
| `/removeadmin <telegram-user-id>` | Remove an administrator after confirmation; the last admin cannot be removed |
| `/on`, `/off` | Enable forwarding, or disable it and clear pending posts |
| `/cancel` | Cancel your pending removal confirmation |

Lists have Previous/Next buttons. Each mapping sends its own email, including identical mappings.

## Development

The project uses TypeScript, pnpm, clasp, esbuild, Vitest, and `@telegraf/entity`, with Google Apps Script as its runtime. Local development requires Node.js 22 or newer and pnpm 9.10.0.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

- [Development guide](dev-docs/development.md): troubleshooting and optional live checks.
- [Requirements](dev-docs/requirements.md): supported behavior and constraints.
- [Architecture](dev-docs/architecture.md): implementation and technical decisions.
