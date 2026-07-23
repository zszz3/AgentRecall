/**
 * Browser-safe asset identity helpers.
 * This module must NOT import any Node.js built-ins (fs, os, path, crypto, sqlite)
 * because it is imported by renderer components bundled for the browser environment.
 */

export interface AssetIdentityInput {
  agent: string;
  scope: string;
  name: string;
  projectPath: string;
}

/**
 * Computes a stable identity string for a digital asset (rule or memory).
 * Project-scoped assets include the project path; global assets do not.
 */
export function assetIdentity(asset: AssetIdentityInput): string {
  return asset.scope === "project"
    ? `${asset.agent}:${asset.scope}:${asset.projectPath}:${asset.name}`
    : `${asset.agent}:${asset.scope}:${asset.name}`;
}
