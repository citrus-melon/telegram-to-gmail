import { afterEach, describe, expect, it, vi } from 'vitest';
import { doPost, flushPending, recoverAdmin, setup, webhookStatus } from '../src/runtime';
import { harness } from './harness';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function install() {
  const h = harness();
  const fetch = vi.fn((url: string) => {
    if (url.endsWith('/getMe')) return response({ ok: true, result: { id: 123 } });
    if (url.endsWith('/getWebhookInfo')) return response({ ok: true, result: { url: 'SECRET URL', pending_update_count: 0, last_error_date: 1, last_error_message: 'SECRET ERROR' } });
    return response({ ok: true, result: true });
  });
  type Trigger = { getHandlerFunction(): string; getUniqueId(): string };
  const trigger = (id: string, handler = 'flushPending'): Trigger => ({ getHandlerFunction: () => handler, getUniqueId: () => id });
  const triggers: Trigger[] = [trigger('orphan-1'), trigger('orphan-2'), trigger('other', 'unrelated')];
  let serial = 0;
  const create = vi.fn(() => { const t = trigger(`new-${++serial}`); triggers.push(t); return t; });
  const after = vi.fn((_delay: number) => ({ create }));
  vi.stubGlobal('PropertiesService', { getScriptProperties: () => h.properties });
  vi.stubGlobal('LockService', { getScriptLock: () => ({ waitLock: vi.fn(), releaseLock: vi.fn() }) });
  const formatDate = vi.fn(() => 'Sep 28, 2026, 2:30 PM PDT');
  vi.stubGlobal('Utilities', { getUuid: h.ports.uuid, formatDate });
  vi.stubGlobal('Session', { getScriptTimeZone: () => 'America/Los_Angeles' });
  vi.stubGlobal('UrlFetchApp', { fetch });
  vi.stubGlobal('MailApp', { sendEmail: vi.fn() });
  vi.stubGlobal('ScriptApp', {
    getProjectTriggers: () => [...triggers],
    deleteTrigger: (t: Trigger) => triggers.splice(triggers.indexOf(t), 1),
    newTrigger: vi.fn(() => ({ timeBased: () => ({ after }) })),
  });
  const htmlOutput = { html: 'OK' };
  const createHtmlOutput = vi.fn(() => htmlOutput);
  vi.stubGlobal('HtmlService', { createHtmlOutput });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  return { h, fetch, triggers, create, after, htmlOutput, createHtmlOutput, log, formatDate };
}

function response(data: unknown, status = 200) {
  return { getResponseCode: () => status, getContentText: () => JSON.stringify(data) };
}

