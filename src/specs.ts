import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { areaOfTag } from './areas.js';

// The operations the tools can call, read from Atlassian's own OpenAPI specifications of the
// Jira Cloud platform API and the Automation API. They are fetched from Atlassian when first
// needed and kept for a day, so the tools follow the API as Atlassian changes it; a folder of the
// two files can stand in for a server without access to developer.atlassian.com.

export const SPEC_URLS = {
  jira: 'https://dac-static.atlassian.com/cloud/jira/platform/swagger-v3.v3.json',
  automation: 'https://dac-static.atlassian.com/cloud/automation/swagger.v3.json',
} as const;
export type Api = keyof typeof SPEC_URLS;

const METHODS = ['get', 'post', 'put', 'delete', 'patch'] as const;
export type Method = Uppercase<(typeof METHODS)[number]>;

export type Param = {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  description: string;
  schema: unknown;
};

export type Operation = {
  id: string;
  api: Api;
  method: Method;
  path: string;
  area: string;
  summary: string;
  description: string;
  /** It only reads: a GET, or a POST that searches, checks or evaluates. */
  reads: boolean;
  deprecated: boolean;
  params: Param[];
  body?: { required: boolean; schema: unknown };
};

export type Catalog = {
  operations: Map<string, Operation>;
  versions: Record<Api, string>;
  /** Resolves `$ref`s of a schema in the spec it came from, as deep as `depth`. */
  expand: (op: Operation, schema: unknown, depth?: number) => unknown;
};

// POSTs that read: searches, lookups by id, checks and evaluations. They change nothing.
const READING_POST = /^(get|search|find|parse|analyse|match|evaluate|list|validate|read|sanitise)/i;

type Spec = {
  info?: { version?: string };
  paths?: Record<string, Record<string, unknown>>;
  components?: Record<string, Record<string, unknown>>;
};
type RawOp = {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters?: unknown[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: unknown }> };
};

