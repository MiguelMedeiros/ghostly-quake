/**
 * Which versions of Arena play together. Both sides must load the same maps and game code, or the engine refuses the
 * connection, so a version that changes the engine or the data (data/arena.pk3, engine/dist) raises at least the
 * minor version; versions that differ only in their patch number play together.
 */
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export function compatible(mine: string, theirs: string): boolean {
  if (mine === theirs) return true;
  const a = SEMVER.exec(mine);
  const b = SEMVER.exec(theirs);
  if (!a || !b) return false;
  return a[1] === b[1] && a[2] === b[2];
}
