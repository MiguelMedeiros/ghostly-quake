export const PUBLISHER: string | null;
export const REPO: string;
export const BUNDLE: string;
export const SOURCE: string;
export function readManifest(bytes: Uint8Array): { manifest: Record<string, unknown> & { files?: { path: string; size: number; sha256: string }[] }; digest: string };
export function digestOf(manifest: Record<string, unknown>): string;
export function expected(source: Record<string, unknown>, files: { path: string; bytes: Uint8Array }[], sequence: number, publisher: string): Record<string, unknown>;
export function problems(manifest: Record<string, unknown>, source: Record<string, unknown>, files: { path: string; bytes: Uint8Array }[], publisher?: string | null): string[];
export function listing(manifest: Record<string, unknown>, digest: string, commit: string): Record<string, unknown>;
