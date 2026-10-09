import { describe, expect, it } from "vitest";

import { describeUploadResponse } from "@/lib/invoices/upload-messages";

const error = (message: string) => ({ kind: "error", messages: [message] });

describe("describeUploadResponse", () => {
  it("maps 201 to the success message", () => {
    expect(describeUploadResponse(201, { id: "x" })).toEqual({
      kind: "success",
      messages: ["Fattura caricata"],
    });
  });

  it("maps 401 to unauthenticated", () => {
    expect(describeUploadResponse(401, { error: "unauthenticated" })).toEqual({
      kind: "unauthenticated",
    });
  });

  it("maps a duplicate", () => {
    expect(describeUploadResponse(409, { error: "duplicate_invoice" })).toEqual(
      error("Questa fattura è già stata caricata"),
    );
  });

  it("maps size and media type errors to specific messages", () => {
    expect(describeUploadResponse(413, { error: "payload_too_large" })).toEqual(
      error("Il file supera la dimensione massima di 5 MB"),
    );
    const media = describeUploadResponse(415, {
      error: "unsupported_media_type",
    });
    expect(media).toMatchObject({ kind: "error" });
    expect(JSON.stringify(media)).toContain(".p7m");
  });

  it("shows every validation issue of an invalid invoice", () => {
    expect(
      describeUploadResponse(422, {
        error: "invalid_invoice",
        issues: [
          {
            field: "invoiceDate",
            message: "La data della fattura non è valida",
          },
          { field: "number", message: "Numero mancante" },
        ],
      }),
    ).toEqual({
      kind: "error",
      messages: ["La data della fattura non è valida", "Numero mancante"],
    });
  });

  it("falls back to a generic invalid-invoice message without issues", () => {
    expect(describeUploadResponse(422, { error: "invalid_invoice" })).toEqual(
      error("Il file non è una fattura elettronica valida"),
    );
  });

  it("asks to choose a file when it is missing, and reports an empty file", () => {
    expect(
      describeUploadResponse(400, {
        error: "invalid_request",
        issues: [{ field: "file", message: "Il campo file è obbligatorio" }],
      }),
    ).toEqual(error("Seleziona un file XML"));
    expect(
      describeUploadResponse(400, {
        error: "invalid_request",
        issues: [{ field: "file", message: "Il file è vuoto" }],
      }),
    ).toEqual(error("Il file è vuoto"));
  });

  it("uses a generic message for unknown or non-JSON answers", () => {
    expect(describeUploadResponse(500, null)).toEqual(
      error("Caricamento non riuscito, riprova"),
    );
    expect(describeUploadResponse(502, "<html>")).toEqual(
      error("Caricamento non riuscito, riprova"),
    );
  });
});
