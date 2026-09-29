import type { Properties } from './types';

const KEY = 'FLUSH_SCHEDULE';
interface Schedule { id: string; dueAt: number }
export interface TriggerPort {
  list(): string[];
  create(delay: number): string;
  remove(id: string): void;
}

// Caller holds the script lock: trigger reconciliation and queue decisions must be serialized.
export class FlushScheduler {
  constructor(private properties: Properties, private triggers: TriggerPort, private now: () => number) {}

  sync(dueAt: number | null, firingId?: string): void {
    const ids = this.triggers.list();
    let previous: Schedule | undefined;
    try {
      const value = this.properties.getProperty(KEY);
      if (value) {
        const parsed = JSON.parse(value) as Schedule;
        if (typeof parsed.id === 'string' && Number.isFinite(parsed.dueAt)) previous = parsed;
      }
    } catch { /* Missing/corrupt scheduling metadata can be reconstructed from queued work. */ }

    if (dueAt === null) {
      ids.forEach(id => this.triggers.remove(id));
      this.properties.deleteProperty(KEY);
      return;
    }
    const keep = previous?.dueAt === dueAt && previous.id !== firingId && ids.includes(previous.id)
      ? previous.id : undefined;
    if (keep) {
      ids.filter(id => id !== keep).forEach(id => this.triggers.remove(id));
      return;
    }
    // Clear abandoned triggers, but preserve a known pending trigger until its replacement exists.
    const pending = previous && previous.id !== firingId && ids.includes(previous.id) ? previous.id : undefined;
    ids.filter(id => id !== pending).forEach(id => this.triggers.remove(id));
    const id = this.triggers.create(Math.max(1000, dueAt - this.now()));
    try { this.properties.setProperty(KEY, JSON.stringify({ id, dueAt })); }
    catch (error) { this.triggers.remove(id); throw error; }
    if (pending) this.triggers.remove(pending);
  }
}
