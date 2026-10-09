import { XMLParser, XMLValidator } from "fast-xml-parser";

import { fatturaPaDataSchema, type FatturaPaData } from "./schema";

export type { FatturaPaData } from "./schema";

export interface FatturaPaIssue {
  /** A key of `FatturaPaData`, or `file` for problems with the file as a whole. */
  field: string;
  /** Italian message, safe to show to the user. */
  message: string;
}

export type FatturaPaResult = { ok: true; data: FatturaPaData } | { ok: false; issues: FatturaPaIssue[] };

/** Inputs larger than this are refused (the HTTP API applies its own, lower limit). */
export const MAX_FATTURAPA_BYTES = 5 * 1024 * 1024;

/** Largest amount accepted: 11 integer digits, as in the FatturaPA schema. */
const AMOUNT_PATTERN = /^-?\d{1,11}\.\d{2}$/;

const AMOUNT_MESSAGE = "L'importo deve avere il formato 1234.50 (punto decimale, esattamente 2 decimali)";
const P7M_MESSAGE = "I file firmati (.p7m) non sono supportati: carica il file XML non firmato";
const TOO_BIG_MESSAGE = "Il file supera la dimensione massima di 5 MB";
const NOT_XML = "Il file non è un XML FatturaPA valido";

const fail = (field: string, message: string): FatturaPaResult => ({ ok: false, issues: [{ field, message }] });

/** Signed integer cents from a string like `-12.30`, with integer arithmetic only. */
function amountToCents(raw: string): number | null {
  if (!AMOUNT_PATTERN.test(raw)) return null;
  const negative = raw.startsWith("-");
  const [integer, decimals] = raw.replace("-", "").split(".");
  const cents = Number(integer) * 100 + Number(decimals);
  return negative && cents !== 0 ? -cents : cents;
}

const PREDEFINED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Decodes the predefined XML entities and numeric references (entity processing is off in the parser). */
function decodeEntities(value: string): string {
  return value.replace(
    /&(?:#x([0-9a-fA-F]{1,6})|#([0-9]{1,7})|(amp|lt|gt|quot|apos));/g,
    (whole, hex?: string, dec?: string, name?: string) => {
      if (name) return PREDEFINED_ENTITIES[name];
      const code = hex ? parseInt(hex, 16) : parseInt(dec ?? "", 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
    },
  );
}

function decodeInput(input: string | Uint8Array): { text: string } | { error: string } {
  if (typeof input === "string") {
    return input.length > MAX_FATTURAPA_BYTES ? { error: TOO_BIG_MESSAGE } : { text: input };
  }
  if (input.byteLength > MAX_FATTURAPA_BYTES) return { error: TOO_BIG_MESSAGE };
  // DER-encoded CMS (.p7m) starts with a SEQUENCE tag (0x30) and contains NUL bytes.
  if (input[0] === 0x30 || input.subarray(0, 4096).includes(0)) return { error: P7M_MESSAGE };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input) };
  } catch {
    return { error: "Il file non è codificato in UTF-8" };
  }
}

type Node = Record<string, unknown>;

/** Reads the tree and collects the issues: the first issue of a field wins. */
class Reader {
  readonly issues: FatturaPaIssue[] = [];
  private readonly failed = new Set<string>();

  report(field: string, message: string) {
    if (this.failed.has(field)) return;
    this.failed.add(field);
    this.issues.push({ field, message });
  }

  has(field: string) {
    return this.failed.has(field);
  }

  /** The single child element `name` of `node`, or undefined; a repeated one is reported on `field`. */
  child(node: unknown, name: string, field: string): unknown {
    if (typeof node !== "object" || node === null) return undefined;
    const value = (node as Node)[name];
    if (Array.isArray(value)) {
      this.report(field, `L'elemento ${name} è ripetuto: ne è ammesso uno solo`);
      return undefined;
    }
    return value;
  }

  /** Trimmed text of the element at `path`, undefined when absent; an element with children is reported. */
  text(root: unknown, path: string[], field: string): string | undefined {
    let current = root;
    for (const name of path) {
      current = this.child(current, name, field);
      if (current === undefined) return undefined;
    }
    if (typeof current === "string") return decodeEntities(current).trim();
    this.report(field, `L'elemento ${path[path.length - 1]} deve contenere solo testo`);
    return undefined;
  }
}

const parser = new XMLParser({
  ignoreAttributes: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
  htmlEntities: false,
  trimValues: true,
  isArray: (name) => name === "FatturaElettronicaBody" || name === "DatiRiepilogo",
});

/**
 * Reads a FatturaPA XML file (also with a namespace prefix, versions FPR12 and FPA12) and
 * returns the data Vistato needs, validated. Pure: no I/O, never throws.
 *
 * Rules worth knowing:
 * - `<!DOCTYPE` and entity declarations are refused before parsing (XXE, billion laughs).
 * - Only UTF-8 is read; `.p7m` signed files and batches (several bodies) are refused.
 * - Amounts are converted to integer cents from strings, never through floats.
 * - When `ImportoTotaleDocumento` is present it wins, even if it differs from the sum of
 *   the `DatiRiepilogo` (`ImponibileImporto` + `Imposta`), which is used only when it is absent.
 */
export function parseFatturaPA(input: string | Uint8Array, options: ParseOptions = {}): FatturaPaResult {
  try {
    return parseUnsafe(input, options);
  } catch {
    return fail("file", NOT_XML);
  }
}

