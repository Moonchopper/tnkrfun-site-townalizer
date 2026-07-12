# How the townalizer works

A tour of the machinery: what runs, who runs it, and where an LLM is allowed to touch
anything. Written 2026-07-12, when the pipeline was eleven issues old.

For commands, see the [README](../README.md). This document is about the *shape* of the
thing, and the reasoning behind it — the parts that will still be true after the commands
change.

---

## The one-sentence model

> **Git history is the truth. A dispatch is the story. Everything else is derived and can
> be deleted.**

If you remember one thing, remember that. It explains the file layout, the validator, the
rebuild-instead-of-mutate design, and why the LLM is boxed in as tightly as it is.

---

## The pipeline

```
   your commits                     ← you, doing ordinary work
        │
        ▼
   sources/git.mjs                  reads git log, emits generic Records.
        │                           Knows about git; knows nothing about towns.
        │                           (sources/journal.mjs does the same for dated
        │                            markdown, and exists to prove the seam is real.)
        ▼
   lib/surveyor.mjs                 Records → town facts. Deterministic and humourless.
        │                           directories → wards        a revert  → a retraction
        │                           a merge     → a treaty     the bot   → the Clerk
        │                           churn       → magnitude    silence   → a quiet season
        ▼
   cli.mjs dossier                  "here is one day, surveyed, plus the town as it stood
        │                            last night."
        │                           ◄── THE ONLY THING AN LLM EVER SEES
        ▼
   ╔══════════════════════╗
   ║   THE EDITOR         ║         The single LLM step (.claude/skills/dispatch).
   ║   (an agent)         ║         Writes prose and flavour. Cannot compute a fact,
   ╚══════════════════════╝         cannot read the repository, cannot invent a record.
        │
        │  a dispatch (JSON)
        ▼
   cli.mjs apply                    validate → refuse anything uncited
        │                           → print the issue → replay the whole town
        ▼
   istoletha/data/*.json            committed JSON; the website reads it
        │
        ▼
   git push                         GitHub Pages rebuilds and deploys, unasked
```

---

## Source of truth vs. derived

The single most useful distinction in the codebase, because it tells you what is safe to
throw away.

| Thing | Status |
| --- | --- |
| Git history | **Truth.** Not ours; we only read it. |
| `istoletha/data/dispatches/YYYY-MM-DD.json` | **Truth.** The only artefact an LLM ever authored. |
| `istoletha/data/town-state.json` | *Derived.* Rebuilt by replaying every dispatch. |
| `istoletha/data/dispatches/index.json` | *Derived.* |
| the `truth:` block inside each dispatch | *Derived.* Re-attached on every rebuild. |

Delete the derived files, run `rebuild`, and they come back identical. This is not a
convenience — it is the reason you can **edit or delete a bad old issue and have every
issue after it correct itself**. State is never mutated in place; it is replayed.

It is also why improving the surveyor retroactively improves all past issues: `rebuild`
re-runs the survey for every reported day and re-attaches provenance.

---

## Who does what

### You drive this. All of it.

| Step | Command | LLM? |
| --- | --- | --- |
| Write code | *(ordinary work)* | no |
| See which days have no issue yet | `node townalizer/cli.mjs days` | no |
| **Write the issue** | **`/dispatch`** | **yes — the only one** |
| Publish | `git commit && git push` | no |

### Automated

| What | Trigger |
| --- | --- |
| GitHub Pages rebuild + deploy | any push to the branch Pages is watching |

**That is the complete list.** There is no cron, no scheduler, no watcher, no hook.
Commit and never run `/dispatch`, and the day sits unreported indefinitely. `days` will
keep telling you so.

This is deliberate for now — the voice is the fragile part, and a human reading each issue
before it ships is the only quality gate that exists.

---

## Where the LLM gets involved

Exactly one step, and it is on a short leash. The `/dispatch` skill
(`.claude/skills/dispatch/SKILL.md`) does four things:

1. `days` — pick the earliest unreported day (order matters; sagas depend on sequence)
2. `dossier --date D` — read the surveyed facts. **This is all it ever sees.** It does not
   run git. It does not read the repository. It does not see other days.
