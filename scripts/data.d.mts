export const ARCHIVES: Record<"lite" | "server", { file: string; sha256: string }>;
export const MAPS: [string, string][];
export const SOUND_RATE: number;
export function readZip(zip: Buffer): Map<string, Buffer>;
export function readPak(pak: Buffer): Map<string, Buffer>;
export function resampleWav(wav: Buffer, rate?: number): Buffer;
export function writeZip(files: Map<string, Buffer>): Buffer;
export function gameFiles(): Promise<Map<string, Buffer>>;
