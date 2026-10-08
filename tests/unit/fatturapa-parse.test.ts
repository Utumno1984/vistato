import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MAX_FATTURAPA_BYTES, parseFatturaPA, type FatturaPaResult } from "@/lib/fatturapa/parse";

import { buildFatturaPA, summary, type BuildOptions } from "../fixtures/fatturapa/build";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "fatturapa");
const fixture = (name: string) => readFileSync(join(FIXTURES, name));

const EXPECTED = {
  documentType: "TD01",
  supplierName: "Caffè & Co. S.r.l.",
  supplierVatCountry: "IT",
  supplierVatCode: "01234567890",
  invoiceNumber: "FT/2024/001",
  invoiceDate: "2024-02-29",
  totalAmountCents: 123450,
  currency: "EUR",
};

function issuesOf(result: FatturaPaResult) {
  if (result.ok) throw new Error(`expected failure, got ${JSON.stringify(result.data)}`);
  return result.issues;
}

function fieldsOf(options: BuildOptions) {
  return issuesOf(parseFatturaPA(buildFatturaPA(options))).map((issue) => issue.field);
}

function totalOf(options: BuildOptions) {
  const result = parseFatturaPA(buildFatturaPA(options));
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.data.totalAmountCents;
}

describe("parseFatturaPA: valid files", () => {
  it("reads a file with the p: namespace prefix (builder and static fixture)", () => {
    expect(parseFatturaPA(buildFatturaPA({ prefix: "p:" }))).toEqual({ ok: true, data: EXPECTED });
    expect(parseFatturaPA(fixture("valid-prefix-p.xml"))).toEqual({ ok: true, data: EXPECTED });
  });

  it("reads a file without prefix, with another prefix (ns2:) and version FPA12", () => {
    expect(parseFatturaPA(buildFatturaPA())).toEqual({ ok: true, data: EXPECTED });
    expect(parseFatturaPA(buildFatturaPA({ prefix: "ns2:" }))).toEqual({ ok: true, data: EXPECTED });
    expect(parseFatturaPA(buildFatturaPA({ version: "FPA12" }))).toEqual({ ok: true, data: EXPECTED });
  });

  it("accepts the same content as a string and as bytes", () => {
    const xml = buildFatturaPA();
    expect(parseFatturaPA(new TextEncoder().encode(xml))).toEqual(parseFatturaPA(xml));
  });

  it("keeps the credit note type and the negative amount", () => {
    const result = parseFatturaPA(buildFatturaPA({ documentType: "TD04", total: "-10.00" }));
    expect(result).toMatchObject({ ok: true, data: { documentType: "TD04", totalAmountCents: -1000 } });
  });

  it("builds 'Nome Cognome' for a natural person", () => {
    const anagrafica = "<Nome>Giosuè</Nome><Cognome>Rossi</Cognome>";
    expect(parseFatturaPA(buildFatturaPA({ anagrafica }))).toMatchObject({
      ok: true,
      data: { supplierName: "Giosuè Rossi" },
    });
  });

  it("prefers Denominazione when both are present", () => {
    const anagrafica = "<Denominazione>Alfa</Denominazione><Nome>A</Nome><Cognome>B</Cognome>";
    expect(parseFatturaPA(buildFatturaPA({ anagrafica }))).toMatchObject({ ok: true, data: { supplierName: "Alfa" } });
  });

  it("accepts a foreign supplier with an alphanumeric code", () => {
    const result = parseFatturaPA(buildFatturaPA({ vatCountry: "DE", vatCode: "DE123456789" }));
    expect(result).toMatchObject({ ok: true, data: { supplierVatCountry: "DE", supplierVatCode: "DE123456789" } });
  });

  it("trims spaces and line breaks around values", () => {
    const xml = buildFatturaPA({ number: "\n   A-1 \n", date: " 2024-03-01 ", currency: " EUR\n" });
    expect(parseFatturaPA(xml)).toMatchObject({
      ok: true,
      data: { invoiceNumber: "A-1", invoiceDate: "2024-03-01", currency: "EUR" },
    });
  });

  it("decodes predefined and numeric entities in the text", () => {
    const anagrafica = "<Denominazione>A &lt;B&gt; &#x26; &#67;</Denominazione>";
    expect(parseFatturaPA(buildFatturaPA({ anagrafica }))).toMatchObject({
      ok: true,
      data: { supplierName: "A <B> & C" },
    });
  });

  it("reads a UTF-8 BOM, in a string and in bytes", () => {
    const xml = buildFatturaPA();
    expect(parseFatturaPA("﻿" + xml)).toEqual({ ok: true, data: EXPECTED });
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(xml)]);
    expect(parseFatturaPA(bytes)).toEqual({ ok: true, data: EXPECTED });
  });

  it("normalises accented names to NFC", () => {
    const decomposed = "Caffé Rossi";
    const result = parseFatturaPA(buildFatturaPA({ anagrafica: `<Denominazione>${decomposed}</Denominazione>` }));
    expect(result).toMatchObject({ ok: true, data: { supplierName: "Caffé Rossi" } });
    expect(result.ok && result.data.supplierName.normalize("NFC")).toBe(result.ok && result.data.supplierName);
  });

  it("ignores unknown extra elements and attributes", () => {
    const xml = buildFatturaPA({ extraGeneral: "<Causale>x</Causale>" }).replace("<Divisa>", '<Divisa a="1">');
    expect(parseFatturaPA(xml)).toEqual({ ok: true, data: EXPECTED });
  });
});

