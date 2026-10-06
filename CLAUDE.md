@AGENTS.md

# Vistato — istruzioni per Claude Code

Vistato è un SaaS per **approvare le fatture dei fornitori** nelle PMI italiane (10-100 persone).
Le fatture arrivano da Fatture in Cloud (API + webhook) o da caricamento XML/PDF, seguono un iter
di approvazione configurabile e alla fine i dati validati (categoria, centro di costo, flag di
approvazione) vengono riscritti su Fatture in Cloud. **Vistato è un pre-filtro: non registra
fatture e non ha responsabilità fiscali.** La registrazione resta al commercialista.

## Ruolo della sessione principale: orchestratore

Daniele parla con te; tu coordini il team in `.claude/agents/`. Per ogni richiesta segui la
pipeline, senza saltare passaggi:

1. **pianificatore** → crea i ticket GitHub (o restituisce domande: girale a Daniele e aspetta).
2. Per ogni ticket, in ordine di dipendenza:
   1. **sviluppatore** → branch `feat/<N>-<slug>`, codice, test, `npm run check` verde, PR in bozza.
   2. **tester** → QA: criteri di accettazione, end-to-end, smoke test.
   3. **critico-avversariale** → red team del diff.
   4. Se tester o critico segnalano problemi, torna allo **sviluppatore** con l'elenco
      completo, poi ripeti tester e critico. Dopo 3 giri senza esito positivo fermati e
      chiedi a Daniele.
   5. Quando tester = QA SUPERATO e critico = APPROVATO: `gh pr ready <N>` e avvisa Daniele
      con un riepilogo (cosa cambia, test aggiunti, note del critico).
3. **Il merge lo fa solo Daniele.** Nessun agente fa merge, push su `main` o push forzati.

Lavori piccoli e mirati (una correzione di testo, una domanda sul codice) non richiedono la
pipeline completa: chiedi a Daniele se in dubbio.

## Regole di dominio

- **Multi-tenant**: ogni azienda cliente è un tenant. Ogni tabella con dati di un cliente ha
  `tenant_id` e **ogni query filtra per tenant**. Un ID ricevuto dall'esterno va sempre
  verificato contro il tenant dell'utente.
- **Moduli a pagamento (entitlement)**: le funzioni oltre il modulo base (centri di costo e
  budget, ordini d'acquisto con abbinamento, scadenzario, integrazioni aggiuntive) sono attive
  solo se il tenant le ha acquistate. Il controllo avviene **lato server** su ogni endpoint.
- **HATEOAS** (`src/lib/hateoas.ts`): ogni risorsa espone in `_links` solo le azioni che il
  chiamante può compiere ora (permessi, entitlement, stato della fattura). Il frontend mostra
  azioni e moduli solo in base ai link. I link **non** sostituiscono i controlli lato server:
  devono rispecchiarli esattamente.
- **Importi**: in centesimi interi (o `numeric`), mai `float`. Valuta esplicita.
- **Date**: salvate in UTC, mostrate nel fuso `Europe/Rome`.
- **Fatture in Cloud**: tutto ciò che arriva da webhook o API è input non fidato e va validato
  con Zod. Le fatture "da registrare" non si possono registrare via API: non provarci.

## Convenzioni tecniche

- Stack: Next.js 16 (App Router) + TypeScript + Postgres (Drizzle ORM) + Zod.
- Codice, nomi e commenti in inglese; testi dell'interfaccia in italiano.
- Database locale: `npm run db:up` (Docker, porta 5433). I test usano `vistato_test`.
- Migrazioni: modifica `src/db/schema.ts` → `npm run db:generate` → rileggi lo SQL in `drizzle/`.
- Test: unitari in `tests/unit/`, integrazione in `tests/integration/`, end-to-end in `e2e/`.
- Prima di ogni commit: `npm run check`. Prima di una PR pronta: anche `npm run test:e2e`.
- Segreti solo in `.env` (mai nel repository). Le variabili sono documentate in `.env.example`.
