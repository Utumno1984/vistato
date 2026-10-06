/**
 * HATEOAS conventions (HAL-style `_links`).
 *
 * Every API resource carries the actions the *current* caller may perform as links.
 * The frontend renders buttons, menus and modules from these links only, so it never
 * needs to know about plans, prices or permissions.
 *
 * IMPORTANT: links describe what is available, they do not protect anything.
 * Every endpoint must still enforce permissions and entitlements server-side.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface Link {
  href: string;
  method?: HttpMethod; // omitted means GET
  title?: string;
}

export type Links = Record<string, Link>;

export type Resource<T extends object> = T & { _links: Links };

/** A link that is included only when `allowed` is true (permission, entitlement, state). */
export interface ConditionalLink {
  rel: string;
  link: Link;
  allowed: boolean;
}

export function buildLinks(entries: ConditionalLink[]): Links {
  const links: Links = {};
  for (const { rel, link, allowed } of entries) {
    if (!allowed) continue;
    if (rel in links) throw new Error(`Duplicate link relation "${rel}"`);
    links[rel] = link;
  }
  return links;
}

export function resource<T extends object>(data: T, links: Links): Resource<T> {
  if (!links.self) throw new Error("Every resource must expose a `self` link");
  return { ...data, _links: links };
}

export function hasLink(res: { _links?: Links }, rel: string): boolean {
  return Boolean(res._links && rel in res._links);
}
