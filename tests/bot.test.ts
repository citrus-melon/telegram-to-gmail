import { describe, expect, it, vi } from 'vitest';
import { harness } from './harness';

describe('setup and webhook authorization', () => {
  it('preserves settings, removed initial admins, and the secret on repeat setup', () => {
    const h = harness();
    h.command('/addmapping @news user@example.com');
    h.mutate(s => { s.enabled = false; s.admins = ['43']; });
    const secret = h.properties.getProperty('WEBHOOK_SECRET');
    h.bot.setup();
    expect(h.store.read()).toMatchObject({ enabled: false, admins: ['43'], mappings: [{ recipient: 'user@example.com' }] });
    expect(h.properties.getProperty('WEBHOOK_SECRET')).toBe(secret);
    expect(h.api).toHaveBeenCalledWith('setWebhook', expect.objectContaining({ max_connections: 1, drop_pending_updates: false, allowed_updates: ['channel_post', 'message', 'callback_query', 'my_chat_member'] }));
    expect(h.ports.ensureTrigger).toHaveBeenCalledTimes(2);
  });
  it('validates setup values and supports recovery without replacing admins', () => {
    const h = harness();
    h.properties.setProperty('WEB_APP_URL', 'https://example.com/exec');
    expect(() => h.bot.setup()).toThrow('WEB_APP_URL');
    h.mutate(s => { s.admins = ['43']; });
    h.bot.recoverAdmin(); h.bot.recoverAdmin();
    expect(h.store.read()?.admins).toEqual(['43', '42']);
  });
  it('rejects a wrong secret before parsing and ignores malformed authenticated updates', () => {
    const h = harness();
    h.bot.receive('wrong', '{');
    h.bot.receive(h.properties.getProperty('WEBHOOK_SECRET')!, 'null');
    h.bot.receive(h.properties.getProperty('WEBHOOK_SECRET')!, '{');
    expect(h.api).not.toHaveBeenCalled();
    expect(h.store.read()?.seen).toEqual([]);
    expect(h.ports.log).toHaveBeenCalledWith('webhook_rejected');
  });
  it('denies unauthorized private commands/callbacks and rejects group configuration', () => {
    const h = harness();
    h.command('/off', 99); h.callback('remove:a:42', 99);
    h.command('/off', 42, 'group'); h.callback('remove:a:42', 42, 'group');
    expect(h.store.read()?.enabled).toBe(true);
    expect(h.store.read()?.confirmations).toEqual({});
    expect(h.api.mock.calls.filter(([method]) => method === 'answerCallbackQuery')).toHaveLength(2);
  });
  it('deduplicates mapping mutations and replies', () => {
    const h = harness();
    h.command('/addmapping @news user@example.com', 42, 'private', 100);
    h.command('/addmapping @news user@example.com', 42, 'private', 100);
    expect(h.store.read()?.mappings).toHaveLength(1);
    expect(h.api.mock.calls.filter(([method]) => method === 'sendMessage')).toHaveLength(1);
  });
});

describe('configuration', () => {
  it('resolves channel usernames and preserves identical mappings independently', () => {
    const h = harness();
    h.command('/addmapping @news user@example.com'); h.command('/addmapping @news user@example.com');
    const mappings = h.store.read()!.mappings;
    expect(mappings).toHaveLength(2);
    expect(mappings[0].id).not.toBe(mappings[1].id);
    expect(mappings[0].channelId).toBe('-10012345');
    h.command(`/removemapping ${mappings[0].id}`);
    h.callback(h.lastReply()!.reply_markup!.inline_keyboard[0][0].callback_data);
    expect(h.store.read()?.mappings).toEqual([mappings[1]]);
  });
  it('rejects inaccessible channels, non-channels, and multiple email recipients', () => {
    const h = harness();
    h.command('/addmapping @news a@example.com,b@example.com');
    expect(h.lastReply()?.text).toContain('valid recipient');
    h.api.mockImplementation((method) => method === 'getChat' ? { id: -12, type: 'group' } : { id: 123 });
    h.command('/addmapping @news a@example.com');
    expect(h.lastReply()?.text).toContain('must be a Telegram channel');
    h.api.mockImplementation((method) => method === 'getChat' ? { id: -10012345, type: 'channel' } : method === 'getChatMember' ? { status: 'left' } : { id: 123 });
    h.command('/addmapping -10012345 a@example.com');
    expect(h.lastReply()?.text).toContain('Add the bot');
    expect(h.store.read()?.mappings).toHaveLength(0);
  });
  it('discovers channel membership and posts even when off', () => {
    const h = harness(); h.command('/off'); h.post('ignored');
    h.sendUpdate({ my_chat_member: { chat: { id: -100999, type: 'channel', title: 'Private' }, new_chat_member: { status: 'left' } } });
    expect(h.store.read()?.channels).toHaveLength(2);
    expect(h.store.read()?.channels[1].accessible).toBe(false);
    expect(h.store.read()?.batches).toHaveLength(0);
  });
  it('paginates mapping and channel lists and exposes channel command usage', () => {
    const h = harness();
    for (let i = 0; i < 6; i++) h.command(`/addmapping @news user${i}@example.com`);
    h.command('/mappings');
    expect(h.lastReply()?.text).toContain('(1/2)');
    h.callback('page:m:1');
    expect(h.lastReply()?.text).toContain('user5@example.com');
    h.command('/channels'); h.callback('channel:-10012345');
    expect(h.lastReply()?.text).toContain('/addmapping -10012345');
  });
  it('requires confirmation, supports cancellation/expiry, and rejects stale removals', () => {
    const h = harness(); h.command('/addmapping @news user@example.com');
    const mapping = h.store.read()!.mappings[0];
    h.command(`/removemapping ${mapping.id}`);
    const first = h.lastReply()!.reply_markup!.inline_keyboard[0][0].callback_data;
    h.command('/cancel'); h.callback(first);
    expect(h.store.read()?.mappings).toHaveLength(1);
    h.command(`/removemapping ${mapping.id}`);
    const second = h.lastReply()!.reply_markup!.inline_keyboard[0][0].callback_data;
    h.setTime(300_001); h.callback(second);
    expect(h.store.read()?.mappings).toHaveLength(1);
    h.command(`/removemapping ${mapping.id}`);
    const third = h.lastReply()!.reply_markup!.inline_keyboard[0][0].callback_data;
    h.mutate(s => { s.mappings = []; }); h.callback(third);
    expect(h.lastReply()?.text).toContain('no longer exists');
  });
  it('protects the last admin at confirmation time and rechecks authorization', () => {
    const h = harness(); h.command('/removeadmin 42');
    expect(h.lastReply()?.text).toContain('last admin');
    h.command('/addadmin 43'); h.command('/removeadmin 43');
    const callback = h.lastReply()!.reply_markup!.inline_keyboard[0][0].callback_data;
    h.mutate(s => { s.admins = ['43']; });
    h.callback(callback, 42);
    expect(h.store.read()?.admins).toEqual(['43']);
    h.command('/removeadmin 43', 43);
    expect(h.lastReply()?.text).toContain('last admin');
  });
  it('reports a failed save without reporting success or changing configuration', () => {
    const h = harness(); h.properties.failWrite = true;
    h.command('/off');
    expect(h.lastReply()?.text).toContain('Could not save');
    expect(h.store.read()?.enabled).toBe(true);
  });
});

