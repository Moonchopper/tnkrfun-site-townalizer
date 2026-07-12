#!/usr/bin/env node
/**
 * townalizer — turn a history of work into a town that reacts to it.
 *
 *   node townalizer/cli.mjs days                  which days have any history
 *   node townalizer/cli.mjs dossier --date D      the facts of one day, for the editor
 *   node townalizer/cli.mjs apply --file F        validate a dispatch, replay the town
 *   node townalizer/cli.mjs rebuild               replay every dispatch from scratch
 *   node townalizer/cli.mjs status                what the town looks like now
 *
 * The editor (an agent) only ever sees `dossier` and only ever writes a dispatch.
 * Everything factual happens in here, where it can be checked.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSource, listSources } from './sources/index.mjs';
import { survey } from './lib/surveyor.mjs';
import { loadState, saveState, emptyState, advance, merge, STATUS_WORDS } from './lib/state.mjs';
import { validateDispatch, attachProvenance } from './lib/validate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = path.join(ROOT, 'townalizer', 'townalizer.config.json');

const DEFAULTS = {
  source: 'git',
  cwd: '.',
  stateFile: 'istoletha/data/town-state.json',
  dispatchDir: 'istoletha/data/dispatches',
};

/* ── plumbing ─────────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const cmd = argv[0];
  const flags = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, inline] = a.slice(2).split('=');
    if (inline !== undefined) flags[k] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
    else flags[k] = true;
  }
  return { cmd, flags };
}

async function loadConfig(flags) {
  let cfg = { ...DEFAULTS };
  try {
    Object.assign(cfg, JSON.parse(await readFile(CONFIG_FILE, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (flags.source) cfg.source = flags.source;
  if (flags.repo) cfg.cwd = flags.repo;

  // --town gives a body of work its own town: its own state, its own back issues.
  // Without it you get the built-in one, whose history is this repository.
  if (flags.town) {
    cfg.stateFile = `towns/${flags.town}/town-state.json`;
    cfg.dispatchDir = `towns/${flags.town}/dispatches`;
    cfg.townName = flags.name || flags.town;
  }
  if (flags.name) cfg.townName = flags.name;
  if (flags.state) cfg.stateFile = flags.state;
  if (flags.dispatches) cfg.dispatchDir = flags.dispatches;

  return {
    ...cfg,
    cwd: path.resolve(ROOT, cfg.cwd),
    stateFile: path.resolve(ROOT, cfg.stateFile),
    dispatchDir: path.resolve(ROOT, cfg.dispatchDir),
  };
}

const dayOf = (r) => String(r.timestamp).slice(0, 10);
const out = (o) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');

const shiftDays = (iso, n) =>
  new Date(Date.parse(iso) + n * 86400000).toISOString().slice(0, 10);

/** Group records by author-local calendar day. */
function byDay(records) {
  const m = new Map();
  for (const r of records) {
    const d = dayOf(r);
    if (!m.has(d)) m.set(d, []);
    m.get(d).push(r);
  }
  return m;
}

async function readDispatches(dir) {
  let names = [];
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return [];
  }
  const files = names.filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
  const list = [];
  for (const f of files) {
    list.push(JSON.parse(await readFile(path.join(dir, f), 'utf8')));
  }
  return list;
}

/* ── commands ─────────────────────────────────────────────────────────────── */

async function cmdDays(cfg) {
  const src = getSource(cfg.source);
  const days = await src.activeDays({ cwd: cfg.cwd });
  const done = new Set((await readDispatches(cfg.dispatchDir)).map((d) => d.date));
  out({
    source: cfg.source,
    repo: cfg.cwd,
    total: days.length,
    days: days.map((d) => ({ date: d, reported: done.has(d) })),
    unreported: days.filter((d) => !done.has(d)),
  });
}

/**
 * The dossier is everything the editor is allowed to know: the true, surveyed
 * facts of one day, plus the town as it stood the evening before.
 */
