import type { Operation } from './specs.js';
import { VERSION } from './version.js';

// Calls Jira Cloud as the person whose credentials come with the call: a site and an
// Authorization header (Basic, an Atlassian account's email and API token). Nothing is kept
// between calls but the site's cloud id, which is public.

export type Credentials = { site: string; authorization: string };

export type ErrorKind =
  | 'invalid_arguments'
  | 'auth_failed'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rejected'
  | 'rate_limited'
  | 'jira_unavailable'
  | 'network';

/** A failure the agent can act on: what kind, what Jira said, and what to try. */
export class JiraError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly hint: string,
    readonly status?: number,
  ) {
    super(message);
  }
  get retryable(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'jira_unavailable' || this.kind === 'network';
  }
}

/** A Jira Cloud site's host: <name>.atlassian.net, nothing else, so no call goes anywhere else. */
const SITE = /^[a-z0-9][a-z0-9-]{0,62}\.atlassian\.net$/;

export function siteOf(value: string): string {
  const host = value
    .trim()
    .toLowerCase()
    .replace(/^https:\/\//, '')
    .replace(/\/+$/, '');
  if (!SITE.test(host)) {
    throw new JiraError(
      'invalid_arguments',
      `${value} is not a Jira Cloud site`,
      'Give the site as acme.atlassian.net.',
    );
  }
  return host;
}

export type Args = {
  pathParams?: Record<string, string | number>;
  query?: Record<string, string | number | boolean | (string | number)[]>;
  body?: unknown;
};

/** The operation's path with its parameters, each encoded as one segment. */
export function pathOf(op: Operation, pathParams: Args['pathParams'] = {}): string {
  const declared = new Set(op.params.filter((p) => p.in === 'path').map((p) => p.name));
  for (const name of Object.keys(pathParams)) {
    if (!declared.has(name))
      throw new JiraError(
        'invalid_arguments',
        `${op.id} has no path parameter ${name}`,
        `Its path is ${op.path}. Describe the operation to see its parameters.`,
      );
  }
  return op.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = pathParams[name];
    if (value === undefined || value === '')
      throw new JiraError(
        'invalid_arguments',
        `${op.id} needs the path parameter ${name}`,
        `Its path is ${op.path}.`,
      );
    // One segment: a value cannot climb to another endpoint with ../ or add a query.
    return encodeURIComponent(String(value));
  });
}

