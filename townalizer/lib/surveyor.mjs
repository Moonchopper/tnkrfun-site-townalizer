/**
 * The Surveyor.
 *
 * Turns Records into town facts. Deterministic, opinionated, and entirely
 * humourless — the jokes are the editor's job, not the surveyor's. Everything
 * here must be defensible against the actual history, because every notice the
 * town prints is traceable back to a record id.
 *
 * The surveyor knows nothing about git. It knows about paths, actors, churn,
 * and time. Feed it journal entries and it will survey those instead.
 */

/** Directories that are not places. Nobody lives in node_modules. */
const NOT_A_PLACE = /^(node_modules|\.git|dist|build|coverage|vendor|\.venv|__pycache__)(\/|$)/;

/**
 * Known districts of the working world, given the names they deserve.
 * Anything unlisted gets a deterministic fallback, so an unfamiliar repo still
 * produces a coherent map instead of a shrug.
 */
const WARD_LEXICON = {
  '(root)': 'The Commons',
  src: 'The Works',
  lib: 'The Foundry',
  app: 'The Works',
  test: 'The Inspectorate',
  tests: 'The Inspectorate',
  spec: 'The Inspectorate',
  docs: 'The Archive',
  doc: 'The Archive',
  '.github': "The Clerk's Office",
  nginx: 'The Waterworks',
  // Distinct names on purpose: two wards sharing a label is indistinguishable
  // from a fault in the map, and the town has enough of those.
  manifests: 'The Register',
  helm: 'The Hall of Records',
  charts: 'The Chart Room',
  k8s: 'The Engine House',
  site: 'The Public Grounds',
  // The history predates the town. Paths under district11/ are the parcel as it
  // stood before we took it, and the map still calls that quarter the Old Town.
  district11: 'The Old Town',
  istoletha: 'The Town Proper',
  townalizer: 'The Survey Office',
  scripts: 'The Utility Yard',
  bin: 'The Utility Yard',
  assets: 'The Storehouse',
  static: 'The Storehouse',
  public: 'The Storehouse',
  config: 'The Bureau of Standards',
  api: 'The Exchange',
  server: 'The Exchange',
  db: 'The Cistern',
  migrations: 'The Cistern',
  journal: 'The Diarist’s Room',
};

