import pg from "pg";
import type { CompanyKnowledge, EmployeeContext, EmployeePersona, Evidence } from "../company-domain.js";
import type { EmbeddingProvider } from "../embeddings.js";
import { pgVector } from "../embeddings.js";
import { verifyPassword } from "../auth.js";

type EvidenceRow = {
  source_id: string;
  source_type: string;
  title: string | null;
  excerpt: string;
  occurred_at: Date | null;
  department: string | null;
  score: number | null;
};

function evidence(row: EvidenceRow): Evidence {
  return {
    sourceId: row.source_id,
    sourceType: row.source_type,
    title: row.title ?? row.source_id,
    excerpt: row.excerpt,
    ...(row.occurred_at ? { occurredAt: row.occurred_at.toISOString() } : {}),
    ...(row.department ? { department: row.department } : {}),
    ...(row.score === null ? {} : { score: Number(row.score) }),
  };
}

/** Reciprocal-rank fusion gives exact keyword matches and semantic matches equal input weight. */
function fuseEvidence(keyword: Evidence[], semantic: Evidence[], limit: number): Evidence[] {
  const ranked = new Map<string, { item: Evidence; score: number }>();
  for (const list of [keyword, semantic]) {
    list.forEach((item, index) => {
      const current = ranked.get(item.sourceId);
      const score = (current?.score ?? 0) + 1 / (60 + index + 1);
      ranked.set(item.sourceId, { item: { ...item, score }, score });
    });
  }
  return [...ranked.values()]
    .sort((left, right) => right.score - left.score || left.item.sourceId.localeCompare(right.item.sourceId))
    .slice(0, limit)
    .map(({ item }) => item);
}

export class PostgresCompanyKnowledge implements CompanyKnowledge {
  readonly pool: pg.Pool;

