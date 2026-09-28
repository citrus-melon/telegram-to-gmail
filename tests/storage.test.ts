import { describe, expect, it } from 'vitest';
import { byteLength, chunks, StateStore } from '../src/storage';
import { harness, MemoryProperties } from './harness';

describe('Script Properties storage', () => {
  it('chunks UTF-8 without splitting surrogate pairs and round trips state', () => {
    const value = '🎉漢字'.repeat(5000);
    expect(chunks(value).join('')).toBe(value);
    expect(chunks(value).every(chunk => byteLength(chunk) <= 7500)).toBe(true);
    const h = harness(); h.mutate(s => { s.channels = [{ id: '-1001', title: value, accessible: true }]; });
    expect(h.store.read()?.channels[0].title).toBe(value);
    expect(Object.entries(h.properties.values).filter(([key]) => key.startsWith('STATE_CHUNK_')).every(([, val]) => byteLength(val) <= 7500)).toBe(true);
  });
  it('rejects capacity overflow while retaining the committed state', () => {
    const h = harness(); const original = h.store.read()!;
    expect(() => h.mutate(s => { s.channels = [{ id: '-1001', title: 'x'.repeat(460_000), accessible: true }]; })).toThrow('capacity');
    expect(h.store.read()).toEqual(original);
  });
  it('retains state after a partial write and removes orphan chunks on the next write', () => {
    const h = harness(); const original = h.store.read()!;
    h.properties.failWrite = true;
    expect(() => h.mutate(s => { s.enabled = false; })).toThrow('previous configuration');
    expect(h.store.read()).toEqual(original);
    h.properties.failWrite = false;
    h.properties.setProperty('STATE_CHUNK_orphan_0', 'orphan');
    h.mutate(s => { s.enabled = false; });
    expect(h.properties.getProperty('STATE_CHUNK_orphan_0')).toBeNull();
    expect(h.store.read()?.enabled).toBe(false);
  });
  it('fails closed for missing chunks and unknown versions', () => {
    const properties = new MemoryProperties();
    const store = new StateStore(properties, () => 'test');
    properties.setProperty('STATE_POINTER', JSON.stringify({ generation: 'bad', count: 1 }));
    expect(() => store.read()).toThrow('incomplete');
    properties.setProperty('STATE_CHUNK_bad_0', JSON.stringify({ version: 2 }));
    expect(() => store.read()).toThrow('version');
  });
});