async function cmdDossier(cfg, flags) {
  const date = flags.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    throw new Error('dossier needs --date YYYY-MM-DD');
  }
  const src = getSource(cfg.source);

  // Pad the window: a day is a local-calendar concept, timezones are not.
  const { records, meta } = await src.collect({
    cwd: cfg.cwd,
    since: shiftDays(date, -3),
    until: shiftDays(date, 3),
  });

  const today = records.filter((r) => dayOf(r) === date);
  if (today.length === 0) {
    throw new Error(`no history on ${date}. Try: node townalizer/cli.mjs days`);
  }

  const allDays = await src.activeDays({ cwd: cfg.cwd });
  const priorDays = allDays.filter((d) => d < date);
  const s = survey(today, { date, priorDays });

  const state = await loadState(cfg.stateFile);
  const dispatches = await readDispatches(cfg.dispatchDir);
  const issue = (dispatches.length ? Math.max(...dispatches.map((d) => d.issue || 0)) : 0) + 1;

  out({
    date,
    issue,
    source: cfg.source,
    repo: meta.repo,
    survey: s,
    // The town as the editor inherits it — so the day can continue a story
    // rather than restart one.
    townBefore: {
      asOf: state.asOf,
      status: state.civic.status,
      souls: state.civic.souls,
      actsRecorded: state.civic.actsRecorded,
      longestSilence: state.civic.longestSilence,
      citizens: Object.values(state.citizens).map((c) => ({
        id: c.id, name: c.name, automated: c.automated, epithet: c.epithet, acts: c.acts,
      })),
      wards: Object.values(state.wards).map((w) => ({
        id: w.id, name: w.name, condition: w.condition, buildings: w.buildings.length, note: w.note,
      })),
      landmarks: state.landmarks.map((l) => ({ id: l.id, name: l.name, ward: l.ward, raisedOn: l.raisedOn })),
      sagas: state.sagas.map((s2) => ({
        id: s2.id, title: s2.title, status: s2.status, beats: s2.beats.length,
        latest: s2.beats.at(-1)?.text ?? null,
      })),
    },
    vocabulary: {
      statusWords: STATUS_WORDS,
      kinds: [...new Set(s.acts.map((a) => a.kind))],
    },
  });
}

/**
 * Replay the town from nothing, using the dispatches on disk as the record of
 * what was said and the source history as the record of what was true.
 */
async function replay(cfg) {
  const src = getSource(cfg.source);
  const dispatches = await readDispatches(cfg.dispatchDir);
  if (dispatches.length === 0) {
    return { state: emptyState(cfg.townName), dispatches, meta: { repo: path.basename(cfg.cwd) } };
  }

  const earliest = dispatches[0].date;
  const { records, meta } = await src.collect({ cwd: cfg.cwd, since: shiftDays(earliest, -3) });
  const days = byDay(records);
  const allDays = await src.activeDays({ cwd: cfg.cwd });

  let state = emptyState(cfg.townName);
  state.sources = [{ source: cfg.source, repo: meta.repo }];

  const refreshed = [];
  for (const d of dispatches) {
    const dayRecords = days.get(d.date) || [];
    if (dayRecords.length === 0) {
      throw new Error(`dispatch ${d.date} refers to a day with no history in ${meta.repo}`);
    }
    const s = survey(dayRecords, { date: d.date, priorDays: allDays.filter((x) => x < d.date) });

    const errs = validateDispatch(d, s);
    if (errs.length) {
      throw new Error(`dispatch ${d.date} is not fit to print:\n  - ${errs.join('\n  - ')}`);
    }

    state = advance(state, s);                // facts
    state = merge(state, d.stateChanges, s);  // flavour

    // Provenance is derived, not authored: re-attach it from the current survey so
    // that improving the surveyor updates every dispatch ever printed, instead of
    // leaving old issues carrying a stale shape.
    refreshed.push(
      attachProvenance(d, s, {
        source: cfg.source,
        repo: meta.repo,
        generatedAt: d.provenance?.generatedAt ?? null,
        editor: d.provenance?.editor ?? 'agent',
      }),
    );
  }

  return { state, dispatches: refreshed, meta };
}

async function writeIndex(cfg, dispatches) {
  const index = dispatches
    .map((d) => ({
      date: d.date,
      issue: d.issue,
      headline: d.headline,
      standfirst: d.standfirst,
      notices: d.notices.length,
      records: d.provenance?.records ?? null,
      churn: d.provenance?.churn ?? null,
    }))
    .sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first, as news is
  await mkdir(cfg.dispatchDir, { recursive: true });
  await writeFile(
    path.join(cfg.dispatchDir, 'index.json'),
    JSON.stringify({ version: 1, count: index.length, dispatches: index }, null, 2) + '\n',
    'utf8',
  );
  return index;
}

