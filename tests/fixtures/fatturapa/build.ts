/** Builds FatturaPA XML for tests; every part can be overridden to produce invalid variants. */
export interface BuildOptions {
  /** Namespace prefix including the colon, e.g. "p:" or "ns2:". */
  prefix?: string;
  version?: string;
  /** Raw XML of the `IdFiscaleIVA` content, or null to omit the whole element. */
  vatCountry?: string | null;
  vatCode?: string | null;
  /** Raw XML inside `Anagrafica`. */
  anagrafica?: string;
  documentType?: string | null;
  currency?: string | null;
  date?: string | null;
  number?: string | null;
  /** null omits `ImportoTotaleDocumento`. */
  total?: string | null;
  /** Raw XML of the `DatiBeniServizi` element, or null to omit it. */
  goods?: string | null;
  /** Number of bodies (batch when > 1). */
  bodies?: number;
  /** Extra raw XML inside `DatiGeneraliDocumento`. */
  extraGeneral?: string;
}

export function summary(taxable: string, tax: string, prefix = ""): string {
  const p = prefix;
  return `<${p}DatiRiepilogo><${p}AliquotaIVA>22.00</${p}AliquotaIVA><${p}ImponibileImporto>${taxable}</${p}ImponibileImporto><${p}Imposta>${tax}</${p}Imposta></${p}DatiRiepilogo>`;
}

export function buildFatturaPA(options: BuildOptions = {}): string {
  const p = options.prefix ?? "";
  const tag = (name: string, value: string | null | undefined, fallback: string) => {
    const content = value === undefined ? fallback : value;
    return content === null ? "" : `<${p}${name}>${content}</${p}${name}>`;
  };
  const anagrafica = options.anagrafica ?? `<${p}Denominazione>Caffè &amp; Co. S.r.l.</${p}Denominazione>`;
  const vat =
    options.vatCountry === null
      ? ""
      : `<${p}IdFiscaleIVA>${tag("IdPaese", options.vatCountry, "IT")}${tag("IdCodice", options.vatCode, "01234567890")}</${p}IdFiscaleIVA>`;
  const goods = options.goods === undefined ? `<${p}DatiBeniServizi>${summary("1011.89", "222.61", p)}</${p}DatiBeniServizi>` : (options.goods ?? "");
  const body = `<${p}FatturaElettronicaBody><${p}DatiGenerali><${p}DatiGeneraliDocumento>${tag("TipoDocumento", options.documentType, "TD01")}${tag("Divisa", options.currency, "EUR")}${tag("Data", options.date, "2024-02-29")}${tag("Numero", options.number, "FT/2024/001")}${tag("ImportoTotaleDocumento", options.total, "1234.50")}${options.extraGeneral ?? ""}</${p}DatiGeneraliDocumento></${p}DatiGenerali>${goods}</${p}FatturaElettronicaBody>`;
  const header = `<${p}FatturaElettronicaHeader><${p}CedentePrestatore><${p}DatiAnagrafici>${vat}<${p}Anagrafica>${anagrafica}</${p}Anagrafica></${p}DatiAnagrafici></${p}CedentePrestatore></${p}FatturaElettronicaHeader>`;
  const ns = p ? ` xmlns:${p.slice(0, -1)}="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2"` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${p}FatturaElettronica versione="${options.version ?? "FPR12"}"${ns}>\n${header}\n${body.repeat(options.bodies ?? 1)}\n</${p}FatturaElettronica>`;
}