describe('Apps Script runtime adapters', () => {
  it('preserves Unicode from webhook JSON through stored state to MailApp', () => {
    const r = install(); r.h.command('/addmapping @news a@example.com');
    const text = 'Unicode 🥺';
    const title = 'News 🎉 漢字';
    doPost({
      parameter: { secret: r.h.properties.getProperty('WEBHOOK_SECRET')! },
      postData: { contents: JSON.stringify({ update_id: 20, channel_post: {
        message_id: 20, date: 10, chat: { id: -10012345, type: 'channel', title }, text,
        entities: [{ type: 'bold', offset: 8, length: 2 }],
      } }) },
    } as unknown as GoogleAppsScript.Events.DoPost);
    expect(r.h.store.read()!.batches[0].posts[0].text).toBe(text);
    r.h.mutate(s => { s.batches[0].openedAt = Date.now() - 120_000; });
    flushPending();
    expect(MailApp.sendEmail).toHaveBeenCalledExactlyOnceWith(
      'a@example.com', `${text} — 1 post in ${title}`,
      expect.stringContaining(text), expect.objectContaining({ htmlBody: expect.stringContaining('Unicode <b>🥺</b>') }),
    );
  });
  it('setup clears abandoned flush triggers without scheduling idle work and preserves unrelated triggers', () => {
    const r = install(); setup(); setup();
    expect(r.triggers.filter(t => t.getHandlerFunction() === 'flushPending')).toHaveLength(0);
    expect(r.triggers.filter(t => t.getHandlerFunction() === 'unrelated')).toHaveLength(1);
    expect(r.after).not.toHaveBeenCalled();
    expect(r.fetch).toHaveBeenCalledWith(expect.stringContaining('/setWebhook'), expect.objectContaining({ method: 'post' }));
  });
  it('schedules one-shot work from a webhook and consumes its trigger ID on flush', () => {
    const r = install(); setup(); r.h.command('/addmapping @news a@example.com');
    const send = (id: number) => doPost({ parameter: { secret: r.h.properties.getProperty('WEBHOOK_SECRET')! }, postData: { contents: JSON.stringify({ update_id: id, channel_post: { message_id: id, date: 10, chat: { id: -10012345, type: 'channel', title: 'News' }, text: 'Post' } }) } } as unknown as GoogleAppsScript.Events.DoPost);
    send(20); send(21);
    expect(r.create).toHaveBeenCalledTimes(1);
    expect(r.after.mock.calls[0][0]).toBeGreaterThan(59_000);
    const id = r.triggers.find(t => t.getHandlerFunction() === 'flushPending')!.getUniqueId();
    r.h.mutate(s => { s.batches[0].openedAt = Date.now() - 120_000; });
    flushPending({ triggerUid: id });
    expect(MailApp.sendEmail).toHaveBeenCalledTimes(1);
    expect(r.triggers.filter(t => t.getHandlerFunction() === 'flushPending')).toHaveLength(0);
    expect(r.h.properties.getProperty('FLUSH_SCHEDULE')).toBeNull();
  });
  it('returns a direct HTML acknowledgment and rejects invalid secrets without outgoing requests', () => {
    const r = install();
    const output = doPost({ parameter: { secret: 'bad' }, postData: { contents: '{' } } as unknown as GoogleAppsScript.Events.DoPost);
    expect(output).toBe(r.htmlOutput);
    expect(r.createHtmlOutput).toHaveBeenCalledWith('OK');
    expect(r.fetch).not.toHaveBeenCalled();
  });
  it('sanitizes Telegram exceptions and webhook status logs', () => {
    const r = install(); webhookStatus();
    expect(r.log.mock.calls.flat().join(' ')).not.toContain('SECRET');
    r.fetch.mockImplementation(() => { throw new Error('https://api.telegram.org/botSECRET/getMe'); });
    expect(() => setup()).toThrow('Telegram getMe failed');
    try { setup(); } catch (error) { expect(String(error)).not.toContain('botSECRET'); }
  });
  it('sends email through the runtime and exposes recovery', () => {
    const r = install(); r.h.command('/addmapping @news a@example.com');
    r.h.post('hello');
    r.h.mutate(s => { s.batches[0].openedAt = Date.now() - 120_000; });
    flushPending();
    expect(MailApp.sendEmail).toHaveBeenCalledWith('a@example.com', expect.any(String), expect.stringContaining('hello'), expect.objectContaining({ htmlBody: expect.stringContaining('View source post') }));
    expect(r.formatDate).toHaveBeenCalledWith(new Date(10_000), 'America/Los_Angeles', 'MMM d, yyyy, h:mm a z');
    expect(MailApp.sendEmail).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.stringContaining('Sep 28, 2026, 2:30 PM PDT'), expect.objectContaining({ htmlBody: expect.stringContaining('Sep 28, 2026, 2:30 PM PDT') }));
    r.h.mutate(s => { s.admins = ['43']; }); recoverAdmin();
    expect(r.h.store.read()?.admins).toEqual(['43', '42']);
  });
  it('downloads metadata-only attachments during flush and conceals download failures', () => {
    const r = install(); r.h.command('/addmapping @news a@example.com');
    r.h.post('caption', { document: { file_id: 'doc', file_name: 'report.pdf' } });
    r.h.mutate(s => { s.batches[0].openedAt = Date.now() - 120_000; });
    const blob = { setName: vi.fn(), setContentType: vi.fn(), getBytes: () => [1, 2, 3] };
    blob.setName.mockReturnValue(blob);
    r.fetch.mockImplementation((url) => {
      if (url.endsWith('/getFile')) return response({ ok: true, result: { file_path: 'documents/file.pdf', file_size: 3 } });
      if (url.includes('/file/bot')) return { getResponseCode: () => 200, getBlob: () => blob } as unknown as ReturnType<typeof response>;
      return response({ ok: true, result: true });
    });
    flushPending();
    expect(blob.setName).toHaveBeenCalledWith('report.pdf');
    expect(MailApp.sendEmail).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(String), expect.objectContaining({ attachments: [blob] }));
    expect(r.log.mock.calls.flat().join(' ')).not.toContain('123:token');
  });
  it('passes photos as inlineImages to MailApp without ordinary attachments', () => {
    const r = install(); r.h.command('/addmapping @news a@example.com');
    r.h.post('Photo caption', { photo: [{ file_id: 'photo', file_size: 3, width: 100, height: 100 }] });
    r.h.mutate(s => { s.batches[0].openedAt = Date.now() - 120_000; });
    const blob = { setName: vi.fn(), getBytes: () => [1, 2, 3] };
    blob.setName.mockReturnValue(blob);
    r.fetch.mockImplementation(url => {
      if (url.endsWith('/getFile')) return response({ ok: true, result: { file_path: 'photos/file.jpg', file_size: 3 } });
      if (url.includes('/file/bot')) return { getResponseCode: () => 200, getBlob: () => blob } as unknown as ReturnType<typeof response>;
      return response({ ok: true, result: true });
    });
    flushPending();
    expect(MailApp.sendEmail).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('Photo caption'), expect.any(String), expect.objectContaining({
      attachments: [], inlineImages: { photo_2_2: blob }, htmlBody: expect.stringContaining('src="cid:photo_2_2"'),
    }));
  });
});
