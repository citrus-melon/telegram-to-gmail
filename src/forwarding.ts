import { serialiseWith } from '@telegraf/entity';
import { byteLength } from './storage';
import type { Attachment, Batch, Channel, Email, Message, Ports, Post } from './types';

export const FILE_BUDGET = 20 * 1024 * 1024;
const BODY_BUDGET = 180 * 1024;
export const WINDOW_MS = 60_000;

export function channelFrom(chat: Message['chat'], accessible = true): Channel {
  return { id: String(chat.id), title: chat.title || chat.username || String(chat.id), username: chat.username, accessible };
}

export function normalize(message: Message, updateId: number): Post | null {
  const text = message.text ?? message.caption ?? '';
  const supported = message.photo?.length || message.document;
  const unsupported = ['video', 'animation', 'audio', 'voice', 'video_note', 'sticker', 'contact', 'location', 'venue', 'poll', 'dice', 'paid_media', 'story', 'live_photo', 'rich_message'];
  const omissions = unsupported.filter(kind => message[kind] != null).map(kind => `Omitted ${kind.replace(/_/g, ' ')}: unsupported content type.`);
  if (!text && !supported && !omissions.length) return null;
  if (!Number.isSafeInteger(message.date) || message.date < 0 || message.date > 8_640_000_000_000) return null;
  let file: Post['file'];
  if (message.photo?.length) {
    const best = [...message.photo].sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)) || (b.file_size || 0) - (a.file_size || 0))[0];
    file = { ...best, kind: 'photo', file_name: `photo-${message.message_id}.jpg` };
  } else if (message.document) file = { ...message.document, kind: 'document' };
  return {
    updateId, messageId: message.message_id, channel: channelFrom(message.chat), date: message.date,
    text, entities: message.text !== undefined ? message.entities || [] : message.caption_entities || [], file, omissions,
  };
}

export function sourceLink(post: Post): string {
  if (post.channel.username && /^[a-zA-Z0-9_]+$/.test(post.channel.username)) return `https://t.me/${post.channel.username}/${post.messageId}`;
  if (/^-100\d+$/.test(post.channel.id)) return `https://t.me/c/${post.channel.id.slice(4)}/${post.messageId}`;
  return 'Source link unavailable for this channel.';
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeLink(url: string): boolean { return /^(https?:\/\/|mailto:)[^\s\u0000-\u001f]+$/i.test(url); }

const emailHtml = serialiseWith((match, node) => {
  // @telegraf/entity calls the serializer directly with RAW text when there are no entities.
  if (!node) return escapeHtml(match);
  const tags: Record<string, string> = { bold: 'b', italic: 'i', underline: 'u', strikethrough: 'del', code: 'code', pre: 'pre', blockquote: 'blockquote', expandable_blockquote: 'blockquote' };
  const tag = tags[node.type];
  if (tag) return `<${tag}>${match}</${tag}>`;
  const href = node.type === 'text_link' ? node.url : node.type === 'url' ? node.text : node.type === 'email' ? `mailto:${node.text}` : undefined;
  if (href && safeLink(href)) return `<a href="${escapeHtml(href)}">${match}</a>`;
  return match;
}, escapeHtml);

export function formatted(post: Post, ports: Pick<Ports, 'log'>): string {
  try {
    if (post.entities.some(e => !Number.isInteger(e.offset) || !Number.isInteger(e.length) || e.offset < 0 || e.length < 0 || e.offset + e.length > post.text.length)) throw new Error('Invalid entity');
    const entities = post.entities.filter(e => {
      if (e.type === 'text_link') return !!e.url && safeLink(e.url);
      if (e.type === 'url') return safeLink(post.text.slice(e.offset, e.offset + e.length));
      return !['text_mention', 'custom_emoji', 'phone_number'].includes(e.type);
    });
    const sorted = [...entities].sort((a, b) => a.offset - b.offset || b.length - a.length);
    const ends: number[] = [];
    for (const entity of sorted) {
      while (ends.length && entity.offset >= ends[ends.length - 1]) ends.pop();
      if (ends.length && entity.offset + entity.length > ends[ends.length - 1]) throw new Error('Crossing entities');
      if (ends.length > 100) throw new Error('Excessive nesting');
      ends.push(entity.offset + entity.length);
    }
    return emailHtml({ text: post.text, entities: sorted } as unknown as Parameters<typeof emailHtml>[0]).replace(/\n/g, '<br>');
  } catch {
    ports.log('formatting_fallback', { updateId: post.updateId });
    return escapeHtml(post.text).replace(/\n/g, '<br>');
  }
}

interface Part { text: string; html: string; attachments: Attachment[]; inlineImages: Record<string, Attachment> }

function files(part: Part): Attachment[] { return [...part.attachments, ...Object.values(part.inlineImages)]; }
function imageHtml(images: Part['inlineImages']): string {
  return Object.entries(images).map(([key, image]) => `<div><img src="cid:${key}" alt="${escapeHtml(image.name)}" style="max-width:100%;height:auto"></div>`).join('');
}

function subjectText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
}
function truncate(text: string, limit: number): string {
  // Use code points to avoid splitting surrogate pairs; also keep the UTF-16 length within the limit.
  if (text.length <= limit) return text;
  let result = '';
  for (const char of text) {
    if (result.length + char.length > limit - 1) break;
    result += char;
  }
  return result + '…';
}

