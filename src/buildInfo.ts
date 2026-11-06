import packageMetadata from '../package.json';

declare const __BUILD_METADATA__: {
  packageVersion: string; builtAt: string; sourceSha256: string;
  gitCommit: string | null; gitTag: string | null; gitDirty: boolean;
} | undefined;

export function getEmbeddedBuildInfo() {
  return typeof __BUILD_METADATA__ === 'undefined'
    ? { packageVersion: packageMetadata.version, builtAt: null, sourceSha256: null, gitCommit: null, gitTag: null, gitDirty: null }
    : __BUILD_METADATA__;
}
