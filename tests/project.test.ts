import { describe, expect, it } from 'vitest';
import { projectDetails } from '../src/project';
import { harness } from './harness';

describe('bot project information', () => {
  it('appends deterministic package metadata to both help commands without unavailable Git fields', () => {
    const h = harness();
    for (const command of ['/start', '/help']) {
      h.command(command);
      expect(h.lastReply()?.text).toContain(projectDetails());
      expect(h.lastReply()?.text).toContain('telegram-to-gmail v0.1.0');
      expect(h.lastReply()?.text).not.toContain('Repository:');
    }
  });
  it('formats optional revision and repository information', () => {
    expect(projectDetails({ name: 'bot', description: 'Forwarding', version: '1.0', revision: 'abc1234', repository: 'https://example.com/bot' }))
      .toBe('bot v1.0 (abc1234)\nForwarding\nRepository: https://example.com/bot');
  });
});
