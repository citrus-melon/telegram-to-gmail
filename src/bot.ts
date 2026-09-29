import { channelFrom, deliver, normalize, WINDOW_MS } from './forwarding';
import { StateStore } from './storage';
import type { Batch, Buttons, Channel, Chat, Ports, State, Update } from './types';
import { projectDetails } from './project';

const COMMANDS = [
  ['start', 'Show help'], ['help', 'Show commands'], ['status', 'Show configuration status'],
  ['channels', 'List discovered channels'], ['mappings', 'List mappings'], ['addmapping', 'Add a channel and recipient'],
  ['removemapping', 'Remove a mapping'], ['admins', 'List administrators'], ['addadmin', 'Add an administrator'],
  ['removeadmin', 'Remove an administrator'], ['on', 'Enable forwarding'], ['off', 'Disable forwarding'], ['cancel', 'Cancel removal'],
];
const HELP = `Configuration commands (private chat, admins only):
/status — forwarding and pending batches
/channels — discovered channels
/mappings — mappings and their IDs
/addmapping <channel-id-or-@username> <email>
/removemapping <mapping-id>
/admins
/addadmin <telegram-user-id>
/removeadmin <telegram-user-id>
/on or /off — enable or disable forwarding
/cancel — cancel pending removal

Removal requires confirmation. Duplicate mappings send independently. Posts are collected for one minute before delivery.`;
interface Reply { text: string; buttons?: Buttons }
interface Prepared { channel?: Channel; error?: string }

function initial(admin: string): State {
  return { version: 1, enabled: true, admins: [admin], mappings: [], channels: [], batches: [], seen: [], confirmations: {} };
}
function remember(state: State, id: number): void {
  state.seen = [...state.seen, id].slice(-256);
}
function discover(state: State, channel: Channel): void {
  const index = state.channels.findIndex(c => c.id === channel.id);
  if (index < 0) state.channels.push(channel); else state.channels[index] = channel;
}
function userIdValid(value: string): boolean { return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)); }
function emailValid(value: string): boolean {
  return value.length <= 254 && /^[^\s@<>,;\r\n]+@[^\s@<>,;\r\n]+\.[^\s@<>,;\r\n]+$/.test(value);
}

export class BotService {
  private store: StateStore;
  constructor(private ports: Ports) { this.store = new StateStore(ports.properties, () => ports.uuid()); }

  private state(): State {
    const state = this.store.read();
    if (!state) throw new Error('Run setup before using the bot.');
    return state;
  }

  private nextFlush(state: State): number | null {
    return state.enabled && state.batches.length
      ? Math.min(...state.batches.map(batch => batch.openedAt + WINDOW_MS)) : null;
  }

  private syncFlush(state: State, firingId?: string): void {
    try { this.ports.syncFlush(this.nextFlush(state), firingId); }
    catch { this.ports.log('flush_schedule_failed'); }
  }