describe("parseFatturaPA: amount", () => {
  it("converts ImportoTotaleDocumento to integer cents", () => {
    expect(totalOf({ total: "1234.50" })).toBe(123450);
    expect(totalOf({ total: "-10.00" })).toBe(-1000);
    expect(totalOf({ total: "0.00" })).toBe(0);
    expect(totalOf({ total: "-0.00" })).toBe(0);
    expect(totalOf({ total: "0.07" })).toBe(7);
  });

  it("accepts the largest amount of 11 integer digits and rejects 12", () => {
    expect(totalOf({ total: "99999999999.99" })).toBe(9999999999999);
    expect(fieldsOf({ total: "999999999999.99" })).toEqual(["totalAmountCents"]);
  });

  it.each(["12.5", "12.505", "12,50", "abc", "12", "1e3", "+12.00", "--1.00", ".50", "12.50.1", "1 234.50", "0x10.00"])(
    "rejects the amount %j on the amount field",
    (total) => {
      expect(fieldsOf({ total })).toEqual(["totalAmountCents"]);
    },
  );

  it("rejects an empty ImportoTotaleDocumento without falling back to the sum", () => {
    expect(fieldsOf({ total: "" })).toEqual(["totalAmountCents"]);
  });

  it("falls back to the sum of ImponibileImporto + Imposta of all DatiRiepilogo", () => {
    const goods = `<DatiBeniServizi>${summary("100.00", "22.00")}${summary("50.50", "5.05")}</DatiBeniServizi>`;
    expect(totalOf({ total: null, goods })).toBe(17755);
  });

  it("sums in integer cents where floats would round wrongly", () => {
    // 0.10 + 0.20 === 0.30000000000000004 in floating point
    expect(totalOf({ total: null, goods: `<DatiBeniServizi>${summary("0.10", "0.20")}</DatiBeniServizi>` })).toBe(30);
    const many = Array.from({ length: 1000 }, () => summary("0.10", "0.20")).join("");
    expect(totalOf({ total: null, goods: `<DatiBeniServizi>${many}</DatiBeniServizi>` })).toBe(30000);
  });

  it("sums negative summaries", () => {
    const goods = `<DatiBeniServizi>${summary("-100.00", "-22.00")}</DatiBeniServizi>`;
    expect(totalOf({ total: null, goods })).toBe(-12200);
  });

  it("prefers ImportoTotaleDocumento when it differs from the sum", () => {
    const goods = `<DatiBeniServizi>${summary("1.00", "1.00")}</DatiBeniServizi>`;
    expect(totalOf({ total: "999.00", goods })).toBe(99900);
  });

  it("reports an error without total and without DatiRiepilogo", () => {
    expect(fieldsOf({ total: null, goods: null })).toEqual(["totalAmountCents"]);
    expect(fieldsOf({ total: null, goods: "<DatiBeniServizi></DatiBeniServizi>" })).toEqual(["totalAmountCents"]);
  });

  it("reports an invalid or missing amount inside a DatiRiepilogo", () => {
    const bad = `<DatiBeniServizi>${summary("10,00", "1.00")}</DatiBeniServizi>`;
    expect(fieldsOf({ total: null, goods: bad })).toEqual(["totalAmountCents"]);
    const missing = "<DatiBeniServizi><DatiRiepilogo><Imposta>1.00</Imposta></DatiRiepilogo></DatiBeniServizi>";
    expect(fieldsOf({ total: null, goods: missing })).toEqual(["totalAmountCents"]);
  });
});

