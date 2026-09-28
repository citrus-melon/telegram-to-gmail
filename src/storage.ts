import type { Properties, State } from './types';

// Generations make the pointer switch the commit point. The previous state survives a failed write.
const POINTER = 'STATE_POINTER';
const PREFIX = 'STATE_CHUNK_';
const CHUNK_BYTES = 7500;
const STORE_BUDGET = 450_000;

export function byteLength(value: string): number {
  let size = 0;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    size += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return size;
}

export function chunks(value: string): string[] {
  const result: string[] = [];
  let part = '', size = 0;
  for (const char of value) {
    const bytes = byteLength(char);
    if (size + bytes > CHUNK_BYTES) { result.push(part); part = ''; size = 0; }
    part += char; size += bytes;
  }
  if (part || !result.length) result.push(part);
  return result;
}

export class StateStore {
  constructor(private properties: Properties, private uuid: () => string) {}

  read(): State | null {
    const pointer = this.properties.getProperty(POINTER);
    if (!pointer) return null;
    const { generation, count } = JSON.parse(pointer) as { generation: string; count: number };
    const parts: string[] = [];
    for (let i = 0; i < count; i++) {
      const part = this.properties.getProperty(`${PREFIX}${generation}_${i}`);
      if (part === null) throw new Error('Stored state is incomplete; restore from a backup.');
      parts.push(part);
    }
    const state = JSON.parse(parts.join('')) as State;
    if (state.version !== 1) throw new Error('Unsupported state version.');
    return state;
  }

  write(state: State): void {
    const previousPointer = this.properties.getProperty(POINTER);
    const previousGeneration = previousPointer ? JSON.parse(previousPointer).generation as string : null;
    // Only delete orphan generations; the committed generation is retained until the new commit.
    const current = this.properties.getProperties();
    for (const key of Object.keys(current)) {
      if (key.startsWith(PREFIX) && !key.startsWith(`${PREFIX}${previousGeneration}_`)) {
        this.properties.deleteProperty(key); delete current[key];
      }
    }
    const generation = this.uuid();
    const values: Record<string, string> = {};
    chunks(JSON.stringify(state)).forEach((part, i) => { values[`${PREFIX}${generation}_${i}`] = part; });
    const pointer = JSON.stringify({ generation, count: Object.keys(values).length });
    const combined = { ...current, ...values, [POINTER]: pointer };
    const total = Object.entries(combined).reduce((sum, [key, value]) => sum + byteLength(key) + byteLength(value), 0);
    if (total > STORE_BUDGET) throw new Error('Script Properties capacity reached; remove unused configuration or pending content.');
    try {
      this.properties.setProperties(values);
      this.properties.setProperty(POINTER, pointer);
    } catch {
      for (const key of Object.keys(values)) this.properties.deleteProperty(key);
      throw new Error('Could not save state; the previous configuration was retained.');
    }
    for (const key of Object.keys(current)) {
      if (key.startsWith(PREFIX)) this.properties.deleteProperty(key);
    }
  }
}
