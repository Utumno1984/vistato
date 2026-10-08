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
   1. **sviluppatore** → branch `feat/<N>-<slug>` e **PR in bozza subito** (`Closes #<N>`), così
      la CI gira a ogni push. Codice e test insieme: unitari, di integrazione e **e2e per ogni
      criterio di accettazione visibile dall'esterno** (API o pagine). `npm run check` verde.
   2. **CI verde** sulla PR (`gh pr checks <N> --watch`): lint, tipi, test unitari e di
      integrazione, smoke, e2e completi. Se è rossa torna allo sviluppatore: tester e critico
      non partono su una CI rossa.
   3. **tester** → QA: criteri di accettazione dal punto di vista dell'utente, smoke test sulla
      build di produzione, intera suite e2e, casi non coperti dai test.
   4. **critico-avversariale** → red team del diff, per ultimo, su codice già verde e verificato.
   5. Se tester o critico segnalano problemi, torna allo **sviluppatore** con l'elenco
      completo e riparti dal punto 2 (CI). Dopo 2 giri senza esito positivo fermati e
      chiedi a Daniele.
   6. Quando CI verde, tester = QA SUPERATO e critico = APPROVATO: `gh pr ready <N>` e riepilogo
      (cosa cambia, test aggiunti, note del critico).
3. **Merge**: lo fa l'orchestratore di `~/projects` (delega di Daniele), mai le sessioni o gli
   agenti di questo progetto. Niente push su `main` né push forzati.

### Comandi `gh` nelle sessioni headless

`gh` è nel `PATH` delle sessioni headless: chiamalo come `gh ...`, all'inizio del comando e da
solo (niente `~/.local/bin/gh`, niente `PATH=... gh`, niente `cd ... && gh`). Altrimenti il
comando non corrisponde al permesso `Bash(gh *)` e resta bloccato in attesa di un'approvazione.

### Budget dei token (piano Pro)

Le quote di utilizzo (5 ore e settimanale) sono il vincolo: usa il modello più leggero adatto.

- Sessioni headless (`claude -p`) e orchestratore: sempre `--model sonnet`.
- Modelli degli agenti: pianificatore e critico `opus`, sviluppatore e tester `sonnet`;
  ogni agente ha un `maxTurns` nel frontmatter.
- Critico: `effort: medium`; dal secondo giro verifica solo i punti segnalati e il diff delle
  correzioni, non rifà il red team completo. Massimo 2 giri.

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