export interface ParseOptions {
  /**
   * Uppercase the supplier VAT country and VAT code (`fr`/`ab123` become `FR`/`AB123`) instead of
   * refusing the lowercase country. Only ASCII letters are converted, so `ﬀ` or a dotless `ı` stay
   * invalid. Default: false.
   */
  normalizeVatCase?: boolean;
}

const upperAscii = (value: string | undefined) => value?.replace(/[a-z]/g, (c) => c.toUpperCase());

function parseUnsafe(input: string | Uint8Array, options: ParseOptions): FatturaPaResult {
  const decoded = decodeInput(input);
  if ("error" in decoded) return fail("file", decoded.error);

  const xml = decoded.text.replace(/^﻿/, "");
  if (xml.trim() === "") return fail("file", "Il file è vuoto");
  if (!xml.includes("<") && /^\s*MI[A-Za-z0-9+/=\s]*$/.test(xml.slice(0, 200))) return fail("file", P7M_MESSAGE);
  if (!xml.trimStart().startsWith("<")) return fail("file", NOT_XML);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    return fail("file", "Il file contiene una dichiarazione DOCTYPE o entità, non ammesse");
  }
  if (XMLValidator.validate(xml) !== true) return fail("file", "Il file XML è malformato");

  const tree = parser.parse(xml) as Node;
  const rootNames = Object.keys(tree);
  if (rootNames.length !== 1 || rootNames[0] !== "FatturaElettronica" || typeof tree.FatturaElettronica !== "object") {
    return fail("file", "Il file non è una fattura elettronica (radice FatturaElettronica non trovata)");
  }
  const root = tree.FatturaElettronica as Node;

  const bodies = root.FatturaElettronicaBody;
  if (!Array.isArray(bodies) || bodies.length === 0) {
    return fail("file", "Il file non contiene nessuna fattura (FatturaElettronicaBody mancante)");
  }
  if (bodies.length > 1) return fail("file", "Il file contiene più fatture: caricarle una alla volta");
  const body: unknown = bodies[0];

  const r = new Reader();
  const supplier = ["FatturaElettronicaHeader", "CedentePrestatore", "DatiAnagrafici"];
  const general = ["DatiGenerali", "DatiGeneraliDocumento"];

  const rawVatCountry = r.text(root, [...supplier, "IdFiscaleIVA", "IdPaese"], "supplierVatCountry");
  const rawVatCode = r.text(root, [...supplier, "IdFiscaleIVA", "IdCodice"], "supplierVatCode");
  const supplierVatCountry = options.normalizeVatCase ? upperAscii(rawVatCountry) : rawVatCountry;
  const supplierVatCode = options.normalizeVatCase ? upperAscii(rawVatCode) : rawVatCode;

  const denomination = r.text(root, [...supplier, "Anagrafica", "Denominazione"], "supplierName");
  const firstName = r.text(root, [...supplier, "Anagrafica", "Nome"], "supplierName");
  const lastName = r.text(root, [...supplier, "Anagrafica", "Cognome"], "supplierName");
  // Denominazione wins; otherwise both Nome and Cognome are needed.
  const supplierName = denomination || (firstName && lastName ? `${firstName} ${lastName}` : undefined);

  const documentType = r.text(body, [...general, "TipoDocumento"], "documentType");
  const currency = r.text(body, [...general, "Divisa"], "currency");
  const invoiceDate = r.text(body, [...general, "Data"], "invoiceDate");
  const invoiceNumber = r.text(body, [...general, "Numero"], "invoiceNumber");

  let totalAmountCents: number | undefined;
  const rawTotal = r.text(body, [...general, "ImportoTotaleDocumento"], "totalAmountCents");
  if (rawTotal !== undefined) {
    const cents = amountToCents(rawTotal);
    if (cents === null) r.report("totalAmountCents", AMOUNT_MESSAGE);
    else totalAmountCents = cents;
  } else if (!r.has("totalAmountCents")) {
    totalAmountCents = sumSummaries(r, body);
  }

  const parsed = fatturaPaDataSchema.safeParse({
    documentType,
    supplierName,
    supplierVatCountry,
    supplierVatCode,
    invoiceNumber,
    invoiceDate,
    totalAmountCents,
    currency,
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) r.report(String(issue.path[0] ?? "file"), issue.message);
  }
  if (!parsed.success || r.issues.length > 0) return { ok: false, issues: r.issues };
  return { ok: true, data: parsed.data };
}

/** Sum of ImponibileImporto + Imposta over all DatiRiepilogo, in integer cents. */
function sumSummaries(r: Reader, body: unknown): number | undefined {
  const field = "totalAmountCents";
  const goods = r.child(body, "DatiBeniServizi", field);
  const summaries = typeof goods === "object" && goods !== null ? (goods as Node).DatiRiepilogo : undefined;
  if (!Array.isArray(summaries) || summaries.length === 0) {
    r.report(field, "Importo non trovato: mancano ImportoTotaleDocumento e DatiRiepilogo");
    return undefined;
  }
  let total = 0;
  for (const summary of summaries) {
    for (const name of ["ImponibileImporto", "Imposta"]) {
      const raw = r.text(summary, [name], field);
      if (raw === undefined) {
        r.report(field, `Importo non valido: ${name} mancante in un DatiRiepilogo`);
        return undefined;
      }
      const cents = amountToCents(raw);
      if (cents === null) {
        r.report(field, AMOUNT_MESSAGE);
        return undefined;
      }
      total += cents;
    }
  }
  return total;
}
