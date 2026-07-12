/**
 * Dispatch validation.
 *
 * The editor is an agent, and agents are enthusiastic. This module is the part
 * of the town that says "cite your source". A notice with no provable origin
 * does not run.
 */

const NOTICE_NO = /^\d{2}-\d{3}$/;

export function validateDispatch(d, survey) {
  const errs = [];
  const bad = (m) => errs.push(m);

  if (!d || typeof d !== 'object') return ['dispatch is not an object'];
  if (d.version !== 1) bad(`version must be 1 (got ${JSON.stringify(d.version)})`);
  if (d.date !== survey.date) bad(`dispatch date "${d.date}" does not match the day surveyed ("${survey.date}")`);
  if (!Number.isInteger(d.issue) || d.issue < 1) bad('issue must be a positive integer');

  const str = (v, name, max, min = 1) => {
    if (typeof v !== 'string' || v.trim().length < min) return bad(`${name} is required`);
    if (v.length > max) bad(`${name} is ${v.length} chars; max ${max}`);
  };

  str(d.headline, 'headline', 90);
  str(d.standfirst, 'standfirst', 220);
  str(d.gerald, 'gerald', 300);

  const known = new Set(survey.acts.flatMap((a) => [a.id, a.shortId]));

  if (!Array.isArray(d.notices) || d.notices.length === 0) {
    bad('at least one notice is required');
  } else {
    if (d.notices.length > 6) bad(`${d.notices.length} notices; max 6 (the town has a limited attention span)`);
    d.notices.forEach((n, i) => {
      const at = `notices[${i}]`;
      if (!NOTICE_NO.test(String(n.no || ''))) bad(`${at}.no must look like "11-031"`);
      str(n.title, `${at}.title`, 90);
      str(n.body, `${at}.body`, 700);
      // The load-bearing rule of this whole project.
      if (!n.origin) {
        bad(`${at} has no origin — every notice must cite the record it came from`);
      } else if (!known.has(String(n.origin).trim())) {
        bad(`${at}.origin "${n.origin}" is not a record from ${survey.date}. The town does not print rumours.`);
      }
    });
  }

  if (!Array.isArray(d.ticker) || d.ticker.length === 0) {
    bad('ticker needs at least one line');
  } else if (d.ticker.length > 6) {
    bad(`${d.ticker.length} ticker lines; max 6`);
  } else {
    d.ticker.forEach((t, i) => str(t, `ticker[${i}]`, 140));
  }

  if (d.minute) {
    str(d.minute.session, 'minute.session', 90);
    str(d.minute.text, 'minute.text', 500);
  }

  return errs;
}

/** Notices must be traceable, so we attach the real record to each one. */
export function attachProvenance(d, survey, meta) {
  const byId = new Map();
  for (const a of survey.acts) {
    byId.set(a.id, a);
    byId.set(a.shortId, a);
  }
  const notices = d.notices.map((n) => {
    const a = byId.get(String(n.origin).trim());
    return {
      ...n,
      origin: a.shortId,
      // This is what makes the joke tangible: the true thing behind the notice.
      truth: {
        id: a.shortId,
        actor: a.actor,
        title: a.title,
        kind: a.kind,
        churn: a.churn,
        files: a.files,
        wards: a.wards,
        timestamp: a.timestamp,
      },
    };
  });

  return {
    ...d,
    notices,
    provenance: {
      source: meta.source,
      repo: meta.repo,
      records: survey.acts.length,
      churn: survey.totals.churn,
      generatedAt: meta.generatedAt || null,
      editor: meta.editor || 'unknown',
    },
  };
}
