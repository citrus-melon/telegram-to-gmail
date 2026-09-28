import { describe, expect, it, vi } from 'vitest';
import { deliver, FILE_BUDGET, formatted, normalize, sourceLink } from '../src/forwarding';
import { byteLength } from '../src/storage';
import type { Post } from '../src/types';
import { harness } from './harness';

function post(text = 'Hello'): Post {
  return { updateId: 1, messageId: 7, channel: { id: '-10012345', title: 'News', accessible: true }, date: 10, text, entities: [], omissions: [] };
}

describe('rich text and sources', () => {
  it('escapes unformatted text and respects UTF-16 entity offsets with emoji', () => {
    const h = harness();
    expect(formatted(post('<script>alert("x")</script>'), h.ports)).toContain('&lt;script&gt;');
    const p = post('😀 bold'); p.entities = [{ type: 'bold', offset: 3, length: 4 }];
    expect(formatted(p, h.ports)).toBe('😀 <b>bold</b>');
  });
  it('supports nested formatting, captions, and malformed-entity fallback', () => {
    const h = harness(); const p = post('hello');
    p.entities = [{ type: 'bold', offset: 0, length: 5 }, { type: 'italic', offset: 1, length: 3 }];
    expect(formatted(p, h.ports)).toBe('<b>h<i>ell</i>o</b>');
    p.entities = [{ type: 'bold', offset: 0, length: 99 }];
    expect(formatted(p, h.ports)).toBe('hello');
    p.entities = [{ type: 'bold', offset: 0, length: 3 }, { type: 'italic', offset: 2, length: 3 }];
    expect(formatted(p, h.ports)).toBe('hello');
    const caption = normalize({ message_id: 1, date: 10, chat: { id: -10012345, type: 'channel' }, caption: 'bold', caption_entities: [{ type: 'bold', offset: 0, length: 4 }], document: { file_id: 'doc' } }, 2)!;
    expect(formatted(caption, h.ports)).toBe('<b>bold</b>');
  });
  it('rejects unsafe schemes and escapes link attributes and code languages', () => {
    const h = harness(); const p = post('link');
    p.entities = [{ type: 'text_link', offset: 0, length: 4, url: 'javascript:alert(1)' }];
    expect(formatted(p, h.ports)).toBe('link');
    p.entities[0].url = 'https://example.com/"/><img/src=x/onerror=alert(1)>';
    const html = formatted(p, h.ports);
    expect(html).toContain('&quot;'); expect(html).not.toContain('<img');
    p.entities = [{ type: 'pre', offset: 0, length: 4, language: '"><img src=x>' }];
    expect(formatted(p, h.ports)).toBe('<pre>link</pre>');
  });
  it('constructs public and private source links', () => {
    const p = post(); expect(sourceLink(p)).toBe('https://t.me/c/12345/7');
    p.channel.username = 'news'; expect(sourceLink(p)).toBe('https://t.me/news/7');
  });
});

describe('attachments and email bodies', () => {
  it('selects the largest photo and preserves document filenames', () => {
    const p = normalize({ message_id: 1, date: 10, chat: { id: -10012345, type: 'channel' }, photo: [{ file_id: 'small', width: 10, height: 10 }, { file_id: 'large', width: 100, height: 100 }] }, 1)!;
    expect(p.file?.file_id).toBe('large');
    const h = harness(); const doc = post('caption'); doc.file = { kind: 'document', file_id: 'doc', file_name: 'report.pdf', file_size: 10 };
    deliver({ id: 'batch', channelId: '-10012345', openedAt: 0, posts: [p, doc] }, [{ id: 'm', recipient: 'a@example.com' }], h.ports);
    expect(h.emails[0].attachments.map(a => a.name)).toEqual(['photo-1.jpg', 'report.pdf']);
    expect(h.emails[0].text).toContain('caption'); expect(h.emails[0].text).toContain('1970-01-01T00:00:10.000Z');
  });
  it('preserves text with explicit unsupported/oversized/download-failure notices', () => {
    const h = harness();
    const p = normalize({ message_id: 1, date: 10, chat: { id: -10012345, type: 'channel' }, text: 'important', video: { file_id: 'video' } }, 1)!;
    const oversized = post('large'); oversized.file = { kind: 'document', file_id: 'large', file_name: 'large.zip', file_size: FILE_BUDGET + 1 };
    const missing = post('unavailable'); missing.file = { kind: 'document', file_id: 'missing', file_name: 'missing.pdf' };
    vi.mocked(h.ports.download).mockImplementation(() => { throw new Error('token-bearing error'); });
    deliver({ id: 'batch', channelId: '-10012345', openedAt: 0, posts: [p, oversized, missing] }, [{ id: 'm', recipient: 'a@example.com' }], h.ports);
    expect(h.emails[0].text).toContain('important'); expect(h.emails[0].text).toContain('Omitted video');
    expect(h.emails[0].text).toContain('large.zip: exceeds'); expect(h.emails[0].text).toContain('missing.pdf: download unavailable');
    expect(h.emails[0].text).not.toContain('token-bearing');
    expect(h.ports.download).toHaveBeenCalledTimes(1);
  });
  it('honors the aggregate attachment budget and detects actual oversized downloads', () => {
    const h = harness();
    const posts = [post('first'), post('second'), post('third')];
    posts.forEach((p, i) => { p.file = { kind: 'document', file_id: `doc${i}`, file_size: i === 2 ? undefined : 15 * 1024 * 1024 }; });
    vi.mocked(h.ports.download).mockImplementation((file, name) => ({ name, size: file.file_size ?? FILE_BUDGET + 1, blob: {} as GoogleAppsScript.Base.Blob }));
    deliver({ id: 'batch', channelId: '-10012345', openedAt: 0, posts }, [{ id: 'm', recipient: 'a@example.com' }], h.ports);
    expect(h.emails[0].attachments).toHaveLength(1);
    expect(h.emails[0].text.match(/Omitted attachment/g)).toHaveLength(2);
  });
  it('splits long batches within email body limits and preserves all text', () => {
    const h = harness(); const posts = Array.from({ length: 50 }, (_, i) => post(`${i}:` + '<'.repeat(4096)));
    deliver({ id: 'batch', channelId: '-10012345', openedAt: 0, posts }, [{ id: 'm', recipient: 'a@example.com' }], h.ports);
    expect(h.emails.length).toBeGreaterThan(1);
    expect(h.emails.every(email => byteLength(email.html) < 200 * 1024 && byteLength(email.text) < 200 * 1024)).toBe(true);
    const combined = h.emails.map(e => e.text).join('\n');
    for (const p of posts) expect(combined).toContain(p.text);
  });
});
