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
    expect(h.emails[0].attachments.map(a => a.name)).toEqual(['report.pdf']);
    expect(h.emails[0].inlineImages.photo_1_1.name).toBe('photo-1.jpg');
    expect(h.emails[0].html).toContain('src="cid:photo_1_1"');
    expect(h.emails[0].text).toContain('caption'); expect(h.emails[0].text).toContain('Jan 1, 1970, 12:00 AM UTC');
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
    h.emails.forEach((email, i) => {
      expect(email.subject).toMatch(new RegExp(`\\(${i + 1}/${h.emails.length}\\) in`));
      expect(email.subject.length).toBeLessThanOrEqual(200);
    });
  });
});

describe('email presentation', () => {
  function send(posts: Post[]) {
    const h = harness();
    deliver({ id: 'batch', channelId: '-10012345', openedAt: 0, posts }, [{ id: 'm', recipient: 'a@example.com' }], h.ports);
    return h;
  }

  it('uses the first nonempty line in message-ID order and handles captions', () => {
    const later = post('Later post'); later.messageId = 20;
    const earlier = post('\r\n \n First line\r\nSecond line'); earlier.messageId = 10;
    const h = send([later, earlier]);
    expect(h.emails[0].subject).toBe('First line — 2 posts in News');
    const caption = normalize({ message_id: 1, date: 10, chat: { id: -10012345, type: 'channel', title: 'News' }, caption: 'Caption line\nmore', document: { file_id: 'doc' } }, 3)!;
    expect(send([post(''), caption]).emails[0].subject).toBe('Caption line — 2 posts in News');
  });

  it('falls back to the count for textless batches and removes controls', () => {
    const p = post(''); p.omissions = ['Omitted video'];
    expect(send([p]).emails[0].subject).toBe('News — 1 post');
    p.text = 'First\u0000line\tpreview'; p.channel.title = 'N\r\news';
    const subject = send([p]).emails[0].subject;
    expect(subject).toBe('First line preview — 1 post in N ews');
    expect(subject).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it('truncates long names and previews with ellipses without broken emoji', () => {
    const p = post('😀'.repeat(200)); p.channel.title = '😀'.repeat(100);
    const subject = send([p]).emails[0].subject;
    expect(subject.length).toBeLessThanOrEqual(200);
    expect(subject).toContain('… — ');
    expect(subject).toMatch(/…$/);
    // Removing intact surrogate pairs must leave no orphan surrogate halves.
    expect(subject.replace(/\ud83d\ude00/g, '')).not.toMatch(/[\ud800-\udfff]/);
  });

  it('uses the injected readable timestamp in both bodies and removes horizontal separators', () => {
    const h = send([post('one'), post('two')]);
    expect(h.ports.formatTimestamp).toHaveBeenCalledWith(10);
    expect(h.emails[0].html).toContain('Jan 1, 1970, 12:00 AM UTC');
    expect(h.emails[0].text).toContain('Jan 1, 1970, 12:00 AM UTC');
    expect(h.emails[0].html).not.toContain('<hr>');
    expect(h.emails[0].text).not.toContain('\n---\n');
    expect(h.emails[0].html.match(/View source post/g)).toHaveLength(2);
  });
});

describe('inline photo delivery', () => {
  function photo(id: number, text = 'Caption', size = 100): Post {
    const p = post(text); p.messageId = id; p.updateId = id;
    p.file = { kind: 'photo', file_id: `photo-${id}`, file_name: `photo-${id}.jpg`, file_size: size };
    return p;
  }
  function send(posts: Post[], recipients = [{ id: 'm', recipient: 'a@example.com' }]) {
    const h = harness();
    deliver({ id: 'batch', channelId: '-10012345', openedAt: 0, posts }, recipients, h.ports);
    return h;
  }
  function verifyCidReferences(email: ReturnType<typeof harness>['emails'][number]) {
    const references = [...email.html.matchAll(/src="cid:([^"]+)"/g)].map(match => match[1]);
    expect(references.sort()).toEqual(Object.keys(email.inlineImages).sort());
  }

  it('renders photos in place while image documents remain attachments, reusing downloads across recipients', () => {
    const first = photo(1), second = photo(2);
    const doc = post('Image as file'); doc.messageId = 3;
    doc.file = { kind: 'document', file_id: 'image-doc', file_name: 'image.png', mime_type: 'image/png', file_size: 100 };
    const h = send([first, second, doc], [{ id: 'm', recipient: 'a@example.com' }, { id: 'm2', recipient: 'b@example.com' }]);
    expect(h.ports.download).toHaveBeenCalledTimes(3);
    expect(h.emails).toHaveLength(2);
    for (const email of h.emails) {
      verifyCidReferences(email);
      expect(Object.keys(email.inlineImages)).toHaveLength(2);
      expect(email.attachments.map(a => a.name)).toEqual(['image.png']);
      expect(email.html.indexOf('Caption')).toBeLessThan(email.html.indexOf('cid:photo_1_1'));
      expect(email.html.indexOf('cid:photo_1_1')).toBeLessThan(email.html.indexOf('View source post'));
      expect(email.html).toContain('max-width:100%;height:auto');
      expect(email.text).toContain('Photo: photo-1.jpg');
    }
  });

  it('shares bytes and file counts between inline images and attachments', () => {
    const doc = post('File'); doc.file = { kind: 'document', file_id: 'doc', file_size: 15 * 1024 * 1024 };
    const h = send([photo(1, '', 10 * 1024 * 1024), doc]);
    expect(h.emails[0].attachments).toHaveLength(0);
    expect(h.emails[0].text).toContain('exceeds the download or email attachment budget');
    const photos = Array.from({ length: 250 }, (_, i) => photo(i + 1, '', 1));
    const finalDoc = post('File'); finalDoc.messageId = 251; finalDoc.file = { kind: 'document', file_id: 'doc', file_size: 1 };
    const countLimited = send([...photos, finalDoc]);
    expect(Object.keys(countLimited.emails[0].inlineImages)).toHaveLength(250);
    expect(countLimited.emails[0].text).toContain('email attachment count limit reached');
  });

  it('omits oversized and unavailable photos without creating missing CID references', () => {
    const h = harness();
    vi.mocked(h.ports.download).mockImplementation(() => { throw new Error('Unavailable'); });
    deliver({ id: 'batch', channelId: '-10012345', openedAt: 0, posts: [photo(1, 'Large', FILE_BUDGET + 1), photo(2, 'Failed')] }, [{ id: 'm', recipient: 'a@example.com' }], h.ports);
    expect(h.emails[0].inlineImages).toEqual({});
    expect(h.emails[0].html).not.toContain('src="cid:');
    expect(h.emails[0].text).toContain('Omitted attachment');
    expect(h.emails[0].text).toContain('download unavailable');
  });

  it('keeps photos with their references when batches split at post boundaries', () => {
    const photos = Array.from({ length: 15 }, (_, i) => photo(i + 1, '<'.repeat(4096)));
    const h = send(photos);
    expect(h.emails.length).toBeGreaterThan(1);
    h.emails.forEach(verifyCidReferences);
    expect(h.emails.reduce((sum, email) => sum + Object.keys(email.inlineImages).length, 0)).toBe(15);
  });

  it('preserves the inline image in oversized single-post text fallback', () => {
    const p = photo(1, '<'.repeat(60_000));
    const h = send([p]);
    expect(h.emails.length).toBeGreaterThan(1);
    expect(h.emails[0].inlineImages).toHaveProperty('photo_1_1');
    expect(h.emails.slice(1).every(email => !Object.keys(email.inlineImages).length)).toBe(true);
    h.emails.forEach(verifyCidReferences);
    expect(h.emails.every(email => byteLength(email.html) < 200 * 1024)).toBe(true);
    expect(h.emails.map(email => email.text).join('')).toContain(p.text);
  });
});