  constructor(databaseUrl: string, private readonly embeddings?: EmbeddingProvider) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
  }

  async employee(employeeId: string): Promise<EmployeeContext | null> {
    const result = await this.pool.query<{
      employee_id: string;
      display_name: string;
      role: string | null;
      department: string | null;
      current_assignments: unknown;
      avatar?: string | null;
    }>(
      `SELECT employee_id, display_name, role, department, current_assignments, avatar
       FROM employees WHERE employee_id = $1`,
      [employeeId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      employeeId: row.employee_id,
      displayName: row.display_name,
      ...(row.role ? { role: row.role } : {}),
      ...(row.department ? { department: row.department } : {}),
      avatar: row.avatar ?? "👤",
      currentAssignments: Array.isArray(row.current_assignments)
        ? row.current_assignments.filter((value): value is string => typeof value === "string")
        : [],
    };
  }

  async listEmployees(): Promise<EmployeePersona[]> {
    try {
      const result = await this.pool.query<{
        employee_id: string;
        display_name: string;
        role: string | null;
        department: string | null;
        avatar: string | null;
      }>(
        `SELECT employee_id, display_name, role, department, avatar
         FROM employees
         ORDER BY
           CASE employee_id
             WHEN 'jax' THEN 1
             WHEN 'priya' THEN 2
             WHEN 'chloe' THEN 3
             WHEN 'marcus' THEN 4
             WHEN 'deepa' THEN 5
             ELSE 6
           END, display_name ASC`,
      );
      return result.rows.map((row) => ({
        employeeId: row.employee_id,
        displayName: row.display_name,
        ...(row.role ? { role: row.role } : {}),
        ...(row.department ? { department: row.department } : {}),
        avatar: row.avatar ?? "👤",
      }));
    } catch {
      const result = await this.pool.query<{
        employee_id: string;
        display_name: string;
        role: string | null;
        department: string | null;
      }>(
        `SELECT employee_id, display_name, role, department
         FROM employees ORDER BY display_name ASC`,
      );
      return result.rows.map((row) => ({
        employeeId: row.employee_id,
        displayName: row.display_name,
        ...(row.role ? { role: row.role } : {}),
        ...(row.department ? { department: row.department } : {}),
        avatar: "👤",
      }));
    }
  }

  async verifyEmployeePassword(employeeId: string, password: string): Promise<EmployeePersona | null> {
    if (!password || typeof password !== "string" || !password.trim()) {
      return null;
    }
    const result = await this.pool.query<{
      employee_id: string;
      display_name: string;
      role: string | null;
      department: string | null;
      avatar: string | null;
      password_hash: string | null;
    }>(
      `SELECT employee_id, display_name, role, department, avatar, password_hash
       FROM employees WHERE employee_id = $1`,
      [employeeId.trim().toLowerCase()],
    );
    const row = result.rows[0];
    if (!row || !row.password_hash) return null;
    if (!verifyPassword(password, row.password_hash)) {
      return null;
    }
    return {
      employeeId: row.employee_id,
      displayName: row.display_name,
      ...(row.role ? { role: row.role } : {}),
      ...(row.department ? { department: row.department } : {}),
      avatar: row.avatar ?? "👤",
    };
  }

  async search(query: string, limit: number): Promise<Evidence[]> {
    const normalizedLimit = Math.min(Math.max(limit, 1), 12);
    const keyword = this.keywordSearch(query, normalizedLimit);
    if (!this.embeddings) return keyword;

    try {
      const [keywordResult, vectors] = await Promise.all([
        keyword,
        this.embeddings.embed([query], "query"),
      ]);
      const semanticResult = await this.semanticSearch(vectors[0]!, normalizedLimit);
      return fuseEvidence(keywordResult, semanticResult, normalizedLimit);
    } catch {
      // Keyword retrieval remains available when a hosted embedding provider is unavailable.
      return keyword;
    }
  }

  private async keywordSearch(query: string, limit: number): Promise<Evidence[]> {
    const result = await this.pool.query<EvidenceRow>(
      `WITH requested AS (SELECT websearch_to_tsquery('english', $1) AS query),
       ranked AS (
         SELECT c.source_id, c.content,
                ts_rank_cd(c.search_vector, requested.query) AS score,
                row_number() OVER (
                  PARTITION BY c.source_id
                  ORDER BY ts_rank_cd(c.search_vector, requested.query) DESC
                ) AS source_rank
         FROM document_chunks c, requested
         WHERE c.search_vector @@ requested.query
       )
       SELECT d.source_id, d.source_type, d.title,
              ranked.content AS excerpt, d.occurred_at, d.department, ranked.score
       FROM ranked JOIN source_documents d USING (source_id)
       WHERE ranked.source_rank = 1
       ORDER BY ranked.score DESC, d.occurred_at DESC NULLS LAST
       LIMIT $2`,
      [query, limit],
    );
    return result.rows.map(evidence);
  }

  private async semanticSearch(vector: number[], limit: number): Promise<Evidence[]> {
    const result = await this.pool.query<EvidenceRow>(
      `WITH ranked AS (
         SELECT c.source_id, c.content,
                1 - (c.embedding <=> $1::vector) AS score,
                row_number() OVER (
                  PARTITION BY c.source_id
                  ORDER BY c.embedding <=> $1::vector ASC
                ) AS source_rank
         FROM document_chunks c
         WHERE c.embedding IS NOT NULL
       )
       SELECT d.source_id, d.source_type, d.title,
              ranked.content AS excerpt, d.occurred_at, d.department, ranked.score
       FROM ranked JOIN source_documents d USING (source_id)
       WHERE ranked.source_rank = 1
       ORDER BY ranked.score DESC, d.occurred_at DESC NULLS LAST
       LIMIT $2`,
      [pgVector(vector), limit],
    );
    return result.rows.map(evidence);
  }

  async related(sourceIds: string[], limit: number): Promise<Evidence[]> {
    if (sourceIds.length === 0) return [];
    const result = await this.pool.query<EvidenceRow>(
      `WITH related_ids AS (
         SELECT related_source_id AS source_id
         FROM document_links WHERE source_id = ANY($1::text[])
         UNION
         SELECT source_id
         FROM document_links WHERE related_source_id = ANY($1::text[])
       )
       SELECT DISTINCT d.source_id, d.source_type, d.title,
              left(d.body, 1800) AS excerpt, d.occurred_at, d.department,
              NULL::double precision AS score
       FROM related_ids r JOIN source_documents d USING (source_id)
       ORDER BY d.occurred_at DESC NULLS LAST
       LIMIT $2`,
      [sourceIds, Math.min(Math.max(limit, 1), 12)],
    );
    return result.rows.map(evidence);
  }

  async sources(sourceIds: string[]): Promise<Evidence[]> {
    if (sourceIds.length === 0) return [];
    const result = await this.pool.query<EvidenceRow>(
      `SELECT source_id, source_type, title, body AS excerpt,
              occurred_at, department, NULL::double precision AS score
       FROM source_documents WHERE source_id = ANY($1::text[])`,
      [sourceIds],
    );
    return result.rows.map(evidence);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
