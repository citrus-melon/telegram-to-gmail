export interface Entity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  user?: { id: number; first_name?: string };
  language?: string;
  custom_emoji_id?: string;
}
export interface Chat { id: number; type: string; title?: string; username?: string }
export interface FileInfo { file_id: string; file_size?: number; file_name?: string; mime_type?: string; width?: number; height?: number }
export interface Message {
  message_id: number;
  date: number;
  chat: Chat;
  from?: { id: number };
  text?: string;
  caption?: string;
  entities?: Entity[];
  caption_entities?: Entity[];
  photo?: FileInfo[];
  document?: FileInfo;
  [key: string]: unknown;
}
export interface Update {
  update_id: number;
  channel_post?: Message;
  message?: Message;
  callback_query?: { id: string; from: { id: number }; message?: Message; data?: string };
  my_chat_member?: { chat: Chat; new_chat_member: { status: string } };
}
export interface Mapping { id: string; channelId: string; recipient: string }
export interface Channel { id: string; title: string; username?: string; accessible: boolean }
export interface Post {
  updateId: number;
  messageId: number;
  channel: Channel;
  date: number;
  text: string;
  entities: Entity[];
  file?: FileInfo & { kind: 'photo' | 'document' };
  omissions: string[];
}
export interface Batch { id: string; channelId: string; openedAt: number; posts: Post[] }
export interface State {
  version: 1;
  enabled: boolean;
  admins: string[];
  mappings: Mapping[];
  channels: Channel[];
  batches: Batch[];
  seen: number[];
  confirmations: Record<string, { token: string; kind: 'mapping' | 'admin'; target: string; expiresAt: number }>;
}
export interface Properties {
  getProperty(key: string): string | null;
  getProperties(): Record<string, string>;
  setProperty(key: string, value: string): unknown;
  setProperties(values: Record<string, string>): unknown;
  deleteProperty(key: string): unknown;
}
export interface Attachment { name: string; size: number; blob: GoogleAppsScript.Base.BlobSource }
export interface Email { to: string; subject: string; text: string; html: string; attachments: Attachment[]; inlineImages: Record<string, Attachment> }
export type Buttons = Array<Array<{ text: string; callback_data: string }>>;
export interface Ports {
  properties: Properties;
  locked<T>(action: () => T): T;
  now(): number;
  formatTimestamp(timestamp: number): string;
  uuid(): string;
  telegram<T>(method: string, payload?: Record<string, unknown>): T;
  download(file: FileInfo, name: string): Attachment;
  send(email: Email): void;
  log(event: string, details?: Record<string, string | number | boolean>): void;
  syncFlush(dueAt: number | null, firingId?: string): void;
}
