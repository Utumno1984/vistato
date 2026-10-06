# Vistato

**Supplier invoice approval for Italian SMEs.** Every incoming invoice reaches the people who must
approve it, gets approved with one tap, and the accountant receives data that has already been
validated. *(Italiano: approvazione delle fatture fornitori per le PMI.)*

> Status: early development. This repository contains the platform core.

## How it works

1. Supplier e-invoices arrive from [Fatture in Cloud](https://www.fattureincloud.it/) (API and
   webhooks) or are uploaded as XML/PDF.
2. Configurable rules route each invoice to its approvers (by supplier, amount, category), in
   sequence or in parallel, with reminders and escalation.
3. Once approved, category, cost center and approval flag are written back to Fatture in Cloud.

Vistato is a **pre-filter**: it never registers invoices and carries no tax responsibility.
Registration stays with the accountant.

## Architecture principles

- **Multi-tenant**: every customer company is a tenant; every query is scoped by tenant.
- **Modular entitlements**: paid modules (cost centers and budgets, purchase orders with
  matching, payment schedule, extra integrations) are enforced server-side on every endpoint.
- **HATEOAS**: every resource exposes, in `_links`, only the actions the current caller may take
  right now (see [`src/lib/hateoas.ts`](src/lib/hateoas.ts)). The UI renders actions and modules
  from links alone, so it never hard-codes plans or permissions. Links mirror the server checks,
  they never replace them.

## Stack

Next.js 16 (App Router) · TypeScript · PostgreSQL 17 · Drizzle ORM · Zod · Vitest · Playwright ·
GitHub Actions.

## Getting started

Requirements: Node.js 24, Docker.

```bash
cp .env.example .env
npm install
npm run db:up      # Postgres on port 5433, with a separate test database
npm run dev        # http://localhost:3000 — API entry point at /api
```

| Script | What it does |
| --- | --- |
| `npm run check` | Lint, type check, unit and integration tests |
| `npm run test:e2e` | Production build + Playwright end-to-end tests |
| `npm run db:generate` / `db:migrate` | Create / apply Drizzle migrations |

## AI-assisted workflow

Development runs through a team of [Claude Code subagents](.claude/agents/), coordinated by the
main session as described in [`CLAUDE.md`](CLAUDE.md). It reproduces a Scrum-style quality gate:

1. **Planner** turns a request into small GitHub issues with testable acceptance criteria.
2. **Developer** implements one issue on its own branch, with unit and integration tests.
3. **Tester** verifies every acceptance criterion with end-to-end and smoke tests.
4. **Adversarial critic** red-teams the diff (tenant isolation, entitlements, edge cases) and
   sends the PR back until it is solid.

Only then is a PR marked *Ready for Review*. A human reviews and merges; agents are denied
merge and force-push in [`.claude/settings.json`](.claude/settings.json).

## License

Copyright © 2026 Daniele Ingusci. All rights reserved. The source is public for reference; no
license is granted to use, copy, modify or distribute it.