describe("parseFatturaPA: supplier", () => {
  it("requires a Denominazione or Nome and Cognome", () => {
    expect(fieldsOf({ anagrafica: "" })).toEqual(["supplierName"]);
    expect(fieldsOf({ anagrafica: "<Denominazione>   </Denominazione>" })).toEqual(["supplierName"]);
    expect(fieldsOf({ anagrafica: "<Nome>Mario</Nome>" })).toEqual(["supplierName"]);
    expect(fieldsOf({ anagrafica: "<Cognome>Rossi</Cognome>" })).toEqual(["supplierName"]);
  });

  it("requires an 11-digit code for IT", () => {
    for (const vatCode of ["0123456789", "012345678901", "0123456789A", "", "IT01234567890"]) {
      expect(fieldsOf({ vatCountry: "IT", vatCode }), vatCode).toEqual(["supplierVatCode"]);
    }
  });

  it("accepts 1-28 alphanumeric characters for a foreign country and refuses others", () => {
    expect(parseFatturaPA(buildFatturaPA({ vatCountry: "FR", vatCode: "A" })).ok).toBe(true);
    expect(parseFatturaPA(buildFatturaPA({ vatCountry: "FR", vatCode: "A".repeat(28) })).ok).toBe(true);
    for (const vatCode of ["A".repeat(29), "AB-12", "AB 12", ""]) {
      expect(fieldsOf({ vatCountry: "FR", vatCode }), vatCode).toEqual(["supplierVatCode"]);
    }
  });

  it("refuses a country that is not 2 uppercase letters, or missing", () => {
    for (const vatCountry of ["it", "ITA", "I", "1T", ""]) {
      expect(fieldsOf({ vatCountry }), vatCountry).toContain("supplierVatCountry");
    }
    expect(fieldsOf({ vatCountry: null })).toEqual(expect.arrayContaining(["supplierVatCountry", "supplierVatCode"]));
  });
});

describe("parseFatturaPA: date, currency, type and number", () => {
  it("accepts a leap day and refuses impossible or badly formatted dates", () => {
    expect(parseFatturaPA(buildFatturaPA({ date: "2024-02-29" })).ok).toBe(true);
    for (const date of ["2025-02-30", "2023-02-29", "2024-13-01", "2024-00-10", "2024-04-31", "29/02/2024", "20240229", "2024-2-9", ""]) {
      expect(fieldsOf({ date }), date).toEqual(["invoiceDate"]);
    }
    expect(fieldsOf({ date: null })).toEqual(["invoiceDate"]);
  });

  it("refuses a missing currency or one that is not 3 uppercase letters", () => {
    for (const currency of ["eur", "EU", "EURO", "E1R", ""]) {
      expect(fieldsOf({ currency }), currency).toEqual(["currency"]);
    }
    expect(fieldsOf({ currency: null })).toEqual(["currency"]);
  });

  it("refuses a document type that is not TDnn", () => {
    for (const documentType of ["TD1", "TD001", "td01", "XX01", "TDAB", ""]) {
      expect(fieldsOf({ documentType }), documentType).toEqual(["documentType"]);
    }
    expect(fieldsOf({ documentType: null })).toEqual(["documentType"]);
  });

  it("accepts any TDnn, e.g. TD04 and TD24", () => {
    for (const documentType of ["TD04", "TD24", "TD99"]) {
      expect(parseFatturaPA(buildFatturaPA({ documentType })).ok).toBe(true);
    }
  });

  it("refuses an empty number or one over 20 characters, accepts exactly 20", () => {
    expect(fieldsOf({ number: "" })).toEqual(["invoiceNumber"]);
    expect(fieldsOf({ number: "   " })).toEqual(["invoiceNumber"]);
    expect(fieldsOf({ number: null })).toEqual(["invoiceNumber"]);
    expect(fieldsOf({ number: "A".repeat(21) })).toEqual(["invoiceNumber"]);
    expect(parseFatturaPA(buildFatturaPA({ number: "A".repeat(20) })).ok).toBe(true);
  });

  it("refuses a repeated element where one is expected", () => {
    const twoNumbers = buildFatturaPA().replace("</Numero>", "</Numero><Numero>2</Numero>");
    expect(issuesOf(parseFatturaPA(twoNumbers)).map((i) => i.field)).toEqual(["invoiceNumber"]);
    const twoTotals = buildFatturaPA().replace(
      "</ImportoTotaleDocumento>",
      "</ImportoTotaleDocumento><ImportoTotaleDocumento>1.00</ImportoTotaleDocumento>",
    );
    expect(issuesOf(parseFatturaPA(twoTotals)).map((i) => i.field)).toEqual(["totalAmountCents"]);
  });

  it("reports every wrong field at once, in Italian", () => {
    const issues = issuesOf(parseFatturaPA(buildFatturaPA({ currency: "x", date: "2025-02-30", documentType: "ZZ" })));
    expect(issues.map((i) => i.field).sort()).toEqual(["currency", "documentType", "invoiceDate"]);
    expect(issues.find((i) => i.field === "invoiceDate")?.message).toBe(
      "La data della fattura non è valida (formato AAAA-MM-GG)",
    );
  });
});

