import pkg from '../package.json';

export interface ProjectMetadata {
  name: string;
  description: string;
  version: string;
  revision?: string;
  repository?: string;
}

declare const __BUILD_METADATA__: ProjectMetadata;
// Source-level tests and archive builds have deterministic package-based defaults.
const metadata: ProjectMetadata = typeof __BUILD_METADATA__ === 'undefined'
  ? { name: pkg.name, description: pkg.description, version: pkg.version }
  : __BUILD_METADATA__;

export function projectDetails(info: ProjectMetadata = metadata): string {
  return [
    `${info.name} v${info.version}${info.revision ? ` (${info.revision})` : ''}`,
    info.description,
    ...(info.repository ? [`Repository: ${info.repository}`] : []),
  ].filter(Boolean).join('\n');
}
