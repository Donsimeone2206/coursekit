/**
 * Group naming and sizing for "auto-create groups". Shared by the server, which makes the groups, and the
 * web UI, which previews them.
 */

export type GroupSplit = 'groups' | 'members';

/** Most groups one auto-create may make. */
export const MAX_AUTO_GROUPS = 200;

export const DEFAULT_GROUP_NAMING = 'Group @';

/** Spreadsheet-style letters: 1 → A, 26 → Z, 27 → AA. */
export function letters(n: number): string {
  let s = '';
  for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + ((k - 1) % 26)) + s;
  return s;
}

/**
 * Names for new groups from a naming scheme: `#` becomes a number and `@` a letter ("Group @" makes Group A,
 * Group B, ...). A scheme with neither gets " #" added. Names already used in the course are skipped.
 */
export function groupNames(scheme: string, count: number, taken: Iterable<string>): string[] {
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  const template = /[#@]/.test(scheme) ? scheme : `${scheme} #`;
  const names: string[] = [];
  for (let n = 1; names.length < count; n++) {
    const name = template.replaceAll('#', String(n)).replaceAll('@', letters(n));
    if (used.has(name.toLowerCase())) continue;
    used.add(name.toLowerCase());
    names.push(name);
  }
  return names;
}

/** How many groups a split makes: `groups` makes `size` groups, `members` as few groups of at most `size` as possible. */
export function groupCount(split: GroupSplit, size: number, people: number): number {
  return split === 'groups' ? size : Math.ceil(people / size);
}
