import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const CSS = readFileSync(join(import.meta.dirname, "..", "..", "src", "app", "globals.css"), "utf8");

type Rgb = [number, number, number];

/** Linear-light sRGB (unclamped) from OKLCH. */
function oklchToLinear(l: number, c: number, hDeg: number): Rgb {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const toLinear = (channel: number) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);

const toEncoded = (linear: number) => (linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055);

/** A CSS colour (hex or oklch(), optional alpha) as linear sRGB, composited over `over`. */
function resolve(value: string, over: Rgb = [1, 1, 1]): Rgb {
  const v = value.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => toLinear(x / 255)) as Rgb;
  }
  const m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+)(%?))?\s*\)$/.exec(v);
  if (!m) throw new Error(`unsupported colour: ${value}`);
  const rgb = oklchToLinear(Number(m[1]), Number(m[2]), Number(m[3])).map((x) => Math.min(1, Math.max(0, x))) as Rgb;
  const alpha = m[4] === undefined ? 1 : m[5] ? Number(m[4]) / 100 : Number(m[4]);
  // Browsers blend in gamma-encoded sRGB, not in linear light.
  return rgb.map((x, i) => toLinear(toEncoded(x) * alpha + toEncoded(over[i]) * (1 - alpha))) as Rgb;
}

const luminance = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** WCAG 2.x contrast ratio. */
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function variable(block: string, name: string): string {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(block);
  if (!m) throw new Error(`--${name} not found`);
  return m[1];
}

const lightBlock = /:root\s*\{([^}]*)\}/.exec(CSS)![1];
const darkBlock = /prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(CSS)![1];

describe("contrast helper", () => {
  it("gives 21:1 for black on white and 1:1 for identical colours", () => {
    expect(contrast(resolve("#000000"), resolve("#ffffff"))).toBeCloseTo(21, 5);
    expect(contrast(resolve("#777777"), resolve("#777777"))).toBe(1);
  });

  it("matches the known value of #767676 on white (4.54:1)", () => {
    expect(contrast(resolve("#767676"), resolve("#ffffff"))).toBeCloseTo(4.54, 1);
  });

  it("composites a translucent colour over the background", () => {
    const dark = resolve("#0a0a0a");
    expect(contrast(resolve("oklch(1 0 0 / 0%)", dark), dark)).toBeCloseTo(1, 5);
  });
});

describe("border colours of outline buttons, Input and Textarea (WCAG 1.4.11, at least 3:1)", () => {
  function ratioOf(block: string, name: string): number {
    const background = resolve(variable(block, "background"));
    return contrast(resolve(variable(block, name), background), background);
  }

  it("--border in the light theme", () => {
    expect(ratioOf(lightBlock, "border")).toBeGreaterThanOrEqual(3);
  });

  it("--input in the light theme", () => {
    expect(ratioOf(lightBlock, "input")).toBeGreaterThanOrEqual(3);
  });

  it("--border in the dark theme", () => {
    expect(ratioOf(darkBlock, "border")).toBeGreaterThanOrEqual(3);
  });

  it("--input in the dark theme", () => {
    expect(ratioOf(darkBlock, "input")).toBeGreaterThanOrEqual(3);
  });
});