  setup(): void {
    const p = this.ports.properties;
    const token = p.getProperty('BOT_TOKEN');
    const admin = p.getProperty('INITIAL_ADMIN_ID') || '';
    const url = p.getProperty('WEB_APP_URL') || '';
    if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('Set a valid BOT_TOKEN in Script Properties.');
    if (!userIdValid(admin)) throw new Error('Set INITIAL_ADMIN_ID to a numeric Telegram user ID.');
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url)) throw new Error('Set WEB_APP_URL to the deployed Apps Script /exec URL (without query parameters).');
    this.ports.locked(() => {
      if (!this.store.read()) this.store.write(initial(admin));
      if (!p.getProperty('WEBHOOK_SECRET')) p.setProperty('WEBHOOK_SECRET', this.ports.uuid() + this.ports.uuid());
    });
    this.ports.telegram('getMe');
    this.ports.telegram('setMyCommands', { commands: COMMANDS.map(([command, description]) => ({ command, description })) });
    this.ports.telegram('setWebhook', {
      url: `${url}?secret=${encodeURIComponent(p.getProperty('WEBHOOK_SECRET')!)}`,
      max_connections: 1,
      allowed_updates: ['channel_post', 'message', 'callback_query', 'my_chat_member'],
      drop_pending_updates: false,
    });
    this.ports.locked(() => this.ports.syncFlush(this.nextFlush(this.state())));
    this.ports.log('setup_complete');
  }

  recoverAdmin(): void {
    const admin = this.ports.properties.getProperty('INITIAL_ADMIN_ID') || '';
    if (!userIdValid(admin)) throw new Error('Set INITIAL_ADMIN_ID to the recovery user ID.');
    this.ports.locked(() => {
      const state = this.state();
      if (!state.admins.includes(admin)) { state.admins.push(admin); this.store.write(state); }
    });
    this.ports.log('admin_recovered');
  }

  receive(secret: string | undefined, body: string): void {
    const expected = this.ports.properties.getProperty('WEBHOOK_SECRET');
    if (!expected || !secret || secret !== expected) { this.ports.log('webhook_rejected'); return; }
    let update: Update;
    try {
      update = JSON.parse(body) as Update;
      if (!update || !Number.isSafeInteger(update.update_id)) throw new Error('Invalid update');
    } catch { this.ports.log('invalid_update'); return; }
    try {
      if (update.channel_post || update.my_chat_member) this.channelUpdate(update);
      else if (update.message || update.callback_query) this.configuration(update);
    } catch {
      // Do not expose Telegram response bodies or token-bearing fetch exceptions to execution logs.
      this.ports.log('update_failed', { updateId: update.update_id });
    } finally {
      // Also repairs missing schedules after repeated updates or an earlier scheduling failure.
      try { this.ports.locked(() => this.syncFlush(this.state())); }
      catch { this.ports.log('flush_schedule_failed'); }
    }
  }

  private channelUpdate(update: Update): void {
    this.ports.locked(() => {
      const state = this.state();
      if (state.seen.includes(update.update_id)) return;
      if (update.my_chat_member?.chat.type === 'channel') {
        const member = update.my_chat_member;
        discover(state, channelFrom(member.chat, !['left', 'kicked'].includes(member.new_chat_member.status)));
      }
      const message = update.channel_post;
      if (message?.chat.type === 'channel') {
        discover(state, channelFrom(message.chat));
        const post = normalize(message, update.update_id);
        if (post && state.enabled && state.mappings.some(m => m.channelId === post.channel.id)) {
          const now = this.ports.now();
          let batch = state.batches.find(b => b.channelId === post.channel.id && now >= b.openedAt && now < b.openedAt + WINDOW_MS);
          if (!batch) {
            batch = { id: this.ports.uuid(), channelId: post.channel.id, openedAt: now, posts: [] };
            state.batches.push(batch);
          }
          batch.posts.push(post);
        }
      }
      remember(state, update.update_id);
      this.store.write(state);
    });
  }

  private configuration(update: Update): void {
    const callback = update.callback_query;
    const message = callback?.message || update.message;
    const sender = callback?.from.id ?? message?.from?.id;
    if (!message || sender === undefined) return;
    const admin = String(sender);
    const allowed = this.ports.locked(() => {
      const state = this.state();
      return message.chat.type === 'private' && String(message.chat.id) === admin && state.admins.includes(admin);
    });
    if (!allowed) {
      if (callback) this.ports.telegram('answerCallbackQuery', { callback_query_id: callback.id, text: 'Admin access in a private chat is required.' });
      else if (message.chat.type === 'private') this.reply(admin, { text: 'This bot is restricted to authorized administrators.' });
      return;
    }
    const command = /^\/([a-z]+)(?:@[a-zA-Z0-9_]+)?(?:\s+([\s\S]*))?$/i.exec(message.text?.trim() || '');
    const name = command?.[1].toLowerCase();
    const args = command?.[2]?.trim().split(/\s+/) || [];
    let prepared: Prepared = {};
    const alreadySeen = this.ports.locked(() => this.state().seen.includes(update.update_id));
    if (!alreadySeen && !callback && name === 'addmapping' && args.length === 2) {
      if (!emailValid(args[1])) prepared.error = 'Enter one valid recipient email address.';
      else if (!/^(-100\d+|@?[a-zA-Z][a-zA-Z0-9_]{3,})$/.test(args[0])) prepared.error = 'Use a channel ID beginning with -100 or a channel username.';
      else {
        try {
          const chatId = args[0].startsWith('-') ? args[0] : `@${args[0].replace(/^@/, '')}`;
          const chat = this.ports.telegram<Chat>('getChat', { chat_id: chatId });
          if (chat.type !== 'channel') prepared.error = 'The target must be a Telegram channel.';
          else {
            const me = this.ports.telegram<{ id: number }>('getMe');
            const member = this.ports.telegram<{ status: string }>('getChatMember', { chat_id: chat.id, user_id: me.id });
            if (['left', 'kicked'].includes(member.status)) prepared.error = 'Add the bot to the channel before mapping it.';
            else prepared.channel = channelFrom(chat);
          }
        } catch { prepared.error = 'Cannot access that channel. Check the ID/username and add the bot to it.'; }
      }
    }
    let response: Reply | undefined;
    try { this.ports.locked(() => {
      const state = this.state();
      if (!state.admins.includes(admin) || state.seen.includes(update.update_id)) return;
      for (const [id, confirmation] of Object.entries(state.confirmations)) {
        if (confirmation.expiresAt <= this.ports.now()) delete state.confirmations[id];
      }
      if (callback) response = this.callback(state, admin, callback.data || '');
      else response = this.command(state, admin, name, args, prepared);
      remember(state, update.update_id);
      this.store.write(state);
    }); } catch {
      response = { text: 'Could not save configuration. Check Script Properties capacity and execution logs; retry after resolving the problem.' };
      this.ports.log('configuration_save_failed', { updateId: update.update_id });
    }
    if (callback) this.ports.telegram('answerCallbackQuery', { callback_query_id: callback.id });
    if (response) this.reply(admin, response);
  }

  private reply(chatId: string, response: Reply): void {
    this.ports.telegram('sendMessage', {
      chat_id: chatId, text: response.text.slice(0, 4000),
      ...(response.buttons ? { reply_markup: { inline_keyboard: response.buttons } } : {}),
    });
  }

  private command(state: State, admin: string, name: string | undefined, args: string[], prepared: Prepared): Reply {
    if (['start', 'help'].includes(name || '')) return { text: `${HELP}\n\n${projectDetails()}` };
    if (name === 'status') return { text: `Forwarding: ${state.enabled ? 'on' : 'off'}\nMappings: ${state.mappings.length}\nAdmins: ${state.admins.length}\nPending batches: ${state.batches.length}` };
    if (name === 'channels') return this.list(state, 'c', 0);
    if (name === 'mappings') return this.list(state, 'm', 0);
    if (name === 'admins') return this.list(state, 'a', 0);
    if (name === 'on' || name === 'off') {
      state.enabled = name === 'on';
      if (!state.enabled) state.batches = [];
      return { text: `Forwarding ${state.enabled ? 'enabled' : 'disabled; pending posts discarded'}.` };
    }
    if (name === 'cancel') { delete state.confirmations[admin]; return { text: 'Pending removal canceled.' }; }
    if (name === 'addmapping') {
      if (args.length !== 2) return { text: 'Usage: /addmapping <channel-id-or-@username> <email>' };
      if (prepared.error) return { text: prepared.error };
      if (!prepared.channel) return { text: 'Channel could not be resolved.' };
      const mapping = { id: this.ports.uuid(), channelId: prepared.channel.id, recipient: args[1] };
      state.mappings.push(mapping); discover(state, prepared.channel);
      return { text: `Mapping added: ${mapping.id}\n${prepared.channel.title} → ${mapping.recipient}` };
    }
    if (name === 'addadmin') {
      if (args.length !== 1 || !userIdValid(args[0])) return { text: 'Usage: /addadmin <numeric-telegram-user-id>' };
      if (state.admins.includes(args[0])) return { text: 'That user is already an admin.' };
      state.admins.push(args[0]); return { text: 'Admin added. They can open a private chat with this bot.' };
    }
    if (name === 'removemapping' || name === 'removeadmin') {
      if (args.length !== 1) return { text: `Usage: /${name} <${name === 'removemapping' ? 'mapping-id' : 'telegram-user-id'}>` };
      return this.confirm(state, admin, name === 'removemapping' ? 'mapping' : 'admin', args[0]);
    }
    return { text: 'Use /help for commands. Configuration uses commands with arguments.' };
  }

  private confirm(state: State, admin: string, kind: 'mapping' | 'admin', target: string): Reply {
    const exists = kind === 'mapping' ? state.mappings.some(m => m.id === target) : state.admins.includes(target);
    if (!exists) return { text: 'Entry no longer exists.' };
    if (kind === 'admin' && state.admins.length === 1) return { text: 'Cannot remove the last admin.' };
    const token = this.ports.uuid();
    state.confirmations[admin] = { token, kind, target, expiresAt: this.ports.now() + 5 * 60_000 };
    return { text: `Remove ${kind} ${target}?`, buttons: [[{ text: 'Confirm removal', callback_data: `confirm:${token}` }, { text: 'Cancel', callback_data: 'cancel' }]] };
  }

  private callback(state: State, admin: string, data: string): Reply {
    if (data === 'cancel') { delete state.confirmations[admin]; return { text: 'Pending removal canceled.' }; }
    const page = /^page:([mca]):(\d{1,6})$/.exec(data);
    if (page) return this.list(state, page[1] as 'm' | 'c' | 'a', Number(page[2]));
    if (data.startsWith('channel:')) {
      const channel = state.channels.find(c => c.id === data.slice(8));
      return { text: channel ? `${channel.title}\nID: ${channel.id}\n${channel.accessible ? '' : 'Bot currently lacks access.\n'}Use: /addmapping ${channel.id} recipient@example.com` : 'Channel no longer exists.' };
    }
    if (data.startsWith('remove:m:')) return this.confirm(state, admin, 'mapping', data.slice(9));
    if (data.startsWith('remove:a:')) return this.confirm(state, admin, 'admin', data.slice(9));
    if (data.startsWith('confirm:')) {
      const confirmation = state.confirmations[admin];
      if (!confirmation || confirmation.token !== data.slice(8) || confirmation.expiresAt <= this.ports.now()) return { text: 'Confirmation expired or canceled. Start the removal again.' };
      delete state.confirmations[admin];
      if (confirmation.kind === 'mapping') {
        if (!state.mappings.some(m => m.id === confirmation.target)) return { text: 'Entry no longer exists.' };
        state.mappings = state.mappings.filter(m => m.id !== confirmation.target);
      } else {
        if (!state.admins.includes(confirmation.target)) return { text: 'Entry no longer exists.' };
        if (state.admins.length === 1) return { text: 'Cannot remove the last admin.' };
        state.admins = state.admins.filter(id => id !== confirmation.target);
      }
      return { text: `${confirmation.kind === 'mapping' ? 'Mapping' : 'Admin'} removed.` };
    }
    return { text: 'Unknown or outdated button. Use /help.' };
  }

  private list(state: State, kind: 'm' | 'c' | 'a', requested: number): Reply {
    const items = kind === 'm' ? state.mappings : kind === 'c' ? state.channels : state.admins;
    const pages = Math.max(1, Math.ceil(items.length / 5));
    const page = Math.min(requested, pages - 1);
    const buttons: Buttons = [];
    const lines: string[] = [];
    for (let i = page * 5; i < Math.min(items.length, page * 5 + 5); i++) {
      if (kind === 'm') {
        const mapping = state.mappings[i];
        lines.push(`${mapping.id}\n${mapping.channelId} → ${mapping.recipient}`);
        buttons.push([{ text: `Remove ${mapping.recipient}`.slice(0, 60), callback_data: `remove:m:${mapping.id}` }]);
      } else if (kind === 'c') {
        const channel = state.channels[i];
        lines.push(`${channel.title.slice(0, 200)} (${channel.id})${channel.accessible ? '' : ' — unavailable'}`);
        buttons.push([{ text: channel.title.slice(0, 60), callback_data: `channel:${channel.id}` }]);
      } else {
        const id = state.admins[i]; lines.push(id);
        buttons.push([{ text: `Remove ${id}`, callback_data: `remove:a:${id}` }]);
      }
    }
    const navigation = [];
    if (page > 0) navigation.push({ text: 'Previous', callback_data: `page:${kind}:${page - 1}` });
    if (page + 1 < pages) navigation.push({ text: 'Next', callback_data: `page:${kind}:${page + 1}` });
    if (navigation.length) buttons.push(navigation);
    return { text: `${kind === 'm' ? 'Mappings' : kind === 'c' ? 'Channels' : 'Admins'} (${page + 1}/${pages})\n\n${lines.join('\n\n') || 'No entries.'}`, buttons };
  }

  flush(firingId?: string): void {
    // Claim one batch at a time so a slow download cannot claim the entire backlog before a runtime timeout.
    const deadline = this.ports.now() + 4 * 60_000;
    try {
      while (this.ports.now() < deadline) {
        const claimed = this.ports.locked(() => {
          const state = this.state();
          if (!state.enabled) {
            if (state.batches.length) { state.batches = []; this.store.write(state); }
            this.syncFlush(state, firingId); firingId = undefined;
            return null;
          }
          const batch = state.batches.find(b => b.openedAt + WINDOW_MS <= this.ports.now());
          if (!batch) {
            this.syncFlush(state, firingId); firingId = undefined;
            return null;
          }
          const mappings = state.mappings.filter(m => m.channelId === batch.channelId);
          state.batches = state.batches.filter(b => b.id !== batch.id);
          this.store.write(state);
          // Keep a successor scheduled before sending: later/unclaimed batches survive worker timeouts.
          this.syncFlush(state, firingId); firingId = undefined;
          return { batch, mappings };
        });
        if (!claimed) break;
        if (!claimed.mappings.length) { this.ports.log('batch_unmapped', { batchId: claimed.batch.id }); continue; }
        try { deliver(claimed.batch as Batch, claimed.mappings, this.ports); }
        catch { this.ports.log('batch_failed', { batchId: claimed.batch.id }); }
      }
    } finally {
      try { this.ports.locked(() => this.syncFlush(this.state(), firingId)); }
      catch { this.ports.log('flush_schedule_failed'); }
    }
  }
}
