# tnkrfun-site-townalizer

One nginx container serving **Istoletha Town** (`istoletha/`) at
<http://localhost:8025>. No host routing, no hosts file, no deployment story yet.

```bash
docker compose up -d     # that's it
```

The inherited tnkrfun alien page still sits in `site/`, but it is **not served**. Its
links are absolute (`/breeder/`, `/tinker-impact/`), so it can only live at the root —
and the root is the town's now. Its game submodules are not checked out either. Bringing
it back is a deployment problem for a later day; see `nginx/default.conf`.

## The townalizer

`townalizer/` turns a history of work into a town that reacts to it.

Each day of real history becomes a **dispatch** — municipal news, written by an agent in
the voice of a dissolved town's last remaining civil servant. The town keeps **state**
across dispatches: wards are surveyed, structures accumulate, landmarks are raised,
citizens are named, and places nobody has visited in a while quietly decay.

The point is that it is *true*. Every notice the town prints cites the record that
caused it, and the site will show you that record on request ("What actually happened").
The prose is fiction; the facts underneath are not.

The town is explorable both ways round. Read it as **news** — the latest bulletin, back
issues, a notice, the record behind it. Or read it as **place** — click any ward in the
Ward Survey to open its file: what stands there, what landmarks were raised, and a
chronicle of every record that ever touched it, each linking back to the issue that
reported it. The two views are the same history seen from different ends.

### Layers

```
sources/      adapters: git, journal  → normalised Records
lib/surveyor  deterministic: Records  → town facts (wards, kinds, churn, decay)
lib/state     facts advance the town; the agent may only add flavour, and must cite
lib/validate  refuses any claim the history does not support
cli.mjs       days | dossier | apply | rebuild | status
```

An agent never sees the repository. It sees a **dossier** (the surveyed facts of one day,
plus the town as it stood the night before) and writes a **dispatch**. Everything factual
is computed where it can be checked.

```bash
node townalizer/cli.mjs days                       # days with history; which are unreported
node townalizer/cli.mjs dossier --date 2026-04-03  # the facts of one day  (the agent reads this)
node townalizer/cli.mjs apply --file draft.json    # validate, print, replay  (the agent runs this)
node townalizer/cli.mjs status                     # the town as it now stands
```

Or just run **`/dispatch`** in Claude Code (see `.claude/skills/dispatch/`), optionally
with a date. It picks the earliest unreported day, reads the dossier, writes the
bulletin, and applies it.

### It cannot lie

Every notice must cite a record id from the day it reports. Invent one and the town
refuses to print it:

```
The dispatch was refused:
  - notices[0].origin "deadbee" is not a record from 2026-07-10.
    The town does not print rumours.
```

`apply` exits non-zero when this happens, so an unattended run fails loudly instead of
quietly making things up.

### Other histories

The source adapter is the seam. `sources/git.mjs` reads a repository;
`sources/journal.mjs` reads a directory of dated markdown files, and exists to prove the
seam is real. Anything that can produce a `Record` — a ticket export, a work log, a
ship's log — can found a town.

```bash
node townalizer/cli.mjs days --source journal --repo ~/notes
node townalizer/cli.mjs dossier --date 2026-07-10 --repo ../some-other-project
```

State is **rebuilt by replaying every dispatch**, never mutated in place. Edit or delete
a dispatch you dislike and run `rebuild`; the town corrects itself.

## Running it

```bash
docker compose up -d                          # http://localhost:8025  — live bind-mounts
docker compose --profile prod up -d --build   # http://localhost:8026  — the real image
docker compose down                           # stop
```

Use the default `web` service while writing dispatches: publishing one only rewrites JSON
under `istoletha/data/`, so a browser refresh is enough — no rebuild. The `prod` profile
builds the actual `Dockerfile` image, for when you care whether the thing that ships works.

## Sharing it

The whole town fits in one file. `bundle` inlines `town-state.json` and every dispatch as
`window.__TOWN__` (the site's `get()` prefers it over `fetch`), so the page needs no server
and no network:

```bash
# a standalone page — email it, and the recipient double-clicks it
node townalizer/cli.mjs bundle --out istoletha-town.html

# a fragment for a host that supplies its own <head>/<body> (e.g. Claude Artifacts)
node townalizer/cli.mjs bundle --artifact --out istoletha-artifact.html
```

Both report any external subresource that would break under a strict CSP. Re-run after
publishing new dispatches.

`file://` is fully supported, `localStorage` included — so Form B-11, the sub-basement, the
petition and Form D-11 all work for someone who was just sent the file.

## Deployment (later)

There is none, on purpose. The inherited GitHub Actions workflow, k3s manifests, and helm
chart all pointed at another account's registry and cluster, so they were removed rather
than left to rot.

When you do tackle it, two notes:

- **Host routing is gone.** If you want the tnkrfun site back alongside the town, that is
  where the decision lives — reinstate a second server block, or rewrite its absolute links.
- **`townalizer/cli.mjs apply` is plain Node**, zero dependencies, no network calls. It drops
  into a scheduled job as-is. The only thing it needs is an agent to write the dispatch first.