describe("parseFatturaPA: unusable files", () => {
  const reason = (input: string | Uint8Array) => issuesOf(parseFatturaPA(input));

  it("refuses a batch with more than one invoice", () => {
    const message = "Il file contiene più fatture: caricarle una alla volta";
    expect(reason(buildFatturaPA({ bodies: 2 }))).toEqual([{ field: "file", message }]);
    expect(reason(buildFatturaPA({ bodies: 3, prefix: "p:" }))).toEqual([{ field: "file", message }]);
  });

  it("refuses a file without bodies", () => {
    const xml = '<FatturaElettronica versione="FPR12"><FatturaElettronicaHeader/></FatturaElettronica>';
    expect(reason(xml)).toEqual([expect.objectContaining({ field: "file" })]);
  });

  it("refuses malformed XML, text and empty inputs without throwing", () => {
    for (const input of [fixture("malformed.xml"), "<a><b></a>", "not xml at all", "", "   \n", "﻿", new Uint8Array(), "<", "<<>>", "<a"]) {
      const issues = reason(input);
      expect(issues, String(input)).toHaveLength(1);
      expect(issues[0].field).toBe("file");
      expect(issues[0].message).not.toBe("");
    }
  });

  it("refuses an XML that is not a FatturaPA", () => {
    expect(reason('<?xml version="1.0"?><Invoice><Id>1</Id></Invoice>')[0].message).toMatch(/non è una fattura elettronica/);
    expect(reason("<a/><FatturaElettronica/>")[0].field).toBe("file");
  });

  it("refuses a signed .p7m file (DER binary and base64 text)", () => {
    const der = new Uint8Array([0x30, 0x82, 0x04, 0x10, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02, 0x00, 0x00]);
    expect(reason(der)[0].message).toMatch(/\.p7m/);
    expect(reason(new Uint8Array([0x00, 0x01, 0x02]))[0].message).toMatch(/\.p7m/);
    expect(reason("MIAGCSqGSIb3DQEHAqCAMIACAQExDzANBglghkgBZQMEAgEFADCABgkqhkiG9w0BBwGggCSABIID")[0].message).toMatch(/\.p7m/);
  });

  it("refuses bytes that are not UTF-8", () => {
    expect(reason(new Uint8Array([0x3c, 0x61, 0x3e, 0xe8, 0x3c, 0x2f, 0x61, 0x3e]))[0].message).toMatch(/UTF-8/);
  });

  it("refuses more than 5 MB and accepts the limit as size", () => {
    expect(reason(new Uint8Array(MAX_FATTURAPA_BYTES + 1).fill(0x20))[0].message).toMatch(/5 MB/);
    expect(reason(" ".repeat(MAX_FATTURAPA_BYTES + 1))[0].message).toMatch(/5 MB/);
    expect(reason(new Uint8Array(MAX_FATTURAPA_BYTES).fill(0x20))[0].message).toBe("Il file è vuoto");
  });

  it("never throws on non-string, non-bytes input", () => {
    expect(parseFatturaPA(undefined as unknown as string).ok).toBe(false);
    expect(parseFatturaPA(null as unknown as string).ok).toBe(false);
  });
});

describe("parseFatturaPA: XXE and entity attacks", () => {
  it("refuses a DOCTYPE with an external entity, without reading the file", () => {
    const issues = issuesOf(parseFatturaPA(fixture("xxe.xml")));
    expect(issues).toEqual([{ field: "file", message: expect.stringMatching(/DOCTYPE/) }]);
    expect(JSON.stringify(issues)).not.toContain("root:");
  });

  it("refuses a billion laughs document quickly, without expanding it", () => {
    const start = Date.now();
    const issues = issuesOf(parseFatturaPA(fixture("billion-laughs.xml")));
    expect(issues[0].field).toBe("file");
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("refuses DOCTYPE in any case and entity declarations", () => {
    expect(parseFatturaPA(buildFatturaPA().replace("<Fattura", '<!doctype x><Fattura')).ok).toBe(false);
    expect(parseFatturaPA(buildFatturaPA().replace("<Fattura", '<!ENTITY a "b"><Fattura')).ok).toBe(false);
  });

  it("does not expand an undeclared entity reference", () => {
    const result = parseFatturaPA(buildFatturaPA({ anagrafica: "<Denominazione>A &foo; B</Denominazione>" }));
    expect(result).toMatchObject({ ok: true, data: { supplierName: "A &foo; B" } });
  });
});