function subject(posts: Post[], part: number, total: number): string {
  const channel = truncate(subjectText(posts[0]?.channel.title || 'Telegram') || 'Telegram', 60);
  const line = posts.flatMap(post => post.text.split(/\r\n|[\n\r\u2028\u2029]/)).map(subjectText).find(Boolean);
  const count = `${posts.length} post${posts.length === 1 ? '' : 's'}`;
  const suffix = total > 1 ? ` (${part}/${total})` : '';
  if (!line) return `${channel} — ${count}${suffix}`;
  const ending = `${count}${suffix} in ${channel}`;
  return `${truncate(line, 200 - channel.length - 3 - ending.length)} — ${ending}`;
}

function renderPost(post: Post, ports: Ports, remainingBytes: number, remainingSlots: number): Part {
  const notices = [...post.omissions];
  const attachments: Attachment[] = [];
  const inlineImages: Part['inlineImages'] = {};
  const file = post.file;
  if (file) {
    const name = (file.file_name || `document-${post.messageId}`).replace(/[\r\n\u0000]/g, '_');
    if (remainingSlots <= 0) {
      notices.push(`Omitted attachment ${name}: email attachment count limit reached.`);
    } else if (file.file_size !== undefined && file.file_size > remainingBytes) {
      notices.push(`Omitted attachment ${name}: exceeds the download or email attachment budget.`);
    } else {
      try {
        const attachment = ports.download(file, name);
        if (attachment.size > remainingBytes || attachment.size > FILE_BUDGET) notices.push(`Omitted attachment ${name}: exceeds the download or email attachment budget.`);
        else if (file.kind === 'photo') inlineImages[`photo_${post.updateId}_${post.messageId}`] = attachment;
        else attachments.push(attachment);
      } catch {
        notices.push(`Omitted attachment ${name}: download unavailable.`);
      }
    }
  }
  if (notices.length) ports.log('content_omitted', { updateId: post.updateId, count: notices.length });
  const timestamp = ports.formatTimestamp(post.date);
  const footer = `${post.channel.title} · ${timestamp}\n${sourceLink(post)}`;
  const photoDescriptions = Object.values(inlineImages).map(image => `Photo: ${image.name} (shown in the HTML email).`);
  const text = [post.text, ...photoDescriptions, ...notices, footer].filter(Boolean).join('\n\n');
  const link = sourceLink(post);
  const html = `<div>${formatted(post, ports)}</div>${imageHtml(inlineImages)}${notices.map(n => `<p>${escapeHtml(n)}</p>`).join('')}<p><small>${escapeHtml(post.channel.title)} · ${escapeHtml(timestamp)}<br>${safeLink(link) ? `<a href="${escapeHtml(link)}">View source post</a>` : escapeHtml(link)}</small></p>`;
  return { text, html, attachments, inlineImages };
}

export function deliver(batch: Batch, recipients: Array<{ id: string; recipient: string }>, ports: Ports): void {
  const parts: Part[] = [];
  let current: Part = { text: '', html: '', attachments: [], inlineImages: {} };
  let usedBytes = 0;
  const push = () => {
    if (current.text || current.html) parts.push(current);
    current = { text: '', html: '', attachments: [], inlineImages: {} }; usedBytes = 0;
  };
  const posts = [...batch.posts].sort((a, b) => a.messageId - b.messageId);
  for (const post of posts) {
    // Render before fetching so body-driven splits reset the attachment budget without re-downloading.
    const preview = `<div>${formatted(post, ports)}</div>${escapeHtml(post.text)}${escapeHtml(post.channel.title)}`;
    if (current.html && byteLength(current.html) + byteLength(preview) + 3000 > BODY_BUDGET) push();
    const part = renderPost(post, ports, FILE_BUDGET - usedBytes, 250 - files(current).length);
    if (byteLength(part.html) > BODY_BUDGET || byteLength(part.text) > BODY_BUDGET) {
      // Telegram posts are normally much smaller. Preserve unusually large text using escaped plain-text segments.
      const segments: string[] = [];
      let segment = '', bytes = 0;
      const imagesHtml = imageHtml(part.inlineImages);
      // Reserve the photo markup on the first segment so oversized-post fallback retains its images.
      const segmentBudget = Math.max(1, BODY_BUDGET - 1000 - byteLength(imagesHtml));
      for (const char of part.text) {
        const weight = byteLength(escapeHtml(char));
        if (bytes + weight > segmentBudget) { segments.push(segment); segment = ''; bytes = 0; }
        segment += char; bytes += weight;
      }
      if (segment) segments.push(segment);
      push();
      segments.forEach((text, i) => parts.push({
        text, html: `<pre>${escapeHtml(text)}</pre>${i === 0 ? imagesHtml : ''}`,
        attachments: i === 0 ? part.attachments : [], inlineImages: i === 0 ? part.inlineImages : {},
      }));
      continue;
    }
    if (current.html && (byteLength(current.html) + byteLength(part.html) + 10 > BODY_BUDGET || byteLength(current.text) + byteLength(part.text) + 10 > BODY_BUDGET)) push();
    current.text += (current.text ? '\n\n' : '') + part.text;
    current.html += part.html;
    current.attachments.push(...part.attachments);
    Object.assign(current.inlineImages, part.inlineImages);
    usedBytes += files(part).reduce((sum, a) => sum + a.size, 0);
  }
  push();
  for (const mapping of recipients) {
    parts.forEach((part, i) => {
      const email: Email = {
        to: mapping.recipient,
        subject: subject(posts, i + 1, parts.length),
        ...part,
      };
      try {
        ports.send(email);
        ports.log('email_sent', { batchId: batch.id, mappingId: mapping.id, part: i + 1 });
      } catch {
        ports.log('email_failed', { batchId: batch.id, mappingId: mapping.id, part: i + 1 });
      }
    });
  }
}