const TITLE = (s) =>
  s.replace(/[-_.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();

export function wardIdFor(filePath) {
  const clean = String(filePath || '').replace(/^\.\//, '');
  if (NOT_A_PLACE.test(clean)) return null;
  const top = clean.includes('/') ? clean.split('/')[0] : '(root)';
  return top || '(root)';
}

export function wardNameFor(wardId) {
  return WARD_LEXICON[wardId] || `The ${TITLE(wardId)} Ward`;
}

/* ── Classification ────────────────────────────────────────────────────────
   One record becomes one civic act. Order matters: the first rule that fits
   wins, because a merge that also fixes a bug is, first and foremost, a treaty. */

const KINDS = {
  founding: { verb: 'founded', noun: 'an act of founding' },
  treaty: { verb: 'ratified', noun: 'a treaty' },
  retraction: { verb: 'retracted', noun: 'a public retraction' },
  annexation: { verb: 'annexed', noun: 'an annexation' },
  demolition: { verb: 'demolished', noun: 'a demolition' },
  repair: { verb: 'repaired', noun: 'a repair' },
  resurvey: { verb: 're-surveyed', noun: 'a re-survey' },
  inspection: { verb: 'inspected', noun: 'an inspection' },
  signage: { verb: 'posted', noun: 'an act of signage' },
  filing: { verb: 'filed', noun: 'a filing' },
  works: { verb: 'raised', noun: 'public works' },
};

export function classify(record) {
  const t = `${record.title} ${record.body}`.toLowerCase();
  const paths = record.artifacts.map((a) => a.path);
  const added = record.artifacts.reduce((n, a) => n + a.added, 0);
  const removed = record.artifacts.reduce((n, a) => n + a.removed, 0);
  const churn = added + removed;

  // Only a source with ancestry can have a founding record. A journal has no
  // parents by nature, and every entry claiming to found the town is a bug.
  if (record.root) return 'founding';
  if (record.parents.length > 1) return 'treaty';
  if (/^revert\b|\brevert(ed|s)?\b|\bback out\b|\bundo\b/.test(t)) return 'retraction';

  // Submodules and vendored trees are territory acquired, not built.
  if (paths.some((p) => /\.gitmodules$/.test(p)) || /\bsubmodule\b|\bannex\b/.test(t)) {
    return 'annexation';
  }

  if (record.automated) return 'filing';

  // A commit that only takes things away.
  if (removed > 0 && added === 0 && record.artifacts.length > 0) return 'demolition';
  if (/^(remove|delete|drop|rm)\b|\bremoves?\b.*\b(dir|folder|file)/.test(t) && removed > added) {
    return 'demolition';
  }

  if (/^fix\b|^hotfix\b|\bfix(ed|es)?\b|\bbug\b|\bpatch\b|\btypo\b|\bincorrect\b|\bbroken\b/.test(t)) {
    return 'repair';
  }
  if (/^refactor\b|\brefactor\b|\brename\b|\bmove[ds]?\b|\brestructure\b|\bextract\b|\bcleanup\b/.test(t)) {
    return 'resurvey';
  }

  const dominant = (re) =>
    paths.length > 0 && paths.filter((p) => re.test(p)).length / paths.length >= 0.6;
  if (dominant(/(^|\/)(test|tests|spec|__tests__)\//i) || /\btests?\b/.test(t)) return 'inspection';
  if (dominant(/\.(md|markdown|rst|txt)$/i) || /^docs?\b|\breadme\b/.test(t)) return 'signage';

  // Note: no bare /\bversion\b/ here — it swallows "initial version", which is
  // the opposite of clerical work.
  if (/^(chore|ci|build|deps|style)\b|\bbump\b|\bdeploy(ment)?\b/.test(t)) {
    // A chore that moves five hundred lines is not a chore. The town judges by
    // what was actually done, not by what the doer chose to call it.
    return !record.automated && churn >= 500 ? 'works' : 'filing';
  }

  return 'works';
}

export const churnOf = (record) =>
  record.artifacts.reduce((n, a) => n + a.added + a.removed, 0);

export function magnitudeOf(churn) {
  if (churn >= 2000) return 'monumental';
  if (churn >= 500) return 'major';
  if (churn >= 100) return 'notable';
  if (churn >= 10) return 'minor';
  return 'trivial';
}

/* ── Survey ──────────────────────────────────────────────────────────────── */

const iso = (ts) => String(ts).slice(0, 10);

/**
 * Survey a set of records.
 *
 * @param {Record[]} records  the records in scope (e.g. one day's)
 * @param {object} [ctx]
 * @param {string[]} [ctx.priorDays]  every active day before this scope, ascending.
 *                                    Used to measure how long the town was quiet.
 * @param {string} [ctx.date]         the day being surveyed
 */
export function survey(records, ctx = {}) {
  const acts = records.map((r) => {
    const churn = churnOf(r);
    const kind = classify(r);
    const wards = [
      ...new Set(r.artifacts.map((a) => wardIdFor(a.path)).filter(Boolean)),
    ];
    const when = new Date(r.timestamp);
    const hour = Number.isNaN(when.getTime()) ? 12 : when.getUTCHours();
    const day = Number.isNaN(when.getTime()) ? 2 : when.getUTCDay();
    return {
      id: r.id,
      shortId: r.shortId,
      actor: r.actor,
      actorId: r.actorId,
      automated: r.automated,
      title: r.title,
      timestamp: r.timestamp,
      kind,
      verb: KINDS[kind].verb,
      churn,
      magnitude: magnitudeOf(churn),
      wards,
      files: r.artifacts.length,
      // Work done at hours no reasonable office keeps. The town notices.
      afterHours: hour >= 20 || hour < 6,
      weekend: day === 0 || day === 6,
    };
  });

  /* Citizens: who did what, and how much of it. */
  const citizens = new Map();
  for (const a of acts) {
    const c = citizens.get(a.actorId) || {
      id: a.actorId,
      name: a.actor,
      automated: a.automated,
      acts: 0,
      churn: 0,
      kinds: {},
    };
    c.acts += 1;
    c.churn += a.churn;
    c.kinds[a.kind] = (c.kinds[a.kind] || 0) + 1;
    citizens.set(a.actorId, c);
  }

  /* Wards touched today, with the volume of work done in each. */
  const wards = new Map();
  for (const r of records) {
    for (const art of r.artifacts) {
      const wid = wardIdFor(art.path);
      if (!wid) continue;
      const w = wards.get(wid) || { id: wid, name: wardNameFor(wid), touches: 0, churn: 0, files: new Set() };
      w.touches += 1;
      w.churn += art.added + art.removed;
      w.files.add(art.path);
      wards.set(wid, w);
    }
  }

  /* The Clerk's litany: the same message, filed again, and again, and again. */
  const messages = new Map();
  for (const a of acts) {
    const key = a.title.toLowerCase().replace(/\s+/g, ' ').trim();
    messages.set(key, (messages.get(key) || 0) + 1);
  }
  const repeated = [...messages.entries()]
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1])
    .map(([title, count]) => ({ title, count }));

  /* How long the town was quiet before today. Silence is a civic condition. */
  const priorDays = ctx.priorDays || [];
  const last = priorDays.length ? priorDays[priorDays.length - 1] : null;
  const gapDays = last && ctx.date
    ? Math.round((Date.parse(ctx.date) - Date.parse(last)) / 86400000)
    : null;

  const totalChurn = acts.reduce((n, a) => n + a.churn, 0);
  const byKind = acts.reduce((m, a) => ((m[a.kind] = (m[a.kind] || 0) + 1), m), {});

  return {
    date: ctx.date || (records.length ? iso(records[records.length - 1].timestamp) : null),
    acts,
    citizens: [...citizens.values()].sort((a, b) => b.churn - a.churn),
    wards: [...wards.values()]
      .map((w) => ({ ...w, files: [...w.files] }))
      .sort((a, b) => b.churn - a.churn),
    repeated,
    totals: {
      acts: acts.length,
      churn: totalChurn,
      magnitude: magnitudeOf(totalChurn),
      byKind,
      afterHours: acts.filter((a) => a.afterHours).length,
      weekend: acts.filter((a) => a.weekend).length,
    },
    quiet: { sinceLastActiveDay: gapDays, lastActiveDay: last },
  };
}

export { KINDS };
