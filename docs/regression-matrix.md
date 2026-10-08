# Matrice funzionalità - test di regressione

Per ogni funzionalità esistente indica quale test la copre, anche quando non è esposta via HTTP.
`tests/unit/regression-matrix.test.ts` verifica che:

- ogni test citato esista (file presente e nome del test presente, ricerca letterale);
- ogni sorgente in `src/app/**/route.ts`, `src/app/**/page.tsx`, `src/db/platform/*.ts`,
  `src/db/tenant-scope/*.ts`, `src/db/entitlements.ts` e `src/lib/**/*.ts` compaia nella prima
  colonna: **un file sorgente nuovo fa fallire il test finché non si aggiunge una riga**;
- ogni sorgente citato esista ancora (un file rinominato o cancellato va aggiornato qui).

Regole di scrittura:

- Prima colonna: nome della funzionalità e, tra apici inversi, i file sorgente.
- Terza colonna: `file` "nome del test", separati da `;`. Il nome deve comparire alla lettera nel
  file (niente `|`, apici doppi o apici inversi nel nome). Se nessun test la copre, scrivere
  solo `non coperto`.
- Nomi di funzionalità unici: una riga duplicata fa fallire il test.

| Funzionalità | Esposta via HTTP | File e nome del test |
|---|---|---|
| GET /api (punto d'ingresso) `src/app/api/route.ts` | sì | `e2e/regression-api.spec.ts` "regression: GET /api describes the service and links to itself and the health check" |
| GET /api/health con DB raggiungibile (200) `src/app/api/health/route.ts` | sì | `e2e/regression-api.spec.ts` "regression: GET /api/health reports exactly status ok and database up" |
| GET /api/health con DB giù (503, non riproducibile in e2e: il DB è condiviso) `src/app/api/health/route.ts` | sì | `tests/integration/health.test.ts` "returns 503 when the database is unreachable" |
| Navigazione dei link HATEOAS di /api | sì | `e2e/regression-api.spec.ts` "regression: every GET link of /api answers 200 with a matching self link" |
| Metodi non supportati su /api e /api/health (405) | sì | `e2e/regression-api.spec.ts` "regression: POST /api is rejected with 405"; `e2e/regression-api.spec.ts` "regression: POST /api/health is rejected with 405" |
| Percorso API inesistente (404) | sì | `e2e/regression-api.spec.ts` "regression: GET on an unknown API path answers 404" |
| Pagina iniziale GET / (metadati, titolo, testo) `src/app/page.tsx` `src/app/layout.tsx` | sì | `e2e/regression-pages.spec.ts` "regression: home page has the expected document metadata"; `e2e/regression-pages.spec.ts` "regression: home page shows the heading and the tagline" |
| Pagina iniziale senza errori JS o console | sì | `e2e/regression-pages.spec.ts` "regression: home page loads without page errors or console errors" |
| GET /favicon.ico `src/app/favicon.ico` | sì | `e2e/regression-pages.spec.ts` "regression: GET /favicon.ico answers 200 with an image" |
| Helper HATEOAS `src/lib/hateoas.ts` | no | `tests/unit/hateoas.test.ts` "includes only the allowed links"; `tests/unit/hateoas.test.ts` "requires a self link" |
| Validazione email `src/lib/validation/email.ts` | no | `tests/unit/email.test.ts` "rejects a lone surrogate" |
| Validazione e normalizzazione del testo `src/lib/validation/text.ts` | no | `tests/unit/text.test.ts` "normalises to NFC" |
| Validazione P.IVA e codice fiscale `src/lib/validation/italian-tax-ids.ts` | no | `tests/unit/italian-tax-ids.test.ts` "accepts a VAT number with a correct check digit" |
| Catalogo moduli e seed `src/db/catalog/modules.ts` `src/db/seed.ts` | no | `tests/unit/module-catalog.test.ts` "contains the 4 modules, with approvals as the only base module"; `tests/integration/seed.test.ts` "is idempotent: two runs leave exactly the 4 catalogue modules" |
| Migrazioni e vincoli di schema `src/db/migrate.ts` `src/db/schema/index.ts` `src/db/schema/columns.ts` `src/db/schema/enums.ts` `src/db/schema/modules.ts` `src/db/schema/tenant-modules.ts` `src/db/schema/tenants.ts` `src/db/schema/users.ts` | no | `tests/integration/migrations.test.ts` "can be applied again with no errors and no changes"; `tests/integration/schema-constraints.test.ts` "reject a second tenant with the same vat_number"; `tests/unit/migrate.test.ts` "points to drizzle/ at the repository root" |
| createTenant e setTenantStatus (nessun HTTP) `src/db/platform/tenants.ts` `src/db/errors.ts` | no | `tests/integration/platform-tenants.test.ts` "creates an ACTIVE tenant with a valid VAT number and returns it"; `tests/integration/platform-tenants.test.ts` "sets SUSPENDED then CLOSED, moving updated_at forward each time" |
| Utenti del tenant e isolamento (nessun HTTP) `src/db/tenant-scope/index.ts` `src/db/tenant-scope/users.ts` `src/db/tenant-scope/tenant-id.ts` | no | `tests/integration/tenant-scope-users.test.ts` "list() of A returns only the users of A"; `tests/unit/tenant-scope.test.ts` "rejects a non-UUID tenant id before resolving the default database" |
| hasModule, attivazione e cancellazione moduli, catalogo (nessun HTTP) `src/db/entitlements.ts` `src/db/platform/modules.ts` `src/db/tenant-scope/modules.ts` | no | `tests/integration/entitlements.test.ts` "does not leak a module from tenant A to tenant B"; `tests/integration/entitlements.test.ts` "cancels a module, keeping its dates, without touching tenant B"; `tests/integration/entitlements.test.ts` "lists the 4 modules with code, name, description and isBase" |
| Pool DB e ping `src/db/client.ts` `src/db/health.ts` | no | `tests/integration/db-client.test.ts` "closeDb ends the pool and the next call opens a new working one"; `tests/integration/db-health.test.ts` "returns true when the database answers" |
| Strumenti di test: db:migrate:test, guard DB di test, reset `scripts/migrate-test.ts` | no | `tests/integration/migrate-test-script.test.ts` "migrates the database at TEST_DATABASE_URL"; `tests/integration/test-database-guard.test.ts` "resetDb refuses when TEST_DATABASE_URL points to it"; `tests/integration/reset-db.test.ts` "the next test starts with empty tenant tables and the full module catalogue" |
| Lint di isolamento tenant `eslint.config.mjs` | no | `tests/unit/tenant-isolation-lint.test.ts` "point to forTenant in the message" |
| Script db:seed (il wrapper; la funzione seedDatabase è coperta sopra) `scripts/seed.ts` | no | non coperto |
| Script di stampa errori `scripts/report-error.ts` (parziale: è esercitato solo dal percorso di errore di migrate-test; la stampa della catena "Caused by:" non è coperta) | no | `tests/integration/migrate-test-script.test.ts` "refuses a TEST_DATABASE_URL whose database name does not end with _test" |
| Hash password argon2id `src/lib/auth/password.ts` | no | `tests/unit/password.test.ts` "produces an argon2id hash with the OWASP parameters, without the plain password"; `tests/unit/password.test.ts` "verifies the right password and rejects a wrong one" |
| Verifica credenziali, email + password (nessun HTTP) `src/db/auth/credentials.ts` `src/db/auth/index.ts` | no | `tests/integration/auth-credentials.test.ts` "returns user and tenantId for an email with different case and spaces"; `tests/integration/auth-credentials.test.ts` "does not distinguish the failure cases: all of them are plain null" |
| Impostazione password utente e unicità del login (nessun HTTP) | no | `tests/integration/auth-credentials.test.ts` "stores an argon2id hash and never the plain password"; `tests/integration/auth-credentials.test.ts` "throws DuplicateLoginEmailError for the same email, in any case, in another tenant" |
| Sessioni su database: creazione, risoluzione, cancellazione (nessun HTTP) `src/db/auth/sessions.ts` | no | `tests/integration/auth-sessions.test.ts` "returns session id, user and tenant"; `tests/integration/auth-sessions.test.ts` "is valid one millisecond before expiry and expired exactly at expires_at"; `tests/integration/auth-sessions.test.ts` "removes the row, so the token no longer resolves, and can be repeated" |
