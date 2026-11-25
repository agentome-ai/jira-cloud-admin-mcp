import { createServer, type IncomingMessage, type Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AREAS } from './areas.js';
import { type Credentials, JiraClient, JiraError, siteOf } from './jira.js';
import { type Catalog, loadCatalog } from './specs.js';
import { registerTools } from './tools.js';
import { VERSION } from './version.js';

// Two ways to run. Over stdio, for one person's MCP client: the credentials come from the
// environment. Over HTTP, for a shared gateway such as Agentome's: each request brings its own
// (Authorization: Basic, and the site), and the server keeps none.

export type Settings = {
  areas: string[];
  maxChars: number;
  site?: string;
  allowedSites?: string[];
};

export function settingsOf(env: NodeJS.ProcessEnv): Settings {
  const keys = AREAS.map((area) => area.key);
  const wanted = (env.JIRA_ADMIN_AREAS ?? 'all').split(',').map((item) => item.trim()).filter(Boolean);
  const areas = wanted.includes('all') ? keys : wanted.includes('none') ? [] : wanted;
  const unknown = areas.filter((area) => !keys.includes(area));
  if (unknown.length > 0)
    throw new Error(`JIRA_ADMIN_AREAS names no area ${unknown.join(', ')}; the areas are ${keys.join(', ')}`);
  const maxChars = Number(env.JIRA_ADMIN_MAX_RESULT_CHARS ?? 50_000);
  if (!Number.isInteger(maxChars) || maxChars < 1_000)
    throw new Error('JIRA_ADMIN_MAX_RESULT_CHARS is a whole number of at least 1000');
  return {
    areas,
    maxChars,
    ...(env.JIRA_SITE && { site: siteOf(env.JIRA_SITE) }),
    ...(env.JIRA_ALLOWED_SITES && {
      allowedSites: env.JIRA_ALLOWED_SITES.split(',').map((site) => siteOf(site)),
    }),
  };
}

function newServer(settings: Settings, catalog: () => Promise<Catalog>, client: JiraClient, credentials: () => Credentials) {
  const server = new McpServer({ name: 'jira-cloud-admin', version: VERSION });
  registerTools(server, { catalog, client, credentials, areas: settings.areas, maxChars: settings.maxChars });
  return server;
}

/** The catalog, read once and shared by every request. */
function catalogOnce(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch) {
  let loading: Promise<Catalog> | undefined;
  return () => {
    loading ??= loadCatalog(env, fetchImpl).catch((error: unknown) => {
      // Tried again on the next call: Atlassian may be back.
      loading = undefined;
      throw error;
    });
    return loading;
  };
}

export async function runStdio(env: NodeJS.ProcessEnv): Promise<void> {
  const settings = settingsOf(env);
  const { JIRA_EMAIL: email, JIRA_API_TOKEN: token } = env;
  if (!settings.site || !email || !token)
    throw new Error('Set JIRA_SITE (acme.atlassian.net), JIRA_EMAIL and JIRA_API_TOKEN');
  const credentials: Credentials = {
    site: settings.site,
    authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
  };
  const server = newServer(settings, catalogOnce(env, fetch), new JiraClient(), () => credentials);
  await server.connect(new StdioServerTransport());
}

/** The credentials a request brings: its Basic authorization, and its site or the default one. */
export function requestCredentials(request: IncomingMessage, settings: Settings): Credentials {
  const authorization = request.headers.authorization ?? '';
  if (!/^Basic [A-Za-z0-9+/]+={0,2}$/.test(authorization))
    throw new JiraError(
      'auth_failed',
      'Send Authorization: Basic with an Atlassian account email and API token',
      'Base64 of email:token, as Jira takes it.',
    );
  const url = new URL(request.url ?? '/', 'http://localhost');
  const asked = url.searchParams.get('site') ?? request.headers['x-jira-site'];
  const site = typeof asked === 'string' ? siteOf(asked) : settings.site;
  if (!site)
    throw new JiraError('invalid_arguments', 'Name the Jira site', 'Add ?site=acme.atlassian.net to the address.');
  if (settings.allowedSites && !settings.allowedSites.includes(site))
    throw new JiraError('forbidden', `${site} is not a site this server serves`, 'Ask its administrator.');
  return { site, authorization };
}

export function httpServer(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): Server {
  const settings = settingsOf(env);
  const catalog = catalogOnce(env, fetchImpl);
  const client = new JiraClient(fetchImpl);
  return createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    if (path === '/health') return reply(200, { status: 'ok', version: VERSION });
    if (path !== '/mcp') return reply(404, { error: 'Not found: the MCP endpoint is /mcp' });
    // Stateless: no sessions to resume or stream, so only POST.
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      return reply(405, { error: 'POST only' });
    }
    let credentials: Credentials;
    try {
      credentials = requestCredentials(request, settings);
    } catch (error) {
      const known = error as JiraError;
      return reply(known.kind === 'forbidden' ? 403 : known.kind === 'auth_failed' ? 401 : 400, {
        error: known.message,
        hint: known.hint,
      });
    }
    const server = newServer(settings, catalog, client, () => credentials);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on('close', () => {
      void transport.close();
      void server.close();
    });
    server
      .connect(transport)
      .then(() => transport.handleRequest(request, response))
      .catch((error: unknown) => {
        process.stderr.write(`jira-cloud-admin-mcp: ${(error as Error).message}\n`);
        if (!response.headersSent) reply(500, { error: 'The request failed' });
      });
  });
}
