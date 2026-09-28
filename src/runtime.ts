import { BotService } from './bot';
import { FILE_BUDGET } from './forwarding';
import type { Attachment, FileInfo, Ports } from './types';

function telegram<T>(method: string, payload: Record<string, unknown> = {}): T {
  const token = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
  if (!token) throw new Error('BOT_TOKEN is missing.');
  try {
    const response = UrlFetchApp.fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true,
    });
    const data = JSON.parse(response.getContentText()) as { ok: boolean; result: T };
    if (response.getResponseCode() !== 200 || !data.ok) throw new Error('API failure');
    return data.result;
  } catch { throw new Error(`Telegram ${method} failed. Check bot access and execution logs.`); }
}

function download(file: FileInfo, name: string): Attachment {
  try {
    const info = telegram<{ file_path?: string; file_size?: number }>('getFile', { file_id: file.file_id });
    if (!info.file_path || !/^[a-zA-Z0-9_./-]+$/.test(info.file_path) || info.file_path.includes('..')) throw new Error('Invalid file path');
    if ((info.file_size ?? file.file_size ?? 0) > FILE_BUDGET) throw new Error('File too large');
    const token = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
    const response = UrlFetchApp.fetch(`https://api.telegram.org/file/bot${token}/${info.file_path}`, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) throw new Error('Download failed');
    const blob = response.getBlob().setName(name);
    const size = blob.getBytes().length;
    if (size > FILE_BUDGET) throw new Error('File too large');
    if (file.mime_type) blob.setContentType(file.mime_type);
    return { name, size, blob };
  } catch { throw new Error('Attachment download unavailable.'); }
}

function ports(): Ports {
  return {
    properties: PropertiesService.getScriptProperties(),
    locked(action) {
      const lock = LockService.getScriptLock();
      lock.waitLock(20_000);
      try { return action(); } finally { lock.releaseLock(); }
    },
    now: () => Date.now(),
    uuid: () => Utilities.getUuid(),
    telegram,
    download,
    send(email) {
      GmailApp.sendEmail(email.to, email.subject, email.text, { htmlBody: email.html, attachments: email.attachments.map(a => a.blob) });
    },
    log(event, details = {}) { console.log(JSON.stringify({ event, ...details })); },
    ensureTrigger() {
      const triggers = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'flushPending');
      // Recreate the trigger to ensure its interval is correct. Only this handler's triggers are touched.
      triggers.forEach(t => ScriptApp.deleteTrigger(t));
      ScriptApp.newTrigger('flushPending').timeBased().everyMinutes(1).create();
    },
  };
}

export function doPost(event: GoogleAppsScript.Events.DoPost): GoogleAppsScript.HTML.HtmlOutput {
  new BotService(ports()).receive(event.parameter?.secret, event.postData?.contents || '');
  return HtmlService.createHtmlOutput('OK');
}
export function setup(): void { new BotService(ports()).setup(); }
export function flushPending(): void { new BotService(ports()).flush(); }
export function recoverAdmin(): void { new BotService(ports()).recoverAdmin(); }
export function webhookStatus(): void {
  const info = telegram<{ pending_update_count: number; last_error_date?: number; last_error_message?: string }>('getWebhookInfo');
  // The full getWebhookInfo object includes the secret URL; never print it.
  console.log(JSON.stringify({ pendingUpdates: info.pending_update_count, lastErrorDate: info.last_error_date ?? null, hasError: !!info.last_error_message }));
}
