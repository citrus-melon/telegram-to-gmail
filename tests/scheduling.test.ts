import { describe, expect, it, vi } from 'vitest';
import { FlushScheduler } from '../src/scheduling';
import { harness, MemoryProperties } from './harness';

function scheduler() {
  const properties = new MemoryProperties();
  const ids: string[] = [];
  let serial = 0, now = 0;
  const triggers = {
    list: () => [...ids],
    create: vi.fn((_delay: number) => { const id = `t-${++serial}`; ids.push(id); return id; }),
    remove: vi.fn((id: string) => { const i = ids.indexOf(id); if (i >= 0) ids.splice(i, 1); }),
  };
  const scheduling = new FlushScheduler(properties, triggers, () => now);
  return { properties, ids, triggers, scheduling, setTime: (value: number) => { now = value; } };
}

describe('one-shot trigger reconciliation', () => {
  it('creates no idle trigger and reuses a trigger across posts with the same deadline', () => {
    const h = scheduler(); h.scheduling.sync(null); expect(h.ids).toEqual([]);
    h.scheduling.sync(60_000); h.setTime(20_000); h.scheduling.sync(60_000);
    expect(h.ids).toEqual(['t-1']); expect(h.triggers.create).toHaveBeenCalledExactlyOnceWith(60_000);
  });
  it('replaces a changed deadline and clears the schedule when no work remains', () => {
    const h = scheduler(); h.scheduling.sync(60_000); h.scheduling.sync(90_000);
    expect(h.ids).toEqual(['t-2']);
    h.scheduling.sync(null); expect(h.ids).toEqual([]);
    expect(h.properties.getProperty('FLUSH_SCHEDULE')).toBeNull();
  });
  it('does not reuse the trigger currently firing, including an early invocation', () => {
    const h = scheduler(); h.scheduling.sync(60_000); h.setTime(59_000);
    h.scheduling.sync(60_000, 't-1');
    expect(h.ids).toEqual(['t-2']); expect(h.triggers.create).toHaveBeenLastCalledWith(1000);
  });
  it('a stale invocation preserves the newer scheduled trigger', () => {
    const h = scheduler(); h.scheduling.sync(60_000); h.scheduling.sync(90_000);
    h.ids.push('stale'); h.scheduling.sync(90_000, 'stale');
    expect(h.ids).toEqual(['t-2']); expect(h.triggers.create).toHaveBeenCalledTimes(2);
  });
  it('repairs externally removed triggers and corrupt metadata, removing duplicates', () => {
    const h = scheduler(); h.scheduling.sync(60_000); h.ids.splice(0);
    h.scheduling.sync(60_000); expect(h.ids).toEqual(['t-2']);
    h.properties.setProperty('FLUSH_SCHEDULE', '{'); h.ids.push('orphan');
    h.scheduling.sync(60_000); expect(h.ids).toEqual(['t-3']);
  });
  it('reconciles abandoned triggers and reuses the pending schedule on repeated setup', () => {
    const h = scheduler(); h.ids.push('orphan', 'duplicate');
    h.scheduling.sync(60_000); expect(h.ids).toEqual(['t-1']);
    h.scheduling.sync(60_000); expect(h.triggers.create).toHaveBeenCalledTimes(1);
    h.scheduling.sync(null); expect(h.ids).toEqual([]);
  });
  it('preserves a known pending trigger when creating its replacement fails', () => {
    const h = scheduler(); h.scheduling.sync(60_000);
    h.triggers.create.mockImplementationOnce(() => { throw new Error('Quota'); });
    expect(() => h.scheduling.sync(90_000)).toThrow('Quota');
    expect(h.ids).toEqual(['t-1']);
    h.scheduling.sync(90_000); expect(h.ids).toEqual(['t-2']);
  });
  it('cleans up a new trigger if recording its metadata fails', () => {
    const h = scheduler(); h.scheduling.sync(60_000);
    vi.spyOn(h.properties, 'setProperty').mockImplementationOnce(() => { throw new Error('Quota'); });
    expect(() => h.scheduling.sync(90_000)).toThrow('Quota');
    expect(h.ids).toEqual(['t-1']);
  });
});

describe('queue scheduling integration', () => {
  function queued() {
    const h = harness(); const s = scheduler();
    vi.mocked(h.ports.syncFlush).mockImplementation((...args) => s.scheduling.sync(...args));
    h.command('/addmapping @news a@example.com');
    return { h, s, setTime: (value: number) => { h.setTime(value); s.setTime(value); } };
  }
  it('groups posts without delaying the deadline, then leaves no idle work', () => {
    const { h, s, setTime } = queued(); h.post('first'); setTime(20_000); h.post('second');
    expect(s.ids).toEqual(['t-1']); expect(s.triggers.create).toHaveBeenCalledTimes(1);
    setTime(60_000); h.bot.flush('t-1');
    expect(h.emails).toHaveLength(1); expect(s.ids).toEqual([]);
  });
  it('schedules a later batch received during delivery and does not cancel its wakeup at exit', () => {
    const { h, s, setTime } = queued(); h.post('first');
    vi.mocked(h.ports.send).mockImplementationOnce(email => { h.post('during send'); h.emails.push(email); });
    setTime(60_000); h.bot.flush('t-1');
    expect(s.ids).toEqual(['t-2']); expect(JSON.parse(s.properties.getProperty('FLUSH_SCHEDULE')!).dueAt).toBe(120_000);
    setTime(120_000); h.bot.flush('t-2'); expect(h.emails).toHaveLength(2); expect(s.ids).toEqual([]);
  });
  it('leaves a successor for unclaimed batches if the worker reaches its time budget', () => {
    const { h, s, setTime } = queued(); h.post('first'); setTime(60_000); h.post('second');
    vi.mocked(h.ports.send).mockImplementationOnce(email => { setTime(400_000); h.emails.push(email); });
    h.bot.flush('t-1');
    expect(h.store.read()?.batches).toHaveLength(1); expect(s.ids).toEqual(['t-2']);
    h.bot.flush('t-2'); expect(h.emails).toHaveLength(2); expect(s.ids).toEqual([]);
  });
  it('off cancels queued work and trigger; unmapped/disabled posts do not schedule work', () => {
    const { h, s } = queued(); h.post('queued'); h.command('/off');
    expect(s.ids).toEqual([]); h.post('disabled'); expect(s.ids).toEqual([]);
    h.command('/on'); h.mutate(state => { state.mappings = []; }); h.post('unmapped');
    expect(s.ids).toEqual([]);
  });
  it('logs a scheduling failure, preserves the batch, and repairs scheduling on a duplicate update', () => {
    const { h, s } = queued();
    s.triggers.create.mockImplementationOnce(() => { throw new Error('Quota'); });
    h.post('queued', {}, 100); expect(h.store.read()?.batches).toHaveLength(1);
    expect(h.ports.log).toHaveBeenCalledWith('flush_schedule_failed');
    h.post('queued', {}, 100); expect(s.ids).toEqual(['t-1']); expect(h.store.read()?.batches[0].posts).toHaveLength(1);
  });
  it('setup recovers existing pending work without changing the state version or configuration', () => {
    const { h, s } = queued(); h.post('queued'); s.ids.splice(0); h.bot.setup();
    expect(s.ids).toEqual(['t-2']); expect(h.store.read()).toMatchObject({ version: 1, enabled: true });
    expect(h.store.read()?.mappings).toHaveLength(1); expect(h.store.read()?.batches).toHaveLength(1);
  });
});