describe('batching and delivery', () => {
  it('groups a burst, handles the exact boundary, and deduplicates posts', () => {
    const h = harness(); h.command('/addmapping @news user@example.com');
    h.post('first', {}, 100); h.post('first', {}, 100);
    h.setTime(59_999); h.post('second'); h.bot.flush();
    expect(h.emails).toHaveLength(0);
    h.setTime(60_000); h.post('next batch');
    expect(h.store.read()?.batches.map(b => b.posts.length)).toEqual([2, 1]);
    h.bot.flush();
    expect(h.emails).toHaveLength(1);
    expect(h.emails[0].text).toContain('first'); expect(h.emails[0].text).toContain('second');
    expect(h.emails[0].text).not.toContain('next batch');
    h.setTime(120_000); h.bot.flush(); expect(h.emails).toHaveLength(2);
  });
  it('applies current mappings, sends duplicates independently, and isolates recipient failures', () => {
    const h = harness(); h.command('/addmapping @news old@example.com'); h.post('queued');
    h.mutate(s => { s.mappings = [{ id: 'a', channelId: '-10012345', recipient: 'new@example.com' }, { id: 'b', channelId: '-10012345', recipient: 'new@example.com' }]; });
    vi.mocked(h.ports.send).mockImplementationOnce(() => { throw new Error('email failure'); });
    h.setTime(60_000); h.bot.flush(); h.bot.flush();
    expect(h.ports.send).toHaveBeenCalledTimes(2);
    expect(h.emails).toHaveLength(1); expect(h.emails[0].to).toBe('new@example.com');
    expect(h.store.read()?.batches).toHaveLength(0);
    expect(h.ports.log).toHaveBeenCalledWith('email_failed', expect.objectContaining({ mappingId: 'a' }));
  });
  it('clears pending content when disabled and ignores edits/service messages', () => {
    const h = harness(); h.command('/addmapping @news user@example.com'); h.post('queued');
    h.command('/off'); h.post('off'); h.command('/on');
    h.post('', { new_chat_title: 'Renamed' });
    h.bot.receive(h.properties.getProperty('WEBHOOK_SECRET')!, JSON.stringify({ update_id: 500, edited_channel_post: { text: 'edit' } }));
    h.setTime(60_000); h.bot.flush();
    expect(h.emails).toHaveLength(0); expect(h.store.read()?.batches).toHaveLength(0);
  });
  it('a second worker cannot claim a batch while the first sends it', () => {
    const h = harness(); h.command('/addmapping @news user@example.com'); h.post('queued');
    vi.mocked(h.ports.send).mockImplementationOnce(email => { h.bot.flush(); h.emails.push(email); });
    h.setTime(60_000); h.bot.flush();
    expect(h.emails).toHaveLength(1);
  });
  it('keeps posts received during an active send and does not recall a claimed batch on off', () => {
    const h = harness(); h.command('/addmapping @news user@example.com'); h.post('first');
    vi.mocked(h.ports.send).mockImplementationOnce(email => { h.post('arrived during send'); h.emails.push(email); });
    h.setTime(60_000); h.bot.flush();
    expect(h.store.read()?.batches[0].posts[0].text).toBe('arrived during send');
    vi.mocked(h.ports.send).mockImplementationOnce(email => { h.command('/off'); h.emails.push(email); });
    h.setTime(120_000); h.bot.flush();
    expect(h.emails).toHaveLength(2); expect(h.store.read()?.enabled).toBe(false);
  });
  it('bounds deduplication state', () => {
    const h = harness();
    for (let i = 0; i < 260; i++) h.post('unmapped');
    expect(h.store.read()?.seen).toHaveLength(256);
  });
});
