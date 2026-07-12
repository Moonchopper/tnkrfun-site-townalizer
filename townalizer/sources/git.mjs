/**
 * Git source adapter.
 *
 * Turns a repository's history into normalised Records (the shape is documented in
 * ./index.mjs). This adapter knows about git and nothing about towns; the surveyor
 * knows about towns and nothing about git. Keep it that way — it is the seam that
 * lets a journal, a ticket export, or a ship's log feed the same machinery.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Control characters, because commit messages contain every printable character
// a person has ever been angry enough to type.
const REC = '\x1e';
const FLD = '\x1f';

export const id = 'git';
export const label = 'Git history';

/** Bots do not sleep, take lunch, or feel anything. We record this. */
function isAutomated(name, email) {
  const n = `${name} ${email}`.toLowerCase();
  return /\[bot\]|actions@github|noreply@github|dependabot|renovate/.test(n);
}

function actorId(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * git --numstat reports renames as `{old => new}/path` or `old => new`.
 * We only need somewhere to put the building, so take the destination.
 */
function normalisePath(raw) {
  let p = raw.trim();
  if (p.includes('=>')) {
    const braced = p.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
    if (braced) {
      p = `${braced[1]}${braced[3]}${braced[4]}`.replace(/\/{2,}/g, '/');
    } else {
      p = p.split('=>').pop().trim();
    }
  }
  return p.replace(/^"|"$/g, '');
}

function parseNumstat(block) {
  const artifacts = [];
  for (const line of block.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split('\t');
    if (parts.length < 3) continue;
    const [addRaw, delRaw, ...pathParts] = parts;
    const path = normalisePath(pathParts.join('\t'));
    if (!path) continue;
    // Binary files report `-` for both counts. They changed; we cannot say how much.
    const binary = addRaw === '-' || delRaw === '-';
    artifacts.push({
      path,
      added: binary ? 0 : Number(addRaw) || 0,
      removed: binary ? 0 : Number(delRaw) || 0,
      binary,
    });
  }
  return artifacts;
}

/**
 * @param {object} opts
 * @param {string} [opts.cwd]    repository to read
 * @param {string} [opts.since]  inclusive lower bound (any git date expression)
 * @param {string} [opts.until]  exclusive upper bound
 * @returns {Promise<{source: string, meta: object, records: import('../lib/records.mjs').Record[]}>}
 */
export async function collect({ cwd = process.cwd(), since, until } = {}) {
  const format = REC + ['%H', '%an', '%ae', '%aI', '%P', '%s', '%b'].join(FLD) + FLD;
  // Rename detection is on by default; parseNumstat handles the `old => new` form.
  const args = ['log', `--pretty=format:${format}`, '--numstat', '--no-color'];
  if (since) args.push(`--since=${since}`);
  if (until) args.push(`--until=${until}`);

  let stdout = '';
  try {
    // A busy monorepo can produce a lot of numstat. Give it room.
    ({ stdout } = await run('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }));
  } catch (err) {
    throw new Error(`git log failed in ${cwd}: ${err.stderr || err.message}`);
  }

  const records = [];
  for (const chunk of stdout.split(REC)) {
    if (!chunk.trim()) continue;
    const f = chunk.split(FLD);
    if (f.length < 7) continue;
    const [sha, name, email, iso, parents, subject, body] = f;
    const numstat = f[7] || '';

    records.push({
      id: sha.trim(),
      shortId: sha.trim().slice(0, 7),
      source: 'git',
      timestamp: iso.trim(),
      actor: name.trim(),
      actorId: actorId(name),
      automated: isAutomated(name, email),
      title: subject.trim(),
      body: (body || '').trim(),
      // A merge has two or more parents. In town terms: a treaty.
      parents: parents.trim() ? parents.trim().split(/\s+/) : [],
      // The one record with no ancestor. Only a source that has ancestry can
      // claim this; see journal.mjs, where nothing is ever a founding.
      root: !parents.trim(),
      artifacts: parseNumstat(numstat),
    });
  }

  const meta = { cwd, since, until, repo: await repoName(cwd), head: records[0]?.id ?? null };
  return { source: id, meta, records };
}

async function repoName(cwd) {
  try {
    const { stdout } = await run('git', ['rev-parse', '--show-toplevel'], { cwd });
    return stdout.trim().split(/[\\/]/).pop();
  } catch {
    return 'unknown';
  }
}

/** Every distinct calendar day that has any history at all. */
export async function activeDays({ cwd = process.cwd() } = {}) {
  const { stdout } = await run('git', ['log', '--format=%ad', '--date=short'], {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
  });
  return [...new Set(stdout.split('\n').map((s) => s.trim()).filter(Boolean))].sort();
}
