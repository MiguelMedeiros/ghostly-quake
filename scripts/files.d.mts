export const root: string;
export const BUNDLE_LIMIT: number;
export function bundleFiles(): [string, string][];
export function readBundleFiles(): { path: string; bytes: Buffer }[];
