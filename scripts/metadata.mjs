import { execFileSync } from 'node:child_process';

function singleLine(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').trim();
}

export function repositoryUrl(value) {
  if (typeof value !== 'string') return undefined;
  let remote = value.trim();
  // Convert conventional SSH remotes to browsable URLs, never exposing the SSH user.
  const scp = /^(?:[^@\s]+@)([\w.-]+):(.+)$/.exec(remote);
  if (scp) remote = `https://${scp[1]}/${scp[2]}`;
  remote = remote.replace(/^git\+/, '');
  try {
    const url = new URL(remote);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return undefined;
    if (['ssh:', 'git:'].includes(url.protocol)) { url.protocol = 'https:'; url.port = ''; }
    // Reconstruct rather than retaining credentials, query parameters, or fragments.
    return `https://${url.host}${url.pathname.replace(/\.git\/?$/, '').replace(/\/$/, '')}`;
  } catch { return undefined; }
}

function readGit(args) {
  try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return undefined; }
}

export function buildMetadata(pkg, git = readGit) {
  const configured = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const repository = repositoryUrl(configured) || repositoryUrl(git(['config', '--get', 'remote.origin.url']));
  const revision = git(['rev-parse', '--short', 'HEAD']);
  return {
    name: singleLine(pkg.name), description: singleLine(pkg.description), version: singleLine(pkg.version),
    ...(revision && /^[a-f0-9]+$/i.test(revision) ? { revision } : {}),
    ...(repository ? { repository } : {}),
  };
}

export function metadataBanner(info) {
  const fields = { Project: info.name, Description: info.description, Version: info.version, Revision: info.revision, Repository: info.repository };
  return [
    '// Generated file; edit src/ and scripts/build.mjs, then run pnpm build.',
    ...Object.entries(fields).filter(([, value]) => value).map(([label, value]) => `// ${label}: ${singleLine(value)}`),
  ].join('\n');
}
