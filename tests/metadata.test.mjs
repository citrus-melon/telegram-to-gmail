import { describe, expect, it } from 'vitest';
import { buildMetadata, metadataBanner, repositoryUrl } from '../scripts/metadata.mjs';

const pkg = { name: 'telegram-to-gmail', description: 'Telegram forwarding', version: '0.1.0' };

describe('build metadata', () => {
  it('works without Git or a remote and omits unavailable fields', () => {
    const info = buildMetadata(pkg, () => undefined);
    expect(info).toEqual(pkg);
    expect(metadataBanner(info)).not.toContain('Repository:');
    expect(metadataBanner(info)).not.toContain('Revision:');
    expect(metadataBanner(info).startsWith('// Generated file;')).toBe(true);
  });
  it('prefers package repository metadata and includes a Git revision', () => {
    const info = buildMetadata({ ...pkg, repository: { url: 'git+https://example.com/project.git' } }, args => args[0] === 'rev-parse' ? 'abc1234' : 'https://example.com/other.git');
    expect(info.repository).toBe('https://example.com/project');
    expect(info.revision).toBe('abc1234');
    expect(metadataBanner(info)).toContain('// Revision: abc1234');
  });
  it('uses a sanitized Git origin when package repository metadata is absent', () => {
    const info = buildMetadata(pkg, args => args[0] === 'config' ? 'git@example.com:owner/repo.git' : undefined);
    expect(info.repository).toBe('https://example.com/owner/repo');
    expect(repositoryUrl('https://user:password@example.com/repo.git?token=secret#fragment')).toBe('https://example.com/repo');
  });
  it('omits filesystem remotes and keeps banner values on comment lines', () => {
    expect(repositoryUrl('C:\\private\\repository')).toBeUndefined();
    expect(repositoryUrl('/private/repository')).toBeUndefined();
    expect(repositoryUrl('file:///private/repository')).toBeUndefined();
    const info = buildMetadata({ ...pkg, description: 'Text\nmalicious();\u2028other();' }, () => undefined);
    expect(metadataBanner(info).split('\n').every(line => line.startsWith('//'))).toBe(true);
  });
});