3. Write the dispatch JSON — headline, standfirst, notices, ticker, minute, Gerald's line,
   and a *constrained* set of state changes
4. `apply --file` — which validates the result and refuses it if it does not hold up

### The trust boundary

This is the whole safety model, and it is worth stating plainly:

- **Facts are computed, not authored.** Who committed, which wards were touched, how much
  churn, how long the town was silent, what has gone derelict, who is on the rolls — all of
  it comes out of `surveyor.mjs` and `state.advance()`. The editor cannot influence any of
  it and cannot fake any of it.
- **Flavour is authored, but must cite.** Prose, landmark names, saga beats, epithets, the
  civic mood — these are the editor's. Every one must reference a record id that genuinely
  exists in the day being reported, or `apply` exits non-zero:

  ```
  The dispatch was refused:
    - notices[0].origin "deadbee" is not a record from 2026-07-10.
      The town does not print rumours.
  ```

  It also rejects a status word outside the fixed vocabulary, a landmark in a ward that
  does not exist, and an epithet for a citizen who is not on the rolls.

The town can therefore be strange, but it cannot be false. Every notice on the site carries
a "What actually happened" button that shows the real commit behind it — that button is only
honest because the validator makes it impossible for it not to be.

Because `apply` exits non-zero on a bad dispatch, an unattended run **fails loudly instead
of quietly publishing something invented.** That property is what would make a future
scheduled run safe.

---

## The seam: other histories

`sources/` is the extension point. An adapter is any module exporting `id`, `label`,
`collect()` and `activeDays()`, and emitting Records. The shape is documented in
[`sources/index.mjs`](../townalizer/sources/index.mjs).

Everything above the adapter — surveyor, state, validator, dispatch, website — is written
against Records and knows nothing about git. `sources/journal.mjs` reads a directory of
dated markdown files and exists specifically to prove that claim is true rather than
aspirational.

A body of work gets its own town:

```bash
node townalizer/cli.mjs days    --repo ../my-app --town my-app --name "Chaos Harbour"
node townalizer/cli.mjs dossier --repo ../my-app --town my-app --date 2026-07-11
node townalizer/cli.mjs bundle  --town my-app --out my-app-town.html
```

`towns/<slug>/` then holds that history's own state and its own back issues. The same
Office, in the same voice, surveying a different parcel.

---

## The website

Static. No backend, ever. `istoletha/index.html` fetches `data/town-state.json` and
`data/dispatches/*.json` at runtime — or, when bundled, reads them from `window.__TOWN__`
inlined into the page. The same file works served from nginx, from GitHub Pages, from a
Claude Artifact, and from `file://` with no network at all.

Two ways in, and they are the same history from opposite ends:

- **as news** — the latest bulletin, back issues, a notice, and the record beneath it
- **as place** — the ward survey, a ward's file, its landmarks and chronicle, and the issue
  that reported any record in it

Every view is addressable, so it can be sent to someone:

```
#/issue/2026-04-19            an issue
#/issue/2026-04-19/11-066     that issue, with one notice flagged and its record open
#/ward/site                   a ward file
#/ward/site/2baf645           that ward, with one record of its chronicle pinned
```

---

## Known weaknesses (as of 2026-07-12)

Honest accounting, since this is the ground the next work stands on.

- **Seeding is manual and serial.** The first eleven issues were produced by hand-picking
  narratively strong days and skipping quiet ones. That is not a strategy; it is a demo.
  `days` currently reports a double-digit backlog.
- **Nothing triggers anything.** No hook, no cron, no watcher. Committing does not cause the
  town to notice.
- **There is no "skipped" state.** A day is either reported or unreported. There is no way to
  say *this day was dull and deliberately has no issue*, so the backlog cannot distinguish
  "not done" from "not worth doing".
- **The editor has no memory of its own style** beyond what `townBefore` carries into the
  dossier. It cannot read its own past prose, so voice drift across many issues is unguarded.
- **Backfill order is load-bearing.** Sagas accumulate in date order, so days must be reported
  oldest-first. Nothing enforces this; the skill merely asks nicely.
