import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");

/** Literal key phrases that must stay in each process file (docs/ is never read). */
const rules: Record<string, string[]> = {
  "CLAUDE.md": [
    "## Regressione e test",
    "non si rinominano e non si indeboliscono",
    "docs/regression-matrix.md",
    "job `test-guard`",
    "`npm run test:guard`",
    "`rimozione-funzionalita`",
    "Gli agenti non la applicano mai",
    "`src/db/schema/`",
  ],
  ".claude/agents/pianificatore.md": [
    "## Test e2e",
    "Nessun ticket senza la sezione",
    "`src/db/schema/`",
  ],
  ".claude/agents/sviluppatore.md": [
    "`.skip`, `.only`, `.fixme`",
    "docs/regression-matrix.md",
    "Non applicare mai l'etichetta `rimozione-funzionalita`",
    "`src/db/schema/`",
  ],
  ".claude/agents/tester.md": [
    "npm run test:guard -- --base-ref origin/main",
    "docs/regression-matrix.md",
    "numero di test e2e eseguiti/passati/falliti",
    "senza fingere un esito locale",
  ],
  ".claude/agents/critico-avversariale.md": [
    "gravità ALTO",
    "git diff origin/main -- tests e2e",
    "`rimozione-funzionalita` non",
    "aggirabile dall'interno",
    "Le regole di regressione valgono anche qui",
  ],
  ".github/ISSUE_TEMPLATE/ticket.md": ["## Test e2e"],
  ".github/pull_request_template.md": [
    "Matrice docs/regression-matrix.md aggiornata",
    "Suite e2e completa eseguita",
    "## Rimozione funzionalità",
    "test-guard",
  ],
};

describe("process rules", () => {
  for (const [file, phrases] of Object.entries(rules)) {
    const text = readFileSync(join(root, file), "utf8");
    it.each(phrases)(`${file} contains %j`, (phrase) => {
      expect(text.includes(phrase)).toBe(true);
    });
  }

  it("the obsolete schema path is gone", () => {
    for (const file of Object.keys(rules)) {
      expect(readFileSync(join(root, file), "utf8")).not.toContain("src/db/schema.ts");
    }
  });
});
