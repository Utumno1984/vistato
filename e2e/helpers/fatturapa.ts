/**
 * Minimal FatturaPA XML for the e2e tests (e2e code cannot import from `tests/`, see the
 * ESLint restricted zones). The complete builder for the parser tests is
 * `tests/fixtures/fatturapa/build.ts`.
 */
export interface E2eInvoiceOptions {
  vatCountry?: string;
  vatCode?: string;
  number?: string;
  date?: string;
  total?: string;
  /** More than 1 makes a batch (refused by the parser). */
  bodies?: number;
}

export function buildInvoiceXml(options: E2eInvoiceOptions = {}): string {
  const body =
    `<FatturaElettronicaBody><DatiGenerali><DatiGeneraliDocumento><TipoDocumento>TD01</TipoDocumento><Divisa>EUR</Divisa>` +
    `<Data>${options.date ?? "2024-02-29"}</Data><Numero>${options.number ?? "FT/2024/001"}</Numero>` +
    `<ImportoTotaleDocumento>${options.total ?? "1234.50"}</ImportoTotaleDocumento></DatiGeneraliDocumento></DatiGenerali></FatturaElettronicaBody>`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<FatturaElettronica versione="FPR12"><FatturaElettronicaHeader><CedentePrestatore><DatiAnagrafici>` +
    `<IdFiscaleIVA><IdPaese>${options.vatCountry ?? "IT"}</IdPaese><IdCodice>${options.vatCode ?? "01234567890"}</IdCodice></IdFiscaleIVA>` +
    `<Anagrafica><Denominazione>Caffè &amp; Co. S.r.l.</Denominazione></Anagrafica></DatiAnagrafici></CedentePrestatore></FatturaElettronicaHeader>` +
    `${body.repeat(options.bodies ?? 1)}</FatturaElettronica>`
  );
}
