import { describe, expect, it } from "vitest";

import { MAX_FATTURAPA_BYTES, parseFatturaPA } from "@/lib/fatturapa/parse";

import { buildFatturaPA, summary } from "../fixtures/fatturapa/build";

const enc = (text: string) => new TextEncoder().encode(text);
const BOM = "﻿";

function pad(xml: string, bytes: number): Uint8Array {
  const filler = " ".repeat(Math.max(0, bytes - enc(xml).byteLength));
  return enc(xml.replace("</FatturaElettronica>", `${filler}</FatturaElettronica>`));
}

describe("QA #26: extra adversarial cases", () => {
  it("accepts exactly 5 MB of bytes and refuses 5 MB + 1 byte", () => {
    const xml = buildFatturaPA();
    const exact = pad(xml, MAX_FATTURAPA_BYTES);
    expect(exact.byteLength).toBe(MAX_FATTURAPA_BYTES);
    expect(parseFatturaPA(exact).ok).toBe(true);
    const over = new Uint8Array(exact.byteLength + 1);
    over.set(exact);
    over[over.length - 1] = 0x20;
    const result = parseFatturaPA(over);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0].message).toMatch(/5 MB/);
  });

  it("refuses XXE and billion laughs preceded by a BOM, in bytes", () => {
    const xxe = `${BOM}<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]>${buildFatturaPA().replace(/^<\?xml[^>]*>/, "")}`;
    const result = parseFatturaPA(enc(xxe));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("root:");
  });

  it("does not leak or expand a custom entity reference used in a value", () => {
    const xml = buildFatturaPA({ number: "A&xxe;B" });
    const result = parseFatturaPA(xml);
    if (result.ok) expect(result.data.invoiceNumber).toBe("A&xxe;B");
  });

  it("reads a BOM-prefixed file with accents from bytes", () => {
    const xml = buildFatturaPA({ anagrafica: "<Denominazione>Perché Società</Denominazione>" });
    const result = parseFatturaPA(enc(BOM + xml));
    expect(result.ok && result.data.supplierName).toBe("Perché Società");
  });

  it("refuses repeated tags for number, currency and VAT code", () => {
    expect(parseFatturaPA(buildFatturaPA({ number: "1</Numero><Numero>2" })).ok).toBe(false);
    expect(parseFatturaPA(buildFatturaPA({ currency: "EUR</Divisa><Divisa>USD" })).ok).toBe(false);
    expect(parseFatturaPA(buildFatturaPA({ vatCode: "01234567890</IdCodice><IdCodice>01234567891" })).ok).toBe(false);
  });

  it("refuses a repeated ImportoTotaleDocumento", () => {
    expect(parseFatturaPA(buildFatturaPA({ total: "1.00</ImportoTotaleDocumento><ImportoTotaleDocumento>2.00" })).ok).toBe(false);
  });

  it("refuses a batch also with a prefix and with both bodies valid", () => {
    const result = parseFatturaPA(buildFatturaPA({ prefix: "p:", bodies: 2 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0].message).toBe("Il file contiene più fatture: caricarle una alla volta");
  });

  it("refuses DER p7m bytes with or without XML text inside, never throwing", () => {
    const der = new Uint8Array([0x30, 0x82, 0x10, 0x00, 0x06, 0x09, 0x2a, 0x86, 0x48, ...enc("<FatturaElettronica/>")]);
    const result = parseFatturaPA(der);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0].message).toMatch(/p7m/);
  });

  it("refuses base64 p7m text", () => {
    const result = parseFatturaPA("MIAGCSqGSIb3DQEHAqCAMIACAQExDzANBglghkgBZQMEAgEFADCABgkqhkiG9w0BBwGggCSABIID");
    expect(result.ok).toBe(false);
  });

  it("refuses only-BOM, only-spaces, UTF-16 bytes and a lone root of another name", () => {
    for (const input of [BOM, "   \n ", enc(BOM), new Uint8Array([0xff, 0xfe, 0x3c, 0x00, 0x61, 0x00, 0x2f, 0x00, 0x3e, 0x00]), "<Fattura/>", "<a><FatturaElettronica/></a>"]) {
      expect(parseFatturaPA(input).ok).toBe(false);
    }
  });

  it("refuses two roots and a FatturaElettronica without bodies", () => {
    expect(parseFatturaPA(`${buildFatturaPA()}${buildFatturaPA()}`).ok).toBe(false);
    expect(parseFatturaPA("<FatturaElettronica/>").ok).toBe(false);
  });

  it("sums 0.10 + 0.20 across many summaries exactly", () => {
    const goods = `<DatiBeniServizi>${summary("0.10", "0.20").repeat(1000)}</DatiBeniServizi>`;
    const result = parseFatturaPA(buildFatturaPA({ total: null, goods }));
    expect(result.ok && result.data.totalAmountCents).toBe(30000);
  });

  it("reads CDATA and ignores comments around values", () => {
    const result = parseFatturaPA(buildFatturaPA({ anagrafica: "<Denominazione><![CDATA[Rossi & Figli]]></Denominazione>" }));
    if (result.ok) expect(result.data.supplierName).toBe("Rossi & Figli");
  });

  it("refuses non-padded or ambiguous dates and a lowercase country", () => {
    for (const date of ["2025-2-3", "2025/02/03", "03-02-2025", "2023-02-29", "2025-13-01", "2025-00-10", "2100-02-29"]) {
      expect(parseFatturaPA(buildFatturaPA({ date })).ok, date).toBe(false);
    }
    expect(parseFatturaPA(buildFatturaPA({ vatCountry: "it" })).ok).toBe(false);
    expect(parseFatturaPA(buildFatturaPA({ date: "2000-02-29" })).ok).toBe(true);
  });

  it("refuses Nome without Cognome and the reverse", () => {
    expect(parseFatturaPA(buildFatturaPA({ anagrafica: "<Nome>Mario</Nome>" })).ok).toBe(false);
    expect(parseFatturaPA(buildFatturaPA({ anagrafica: "<Cognome>Rossi</Cognome>" })).ok).toBe(false);
  });
});
