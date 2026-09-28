// Loop link catalog. A person types the row. Nothing here reads a page.

export interface ProcessLink {
  name: string;
  url: string;
  owner: string | null;
  description: string | null;
}

/** Case-insensitive match across name, URL, owner, and the one-line note. */
export function filterProcessLinks<T extends ProcessLink>(links: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return links;
  return links.filter((link) =>
    [link.name, link.url, link.owner ?? "", link.description ?? ""].some((field) => field.toLowerCase().includes(needle))
  );
}
