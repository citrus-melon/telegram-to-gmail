import { vi } from 'vitest';
import { BotService } from '../src/bot';
import { StateStore } from '../src/storage';
import type { Email, Ports, Properties, State, Update } from '../src/types';

export class MemoryProperties implements Properties {
  values: Record<string, string> = {};
  failWrite = false;
  getProperty(key: string): string | null { return this.values[key] ?? null; }
  getProperties(): Record<string, string> { return { ...this.values }; }
  setProperty(key: string, value: string): void { this.values[key] = value; }
  setProperties(values: Record<string, string>): void {
    if (this.failWrite) {
      const entry = Object.entries(values)[0];
      if (entry) this.values[entry[0]] = entry[1];
      throw new Error('write failure');
    }
    Object.assign(this.values, values);
  }
  deleteProperty(key: string): void { delete this.values[key]; }
}

export function harness() {
  const properties = new MemoryProperties();
  Object.assign(properties.values, { BOT_TOKEN: '123:token', INITIAL_ADMIN_ID: '42', WEB_APP_URL: 'https://script.google.com/macros/s/deployment/exec' });
  let serial = 0, now = 0, lockDepth = 0, updateId = 0;
  const emails: Email[] = [];
  const api = vi.fn((method: string, payload: Record<string, unknown> = {}): unknown => {
    if (lockDepth) throw new Error('External API called while locked');
    if (method === 'getMe') return { id: 123 };
    if (method === 'getChat') return { id: -10012345, type: 'channel', title: 'News', username: String(payload.chat_id).startsWith('@') ? 'news' : undefined };
    if (method === 'getChatMember') return { status: 'administrator' };
    return true;
  });
  const ports: Ports = {
    properties,
    locked(action) { lockDepth++; try { return action(); } finally { lockDepth--; } },
    now: () => now,
    formatTimestamp: vi.fn(() => 'Jan 1, 1970, 12:00 AM UTC'),
    uuid: () => `id-${++serial}`,
    telegram: <T>(method: string, payload?: Record<string, unknown>) => api(method, payload) as T,
    download: vi.fn((file, name) => {
      if (lockDepth) throw new Error('Download while locked');
      return { name, size: file.file_size ?? 100, blob: {} as GoogleAppsScript.Base.Blob };
    }),
    send: vi.fn(email => {
      if (lockDepth) throw new Error('Send while locked');
      emails.push(email);
    }),
    log: vi.fn(),
    syncFlush: vi.fn(),
  };
  const bot = new BotService(ports);
  bot.setup();
  api.mockClear();
  const store = new StateStore(properties, ports.uuid);
  const sendUpdate = (update: Omit<Update, 'update_id'>, id = ++updateId) => bot.receive(properties.getProperty('WEBHOOK_SECRET')!, JSON.stringify({ update_id: id, ...update }));
  const command = (text: string, sender = 42, type = 'private', id?: number) => sendUpdate({ message: { message_id: 1, date: 10, chat: { id: sender, type }, from: { id: sender }, text } }, id);
  const callback = (data: string, sender = 42, type = 'private') => sendUpdate({ callback_query: { id: `callback-${updateId}`, from: { id: sender }, message: { message_id: 1, date: 10, chat: { id: sender, type } }, data } });
  const post = (text: string, extra: Record<string, unknown> = {}, id?: number) => sendUpdate({ channel_post: { message_id: updateId + 1, date: 10, chat: { id: -10012345, type: 'channel', title: 'News' }, text, ...extra } }, id);
  const mutate = (fn: (state: State) => void) => { const state = store.read()!; fn(state); store.write(state); };
  const lastReply = () => {
    const calls = api.mock.calls.filter(([method]) => method === 'sendMessage');
    return calls[calls.length - 1]?.[1] as { text: string; reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } } | undefined;
  };
  return { bot, properties, ports, api, emails, store, sendUpdate, command, callback, post, mutate, lastReply, setTime: (value: number) => { now = value; } };
}