async function cmdApply(cfg, flags) {
  const file = flags.file;
  if (!file) throw new Error('apply needs --file path/to/dispatch.json');

  const draft = JSON.parse(await readFile(path.resolve(ROOT, file), 'utf8'));
  const src = getSource(cfg.source);

  const { records, meta } = await src.collect({
    cwd: cfg.cwd,
    since: shiftDays(draft.date, -3),
    until: shiftDays(draft.date, 3),
  });
  const today = records.filter((r) => dayOf(r) === draft.date);
  const allDays = await src.activeDays({ cwd: cfg.cwd });
  const s = survey(today, { date: draft.date, priorDays: allDays.filter((d) => d < draft.date) });

  const errs = validateDispatch(draft, s);
  if (errs.length) {
    process.stderr.write(`\nThe dispatch was refused:\n  - ${errs.join('\n  - ')}\n\n`);
    process.exit(1);
  }

  // A dry run in the merge sense: prove the flavour is citable before writing.
  merge(advance(await loadState(cfg.stateFile), s), draft.stateChanges, s);

  const final = attachProvenance(draft, s, {
    source: cfg.source,
    repo: meta.repo,
    generatedAt: flags.now || null,
    editor: flags.editor || 'agent',
  });

  await mkdir(cfg.dispatchDir, { recursive: true });
  await writeFile(
    path.join(cfg.dispatchDir, `${draft.date}.json`),
    JSON.stringify(final, null, 2) + '\n',
    'utf8',
  );

  // Rebuild rather than mutate, so re-applying a day is safe and editing an old
  // dispatch corrects everything downstream of it.
  const { state, dispatches } = await replay(cfg);
  await saveState(cfg.stateFile, state);
  const index = await writeIndex(cfg, dispatches);

  out({
    ok: true,
    printed: `${draft.date}.json`,
    issue: final.issue,
    notices: final.notices.length,
    town: {
      asOf: state.asOf,
      status: state.civic.status,
      souls: state.civic.souls,
      wards: Object.keys(state.wards).length,
      landmarks: state.landmarks.length,
      sagas: state.sagas.length,
    },
    dispatches: index.length,
  });
}

async function cmdRebuild(cfg) {
  const { state, dispatches } = await replay(cfg);
  await saveState(cfg.stateFile, state);

  // Write the re-provenanced dispatches back, so every issue on disk reflects the
  // surveyor as it stands today.
  for (const d of dispatches) {
    await writeFile(
      path.join(cfg.dispatchDir, `${d.date}.json`),
      JSON.stringify(d, null, 2) + '\n',
      'utf8',
    );
  }

  const index = await writeIndex(cfg, dispatches);
  out({
    ok: true,
    replayed: index.length,
    town: {
      asOf: state.asOf,
      status: state.civic.status,
      souls: state.civic.souls,
      wards: Object.keys(state.wards).length,
      landmarks: state.landmarks.length,
      sagas: state.sagas.length,
    },
  });
}

/**
 * Bundle the whole town into one self-contained page.
 *
 * An Artifact may not fetch anything — strict CSP, and no data/ directory beside
 * it — so the town has to travel with the page. We inline the state and every
 * dispatch as `window.__TOWN__`, which the site's `get()` prefers over fetch().
 *
 * With --artifact we also strip the document wrapper (doctype/html/head/body),
 * because the Artifact host supplies its own and nesting them produces a mess.
 */
