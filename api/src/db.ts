export type Row = Record<string, unknown>;

export async function all(db: D1Database, sql: string, values: unknown[] = []): Promise<Row[]> {
  const result = await db.prepare(sql).bind(...values).all<Row>();
  return result.results;
}

export async function first(db: D1Database, sql: string, values: unknown[] = []): Promise<Row | null> {
  return db.prepare(sql).bind(...values).first<Row>();
}

export async function evidenceFor(db: D1Database, ids: string[]): Promise<Row[]> {
  if (ids.length === 0) return [];
  const unique = [...new Set(ids)];
  const evidence: Row[] = [];
  const sources: Row[] = [];
  for (let start = 0; start < unique.length; start += 80) {
    const batch = unique.slice(start, start + 80);
    const placeholders = batch.map(() => "?").join(",");
    evidence.push(
      ...(await all(
        db,
        `SELECT evidence_id, evidence_type, label, filing_accession AS accession_number, source_url
           FROM evidence_links WHERE evidence_id IN (${placeholders}) ORDER BY evidence_id`,
        batch,
      )),
    );
    sources.push(
      ...(await all(
        db,
        `SELECT evidence_id, source_evidence_id FROM evidence_sources
           WHERE evidence_id IN (${placeholders}) ORDER BY evidence_id, source_evidence_id`,
        batch,
      )),
    );
  }
  const byId = new Map<string, string[]>();
  for (const row of sources) {
    const key = String(row.evidence_id);
    const list = byId.get(key) ?? [];
    list.push(String(row.source_evidence_id));
    byId.set(key, list);
  }
  const linked: Row[] = evidence.map((row): Row => ({
    ...row,
    source_evidence_ids: byId.get(String(row.evidence_id)) ?? [],
  }));
  return linked.sort((left, right) =>
    String(left.evidence_id).localeCompare(String(right.evidence_id)),
  );
}

export function parseJsonColumn(value: unknown, fallback: unknown): unknown {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
