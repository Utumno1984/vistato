import { describe, expect, it } from "vitest";

import { buildLinks, hasLink, resource } from "@/lib/hateoas";

describe("buildLinks", () => {
  it("includes only the allowed links", () => {
    const links = buildLinks([
      { rel: "self", link: { href: "/api/invoices/1" }, allowed: true },
      { rel: "approve", link: { href: "/api/invoices/1/approve", method: "POST" }, allowed: true },
      { rel: "cost-centers", link: { href: "/api/cost-centers" }, allowed: false }, // module not purchased
    ]);
    expect(Object.keys(links)).toEqual(["self", "approve"]);
    expect(links.approve.method).toBe("POST");
  });

  it("rejects duplicate relations", () => {
    expect(() =>
      buildLinks([
        { rel: "self", link: { href: "/a" }, allowed: true },
        { rel: "self", link: { href: "/b" }, allowed: true },
      ]),
    ).toThrow(/Duplicate link relation "self"/);
  });
});

describe("resource", () => {
  it("attaches links to the data", () => {
    const res = resource({ id: 1 }, { self: { href: "/api/x/1" } });
    expect(res).toEqual({ id: 1, _links: { self: { href: "/api/x/1" } } });
    expect(hasLink(res, "self")).toBe(true);
    expect(hasLink(res, "approve")).toBe(false);
  });

  it("requires a self link", () => {
    expect(() => resource({ id: 1 }, {})).toThrow(/self/);
  });
});