async function cmdBundle(cfg, flags) {
  const srcFile = path.resolve(ROOT, flags.in || 'istoletha/index.html');
  const outFile = path.resolve(ROOT, flags.out || 'istoletha/bundle.html');
  const artifact = !!flags.artifact;

  const html = await readFile(srcFile, 'utf8');
  const state = await loadState(cfg.stateFile);
  const dispatches = await readDispatches(cfg.dispatchDir);
  if (!dispatches.length) throw new Error('no dispatches to bundle; run apply first');

  const index = JSON.parse(
    await readFile(path.join(cfg.dispatchDir, 'index.json'), 'utf8'),
  );

  const town = {
    state,
    index,
    dispatches: Object.fromEntries(dispatches.map((d) => [d.date, d])),
  };

  // </script> inside JSON would close our own tag early. It is the one sequence
  // that can escape the string, so it is the one sequence we neutralise.
  const payload = JSON.stringify(town).replace(/<\/script/gi, '<\\/script');
  const inject = `<script>window.__TOWN__=${payload};</script>`;

  let page;
  if (artifact) {
    const title = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? 'Istoletha Town';
    const style = html.match(/<style>[\s\S]*?<\/style>/i)?.[0] ?? '';
    const body = html.match(/<body>([\s\S]*?)<\/body>/i)?.[1] ?? '';
    if (!style || !body) throw new Error('could not find <style> or <body> in the source page');
    // No doctype/html/head/body — the host wraps this. The favicon <link> is
    // dropped too; the Artifact takes its icon from the publish call.
    page = `<title>${title}</title>\n${style}\n${inject}\n${body}\n`;
  } else {
    page = html.replace('</head>', `${inject}\n</head>`);
  }

  await writeFile(outFile, page, 'utf8');

  out({
    ok: true,
    wrote: path.relative(ROOT, outFile),
    mode: artifact ? 'artifact (no document wrapper)' : 'standalone page',
    bytes: Buffer.byteLength(page),
    dispatches: dispatches.length,
    // Only subresources matter: the CSP blocks anything the page *loads*, but an
    // <a href> to another site merely takes you there, which is allowed and fine.
    externalSubresources: [
      ...page.matchAll(/\ssrc=["']https?:[^"']*/gi),
      ...page.matchAll(/<link[^>]+href=["']https?:[^"']*/gi),
      ...page.matchAll(/@import[^;]*https?:[^;]*/gi),
      ...page.matchAll(/url\(\s*["']?https?:[^)]*/gi),
    ].map((m) => m[0].trim().slice(0, 60)),
  });
}

async function cmdStatus(cfg) {
  const state = await loadState(cfg.stateFile);
  out({
    asOf: state.asOf,
    civic: state.civic,
    citizens: Object.values(state.citizens).map((c) => ({
      name: c.name, epithet: c.epithet, acts: c.acts, automated: c.automated,
    })),
    wards: Object.values(state.wards).map((w) => ({
      name: w.name, condition: w.condition, buildings: w.buildings.length,
    })),
    landmarks: state.landmarks.map((l) => l.name),
    sagas: state.sagas.map((s) => `${s.title} (${s.status}, ${s.beats.length} beats)`),
    days: state.ledger.days.length,
  });
}

/* ── main ─────────────────────────────────────────────────────────────────── */

const USAGE = `townalizer — a town that reacts to a history of work

  days                       list days with history, and whether each was reported
  dossier --date YYYY-MM-DD  the surveyed facts of one day (what the editor reads)
  apply   --file <path>      validate a dispatch, print it, replay the town
  rebuild                    replay every dispatch from scratch
  bundle  [--artifact]       inline the whole town into one self-contained page
  status                     the town as it currently stands

Options:
  --source <id>   ${listSources().map((s) => s.id).join(' | ')}   (default: git)
  --repo <path>   history to read (default: this repository)
  --town <slug>   give that history its own town: towns/<slug>/ holds its state
                  and its back issues, separate from every other town
  --name "Name"   what that town calls itself (default: the slug)

  A town is one body of work. Point --repo at a project and --town at a name for
  it, and the same Office will survey it, in the same voice, keeping its own map.

    node townalizer/cli.mjs days    --repo ../my-app --town my-app
    node townalizer/cli.mjs dossier --repo ../my-app --town my-app --date 2026-07-11
    node townalizer/cli.mjs bundle  --town my-app --out my-app-town.html
`;

async function main() {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  if (!cmd || flags.help || cmd === 'help') {
    process.stdout.write(USAGE);
    return;
  }
  const cfg = await loadConfig(flags);
  const commands = {
    days: cmdDays,
    dossier: cmdDossier,
    apply: cmdApply,
    rebuild: cmdRebuild,
    bundle: cmdBundle,
    status: cmdStatus,
  };
  const fn = commands[cmd];
  if (!fn) {
    process.stderr.write(`unknown command "${cmd}"\n\n${USAGE}`);
    process.exit(1);
  }
  await fn(cfg, flags);
}

main().catch((err) => {
  process.stderr.write(`\n${err.message}\n`);
  process.exit(1);
});
