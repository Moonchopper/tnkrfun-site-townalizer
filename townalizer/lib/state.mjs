/**
 * Town state: the thing that makes this a town and not a changelog.
 *
 * State advances in two strictly separate movements:
 *
 *   1. advance(state, survey)  — FACTS. Derived from the records. Who worked,
 *      which wards they touched, how much, what decayed. The editor cannot
 *      influence this and cannot fake it.
 *
 *   2. merge(state, changes)   — FLAVOUR. The editor's contributions: landmark
 *      names, saga beats, epithets, the civic mood. Every one must cite a record
 *      id that genuinely exists in the day being reported, or it is rejected.
 *
 * That split is the whole safety model. The town can be strange, but it cannot
 * be false.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { wardNameFor } from './surveyor.mjs';

export const STATE_VERSION = 1;

export function emptyState() {
  return {
    version: STATE_VERSION,
    town: {
      name: 'Istoletha Town',
      motto: 'Adhuc Hic',
      // The dates belong to District 11. We kept them. We kept everything.
      established: '1952',
      dissolved: '1994',
      acquired: '2026',
      predecessor: 'District 11',
    },
    asOf: null,
    sources: [],
    citizens: {},
    wards: {},
    landmarks: [],
    sagas: [],
    civic: {
      status: 'ROUTINE',
      statusNote: 'Routine is a choice we make daily.',
      souls: 0,
      actsRecorded: 0,
      churnRecorded: 0,
      longestSilence: 0,
    },
    ledger: { days: [], lastRecordId: null },
  };
}

export async function loadState(file) {
  try {
    const raw = await readFile(file, 'utf8');
    const s = JSON.parse(raw);
    if (s.version !== STATE_VERSION) {
      throw new Error(`town-state.json is version ${s.version}, expected ${STATE_VERSION}`);
    }
    return s;
  } catch (err) {
    if (err.code === 'ENOENT') return emptyState();
    throw err;
  }
}

export async function saveState(file, state) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

/* ── Ward condition: how a place looks when nobody has been for a while ──── */

const DAY = 86400000;

export function conditionFor(lastSeen, asOf) {
  const age = Math.round((Date.parse(asOf) - Date.parse(lastSeen)) / DAY);
  if (Number.isNaN(age)) return 'fair';
  if (age <= 14) return 'maintained';
  if (age <= 60) return 'fair';
  if (age <= 180) return 'worn';
  return 'derelict';
}

/* ── 1. FACTS ────────────────────────────────────────────────────────────── */

/**
 * Fold one day's survey into the state. Pure and idempotent with respect to
 * the day: applying the same survey twice is guarded by ledger.days upstream.
 */
export function advance(state, survey) {
  const next = structuredClone(state);
  const date = survey.date;
  next.asOf = date;

  for (const c of survey.citizens) {
    const prev = next.citizens[c.id] || {
      id: c.id,
      name: c.name,
      automated: c.automated,
      epithet: null,
      firstSeen: date,
      lastSeen: date,
      acts: 0,
      churn: 0,
    };
    prev.name = c.name;
    prev.automated = c.automated;
    prev.lastSeen = date;
    prev.acts += c.acts;
    prev.churn += c.churn;
    next.citizens[c.id] = prev;
  }

  for (const w of survey.wards) {
    const prev = next.wards[w.id] || {
      id: w.id,
      name: wardNameFor(w.id),
      note: null,
      firstSeen: date,
      lastSeen: date,
      touches: 0,
      churn: 0,
      buildings: [],
      events: [],
    };
    prev.lastSeen = date;
    prev.touches += w.touches;
    prev.churn += w.churn;
    // Buildings accumulate: a file, once built, remains on the map even after
    // it is demolished. The town keeps its records. That is its only talent.
    prev.buildings = [...new Set([...prev.buildings, ...w.files])];
    prev.events = prev.events || [];
    next.wards[w.id] = prev;
  }

  // Each ward keeps a chronicle of the records that touched it, so a visitor can
  // stand in a place and read what was actually done there. Oldest first: survey
  // acts arrive newest-first, so they go in reversed.
  for (const a of [...survey.acts].reverse()) {
    for (const wid of a.wards) {
      const w = next.wards[wid];
      if (!w) continue;
      w.events.push({
        date,
        id: a.shortId,
        actor: a.actor,
        kind: a.kind,
        title: a.title,
        churn: a.churn,
      });
      // A very old ward in a very busy repository should not become the file.
      if (w.events.length > 250) w.events = w.events.slice(-250);
    }
  }

  // Everything decays relative to the new "today", including places nobody
  // visited today. Especially those.
  for (const w of Object.values(next.wards)) {
    w.condition = conditionFor(w.lastSeen, date);
  }

  next.civic.souls = Object.values(next.citizens).filter((c) => !c.automated).length;
  next.civic.actsRecorded += survey.totals.acts;
  next.civic.churnRecorded += survey.totals.churn;

  const gap = survey.quiet.sinceLastActiveDay;
  if (typeof gap === 'number' && gap > next.civic.longestSilence) {
    next.civic.longestSilence = gap;
  }

  if (!next.ledger.days.includes(date)) next.ledger.days.push(date);
  next.ledger.days.sort();
  next.ledger.lastRecordId = survey.acts[0]?.id ?? next.ledger.lastRecordId;

  return next;
}