function cacheDir(env: NodeJS.ProcessEnv): string {
  return join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'jira-cloud-admin-mcp');
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function loadSpec(api: Api, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch): Promise<Spec> {
  const file = `${api}.json`;
  if (env.JIRA_OPENAPI_DIR) return JSON.parse(readFileSync(join(env.JIRA_OPENAPI_DIR, file), 'utf8')) as Spec;
  const kept = join(cacheDir(env), file);
  try {
    if (Date.now() - statSync(kept).mtimeMs < DAY_MS) return JSON.parse(readFileSync(kept, 'utf8')) as Spec;
  } catch {
    // Not kept yet, or unreadable: fetched below.
  }
  let text: string;
  try {
    const response = await fetchImpl(SPEC_URLS[api], { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`${SPEC_URLS[api]} answered ${response.status}`);
    text = await response.text();
  } catch (error) {
    // An old copy is better than none while Atlassian cannot be reached.
    try {
      return JSON.parse(readFileSync(kept, 'utf8')) as Spec;
    } catch {
      throw new Error(
        `Could not read the ${api} API specification from Atlassian (${(error as Error).message}). ` +
          'Allow this server to reach dac-static.atlassian.com, or set JIRA_OPENAPI_DIR to a folder ' +
          'with jira.json and automation.json.',
      );
    }
  }
  try {
    mkdirSync(cacheDir(env), { recursive: true, mode: 0o700 });
    writeFileSync(kept, text, { mode: 0o600 });
  } catch {
    // A read-only home keeps nothing; the specification is fetched again next start.
  }
  return JSON.parse(text) as Spec;
}

/** What a local reference points at, as a JSON pointer into the spec: #/components/schemas/A/properties/b. */
function refTarget(spec: Spec, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let at: unknown = spec;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!at || typeof at !== 'object' || !Object.hasOwn(at, key)) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

function expander(spec: Spec) {
  const expand = (schema: unknown, depth: number): unknown => {
    if (Array.isArray(schema)) return schema.map((item) => expand(item, depth));
    if (!schema || typeof schema !== 'object') return schema;
    const record = schema as Record<string, unknown>;
    if (typeof record.$ref === 'string') {
      const name = record.$ref.split('/').pop();
      if (depth <= 0) return { $ref: name };
      return expand(refTarget(spec, record.$ref), depth - 1);
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      // Examples and docs of fields are long and the agent asks describe for them anyway.
      if (key === 'example' || key === 'examples' || key === 'externalDocs') continue;
      out[key] = expand(value, depth);
    }
    return out;
  };
  return expand;
}

function operationsOf(api: Api, spec: Spec): Operation[] {
  const found: Operation[] = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of METHODS) {
      const raw = item[method] as RawOp | undefined;
      if (!raw?.operationId) continue;
      const area = api === 'automation' ? 'automation' : areaOfTag(raw.tags?.[0] ?? '');
      if (!area) continue;
      const params = [
        ...((item.parameters as unknown[] | undefined) ?? []),
        ...(raw.parameters ?? []),
      ]
        .map((param) => {
          const p = (
            (param as { $ref?: string }).$ref
              ? refTarget(spec, (param as { $ref: string }).$ref)
              : param
          ) as { name?: string; in?: string; required?: boolean; description?: string; schema?: unknown };
          return p;
        })
        .filter((p): p is Required<Pick<typeof p, 'name' | 'in'>> & typeof p =>
          Boolean(p?.name) && (p?.in === 'path' || p?.in === 'query'),
        )
        .map((p) => ({
          name: p.name,
          in: p.in as 'path' | 'query',
          required: p.in === 'path' || p.required === true,
          description: (p.description ?? '').slice(0, 400),
          schema: p.schema ?? {},
        }));
      const json = raw.requestBody?.content?.['application/json'];
      const upper = method.toUpperCase() as Method;
      found.push({
        id: raw.operationId,
        api,
        method: upper,
        path,
        area,
        summary: raw.summary ?? raw.operationId,
        description: raw.description ?? '',
        reads: upper === 'GET' || (upper === 'POST' && READING_POST.test(raw.operationId)),
        deprecated: raw.deprecated === true,
        params,
        ...(json && { body: { required: raw.requestBody?.required === true, schema: json.schema ?? {} } }),
      });
    }
  }
  return found;
}

/** Reads both specifications and indexes their administration operations by id. */
export async function loadCatalog(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<Catalog> {
  const [jira, automation] = await Promise.all([
    loadSpec('jira', env, fetchImpl),
    loadSpec('automation', env, fetchImpl),
  ]);
  const specs: Record<Api, Spec> = { jira, automation };
  const operations = new Map<string, Operation>();
  for (const api of ['jira', 'automation'] as const) {
    for (const op of operationsOf(api, specs[api])) {
      // Ids are unique within a spec; an Automation id that a Jira one has gets a prefix.
      operations.set(operations.has(op.id) ? `automation.${op.id}` : op.id, op);
    }
  }
  const expanders = { jira: expander(jira), automation: expander(automation) };
  return {
    operations,
    versions: { jira: jira.info?.version ?? 'unknown', automation: automation.info?.version ?? 'unknown' },
    expand: (op, schema, depth = 3) => expanders[op.api](schema, depth),
  };
}

/** The operations whose id, summary, path or area hold every word of the query, best first. */
export function findOperations(catalog: Catalog, query: string, area?: string, limit = 15) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored: { op: Operation; id: string; score: number }[] = [];
  for (const [id, op] of catalog.operations) {
    if (area && op.area !== area) continue;
    const haystack = `${id} ${op.summary} ${op.path} ${op.area}`.toLowerCase();
    if (!words.every((word) => haystack.includes(word))) continue;
    const inSummary = words.filter((word) => op.summary.toLowerCase().includes(word)).length;
    scored.push({ op, id, score: inSummary * 2 + (op.deprecated ? -5 : 0) });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
