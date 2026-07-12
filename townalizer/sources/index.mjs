/**
 * Source registry.
 *
 * A source adapter is any module exporting:
 *   id: string
 *   label: string
 *   collect({ cwd, since, until }) -> { source, meta, records: Record[] }
 *   activeDays({ cwd })            -> string[]  (ISO dates, ascending)
 *
 * A Record is:
 *   id        string    stable identifier (a sha, a hash, anything unique)
 *   shortId   string    the human-quotable form; what a notice cites
 *   source    string    the adapter that produced it
 *   timestamp string    ISO 8601, in the actor's own offset
 *   actor     string    who did it
 *   actorId   string    slug of the above
 *   automated boolean   was it a machine (the Clerk)
 *   title     string    one line, as they described it
 *   body      string    the rest, if any
 *   parents   string[]  ancestry; length > 1 is a merge, and a merge is a treaty
 *   root      boolean   the one record with no ancestor; only a source with
 *                       ancestry may claim this (a journal never founds a town)
 *   artifacts {path, added, removed, binary}[]   what it touched
 *
 * Add an adapter here and every layer above it — surveyor, state, dispatch, site —
 * works unchanged. That is the entire point of the Record shape.
 */

import * as git from './git.mjs';
import * as journal from './journal.mjs';

const SOURCES = new Map([
  [git.id, git],
  [journal.id, journal],
]);

export function getSource(id = 'git') {
  const s = SOURCES.get(id);
  if (!s) {
    throw new Error(`unknown source "${id}". Known sources: ${[...SOURCES.keys()].join(', ')}`);
  }
  return s;
}

export function listSources() {
  return [...SOURCES.values()].map((s) => ({ id: s.id, label: s.label }));
}