/* ── 2. FLAVOUR ──────────────────────────────────────────────────────────── */

const STATUS_WORDS = [
  'ROUTINE', 'IRREGULAR', 'EXTANT', 'STRAINED', 'BUSY', 'DORMANT',
  'ELEVATED', 'UNSETTLED', 'CEREMONIAL', 'DIMINISHED', 'RESTLESS',
];

const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

/**
 * Apply the editor's proposed changes. Throws on any claim the records do not
 * support — an unknown ward, an invented commit, a status word off the list.
 *
 * @param {object} state
 * @param {object} changes   dispatch.stateChanges
 * @param {object} survey    the day's survey, used as the set of provable facts
 */
export function merge(state, changes = {}, survey) {
  const next = structuredClone(state);
  const date = survey.date;
  const knownRecords = new Set(survey.acts.flatMap((a) => [a.id, a.shortId]));
  const knownWards = new Set(Object.keys(next.wards));
  const knownCitizens = new Set(Object.keys(next.citizens));

  const citeOk = (origin) => knownRecords.has(String(origin || '').trim());

  if (changes.status) {
    const word = String(changes.status).toUpperCase();
    if (!STATUS_WORDS.includes(word)) {
      throw new Error(`status "${word}" is not a recognised civic condition (${STATUS_WORDS.join(', ')})`);
    }
    next.civic.status = word;
    if (changes.statusNote) next.civic.statusNote = String(changes.statusNote).slice(0, 160);
  }

  for (const lm of changes.landmarks || []) {
    if (!citeOk(lm.origin)) {
      throw new Error(`landmark "${lm.name}" cites record "${lm.origin}", which is not in this day's history`);
    }
    if (lm.ward && !knownWards.has(lm.ward)) {
      throw new Error(`landmark "${lm.name}" is in ward "${lm.ward}", which does not exist`);
    }
    const id = slug(lm.name);
    if (next.landmarks.some((x) => x.id === id)) continue; // already standing
    next.landmarks.push({
      id,
      name: String(lm.name).slice(0, 80),
      ward: lm.ward || null,
      note: lm.note ? String(lm.note).slice(0, 200) : null,
      raisedOn: date,
      origin: String(lm.origin),
    });
  }

  for (const s of changes.sagas || []) {
    const id = slug(s.id || s.title);
    if (!id) continue;
    let saga = next.sagas.find((x) => x.id === id);
    if (!saga) {
      saga = {
        id,
        title: String(s.title || s.id).slice(0, 90),
        status: 'ongoing',
        openedOn: date,
        lastBeat: date,
        beats: [],
      };
      next.sagas.push(saga);
    }
    if (s.beat) {
      const origin = s.beat.origin;
      if (origin && !citeOk(origin)) {
        throw new Error(`saga "${saga.title}" cites record "${origin}", which is not in this day's history`);
      }
      saga.beats.push({
        date,
        text: String(s.beat.text || s.beat).slice(0, 240),
        origin: origin ? String(origin) : null,
      });
      saga.lastBeat = date;
    }
    if (s.status && ['ongoing', 'resolved', 'abandoned'].includes(s.status)) {
      saga.status = s.status;
    }
  }

  for (const [cid, epithet] of Object.entries(changes.epithets || {})) {
    if (!knownCitizens.has(cid)) {
      throw new Error(`epithet given to "${cid}", who is not on the rolls`);
    }
    next.citizens[cid].epithet = String(epithet).slice(0, 80);
  }

  for (const [wid, note] of Object.entries(changes.wardNotes || {})) {
    if (!knownWards.has(wid)) {
      throw new Error(`note attached to ward "${wid}", which does not exist`);
    }
    next.wards[wid].note = String(note).slice(0, 200);
  }

  return next;
}

export { STATUS_WORDS };