function queryOf(op: Operation, query: Args['query'] = {}): string {
  const declared = new Set(op.params.filter((p) => p.in === 'query').map((p) => p.name));
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (!declared.has(name))
      throw new JiraError(
        'invalid_arguments',
        `${op.id} has no query parameter ${name}`,
        'Describe the operation to see its parameters.',
      );
    for (const item of Array.isArray(value) ? value : [value]) search.append(name, String(item));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

const MAX_RETRIES = 2;

export class JiraClient {
  private readonly cloudIds = new Map<string, string>();

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private async send(url: string, credentials: Credentials, init: RequestInit = {}) {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          ...init,
          headers: {
            accept: 'application/json',
            authorization: credentials.authorization,
            'user-agent': `jira-cloud-admin-mcp/${VERSION}`,
            ...(init.body !== undefined && { 'content-type': 'application/json' }),
          },
          // Never followed: a redirect would carry the credentials to wherever it points. Jira
          // answers a long change, such as publishing a workflow scheme draft, with 303 and its task.
          redirect: 'manual',
          signal: AbortSignal.timeout(60_000),
        });
      } catch (error) {
        throw new JiraError(
          'network',
          `Could not reach ${new URL(url).host}: ${(error as Error).message}`,
          'Check that this server can reach the site, then try again.',
        );
      }
      if ((response.status === 429 || response.status === 503) && attempt < MAX_RETRIES) {
        const after = Number(response.headers.get('retry-after'));
        const wait = Number.isFinite(after) && after > 0 ? Math.min(after, 10) * 1000 : 1000 * (attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }
      return response;
    }
  }

  /** The site's cloud id, which the Automation API is addressed by. */
  async cloudId(credentials: Credentials): Promise<string> {
    const known = this.cloudIds.get(credentials.site);
    if (known) return known;
    const response = await this.send(`https://${credentials.site}/_edge/tenant_info`, credentials);
    const body = (await response.json().catch(() => ({}))) as { cloudId?: unknown };
    if (!response.ok || typeof body.cloudId !== 'string' || !/^[0-9a-f-]{36}$/.test(body.cloudId)) {
      throw new JiraError(
        'not_found',
        `${credentials.site} did not say its cloud id`,
        'Check the site name: it is the host you open Jira at.',
        response.status,
      );
    }
    this.cloudIds.set(credentials.site, body.cloudId);
    return body.cloudId;
  }

  async call(op: Operation, credentials: Credentials, args: Args = {}): Promise<unknown> {
    if (op.body?.required && args.body === undefined)
      throw new JiraError(
        'invalid_arguments',
        `${op.id} needs a body`,
        'Describe the operation to see the body it takes.',
      );
    const path = pathOf(op, args.pathParams) + queryOf(op, args.query);
    const base =
      op.api === 'automation'
        ? `https://api.atlassian.com/automation/public/jira/${await this.cloudId(credentials)}`
        : `https://${credentials.site}`;
    const response = await this.send(base + path, credentials, {
      method: op.method,
      ...(args.body !== undefined && op.method !== 'GET' && { body: JSON.stringify(args.body) }),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location') ?? '';
      const taskId = /\/task\/(\d+)/.exec(location)?.[1];
      return {
        accepted: true,
        status: response.status,
        ...(taskId
          ? { taskId, next: `Jira runs it as a task: follow it with read_jira_admin getTask { taskId: "${taskId}" }.` }
          : { location }),
      };
    }
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON: kept as the text it is.
    }
    if (response.ok) return body ?? { done: true, status: response.status };
    throw failure(op, response.status, body);
  }
}

/** What Jira said went wrong, in its own words, with the next step for the agent. */
function failure(op: Operation, status: number, body: unknown): JiraError {
  const said = jiraMessages(body) || `Jira answered ${status}`;
  switch (status) {
    case 400:
      return new JiraError('rejected', said, 'Describe the operation and fix the arguments.', status);
    case 401:
      return new JiraError(
        'auth_failed',
        said,
        'The email and API token were not accepted. Check them, and that the token has not expired.',
        status,
      );
    case 403:
      return new JiraError(
        'forbidden',
        said,
        `The account may not ${op.reads ? 'see' : 'change'} this. Most of these operations need a Jira administrator.`,
        status,
      );
    case 404:
      return new JiraError('not_found', said, 'Check the ids: find them with a read first.', status);
    case 409:
      return new JiraError('conflict', said, 'Read the current state, then try again.', status);
    case 429:
      return new JiraError('rate_limited', said, 'Jira limits the rate of calls. Wait, then try again.', status);
    default:
      return status >= 500
        ? new JiraError('jira_unavailable', said, 'Jira had a problem. Try again later.', status)
        : new JiraError('rejected', said, 'Describe the operation and check the arguments.', status);
  }
}

function jiraMessages(body: unknown): string {
  if (typeof body === 'string') return body.slice(0, 1000);
  if (!body || typeof body !== 'object') return '';
  const record = body as { errorMessages?: unknown; errors?: unknown; message?: unknown };
  const parts: string[] = [];
  if (Array.isArray(record.errorMessages)) parts.push(...record.errorMessages.map(String));
  if (record.errors && typeof record.errors === 'object' && !Array.isArray(record.errors)) {
    for (const [field, text] of Object.entries(record.errors)) parts.push(`${field}: ${String(text)}`);
  }
  if (Array.isArray(record.errors)) {
    for (const item of record.errors as { title?: unknown; detail?: unknown }[])
      parts.push([item.title, item.detail].filter(Boolean).map(String).join(': '));
  }
  if (typeof record.message === 'string') parts.push(record.message);
  return parts.join('; ').slice(0, 1000);
}
