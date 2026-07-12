/**
 * Journal source adapter.
 *
 * Reads a directory of dated markdown files (`2026-07-10.md`, or any file whose
 * name begins with an ISO date) and emits one Record per file. Each `## heading`
 * inside becomes an artifact, which the surveyor will treat the way it treats a
 * changed file: as a thing in the town that somebody touched.
 *
 * This adapter earns its keep by being unlike git — no shas, no diffs, no bots —
 * and still fitting the Record shape without the surveyor needing to care.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const id = 'journal';
export const label = 'Dated journal entries';

const DATED = /^(\d{4}-\d{2}-\d{2})/;

export async function collect({ cwd = process.cwd(), since, until, actor = 'The Journal-Keeper' } = {}) {
  let names = [];
  try {
    names = await readdir(cwd);
  } catch (err) {
    throw new Error(`cannot read journal directory ${cwd}: ${err.message}`);
  }

  const records = [];
  for (const name of names.sort()) {
    const m = name.match(DATED);
    if (!m || !/\.(md|markdown|txt)$/i.test(name)) continue;
    const date = m[1];
    if (since && date < since.slice(0, 10)) continue;
    if (until && date >= until.slice(0, 10)) continue;

    const raw = await readFile(path.join(cwd, name), 'utf8');
    const lines = raw.split('\n');

    // First `# heading` is the title; failing that, the first non-empty line.
    const h1 = lines.find((l) => /^#\s+/.test(l));
    const title = (h1 ? h1.replace(/^#\s+/, '') : lines.find((l) => l.trim()) || name).trim();

    // Each `## section` is a thing that was worked on.
    const artifacts = lines
      .filter((l) => /^##\s+/.test(l))
      .map((l) => {
        const label = l.replace(/^##\s+/, '').trim();
        return {
          path: `journal/${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          added: 0,
          removed: 0,
          binary: false,
        };
      });

    records.push({
      id: createHash('sha1').update(name + raw).digest('hex'),
      shortId: createHash('sha1').update(name).digest('hex').slice(0, 7),
      source: 'journal',
      timestamp: `${date}T12:00:00Z`,
      actor,
      actorId: actor.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      automated: false,
      title,
      body: raw.replace(/^#\s+.*$/m, '').trim(),
      parents: [],
      root: false, // a journal has no ancestry, and so founds nothing
      artifacts,
    });
  }

  // Newest first, to match the git adapter's contract.
  records.reverse();
  return { source: id, meta: { cwd, since, until, repo: path.basename(cwd) }, records };
}

export async function activeDays({ cwd = process.cwd() } = {}) {
  const names = await readdir(cwd).catch(() => []);
  return [...new Set(names.map((n) => n.match(DATED)?.[1]).filter(Boolean))].sort();
}
