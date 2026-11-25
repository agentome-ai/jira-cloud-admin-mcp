import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { AREAS } from '../src/areas.js';
import { JiraClient } from '../src/jira.js';
import { httpServer } from '../src/server.js';
import { loadCatalog } from '../src/specs.js';
import { registerTools } from '../src/tools.js';

const env = { JIRA_OPENAPI_DIR: fileURLToPath(new URL('fixtures/specs', import.meta.url)) };
const credentials = { site: 'acme.atlassian.net', authorization: 'Basic YW5uQGFjbWUuY29tOnRva2Vu' };
const CLOUD_ID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';

type Seen = { method: string; url: string; authorization: string | null; body?: unknown; redirect?: string };

/** A Jira Cloud site and Atlassian's API gateway, as far as the tests need them. */
function fakeJira(answers: Record<string, (seen: Seen) => Response> = {}) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const call: Seen = {
      method: init.method ?? 'GET',
      url: String(input),
      authorization: headers.get('authorization'),
      redirect: init.redirect,
      ...(init.body !== undefined && { body: JSON.parse(String(init.body)) }),
    };
    seen.push(call);
    const key = `${call.method} ${call.url}`;
    const answer = answers[key];
    if (answer) return answer(call);
    if (key === 'GET https://acme.atlassian.net/_edge/tenant_info') return Response.json({ cloudId: CLOUD_ID });
    if (key === 'GET https://acme.atlassian.net/rest/api/3/myself')
      return Response.json({ accountId: 'a1', displayName: 'Ann', emailAddress: 'ann@acme.com' });
    if (key.startsWith('GET https://acme.atlassian.net/rest/api/3/mypermissions'))
      return Response.json({ permissions: { ADMINISTER: { havePermission: true } } });
    return Response.json({ echo: call }, { status: 200 });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

async function connect(fetchImpl: typeof fetch, areas = AREAS.map((area) => area.key), maxChars = 50_000) {
  const server = new McpServer({ name: 'test', version: '0' });
  registerTools(server, {
    catalog: () => loadCatalog(env, fetchImpl),
    client: new JiraClient(fetchImpl),
    credentials: () => credentials,
    areas,
    maxChars,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    const text = result.content[0]?.text ?? '';
    return { isError: result.isError === true, text, json: () => JSON.parse(text) as Record<string, any> };
  };
  return { client, call };
}

describe('the catalog', () => {
  it('takes administration operations only, each in its area, and tells reads from changes', async () => {
    const catalog = await loadCatalog(env, fakeJira().fetchImpl);
    expect([...catalog.operations.keys()].sort()).toEqual([
      'automation.getFields',
      'createCustomField',
      'createPermissionGrant',
      'getCurrentUser',
      'getFields',
      'getGroup',
      'getMyPermissions',
      'searchAndReconsileIssuesUsingJqlPost',
      'searchRuleSummaries',
      'updateRuleScope',
      'updateRuleState',
    ]);
    const op = (id: string) => catalog.operations.get(id);
    expect(op('createCustomField')).toMatchObject({ area: 'fields', reads: false, method: 'POST' });
    expect(op('searchAndReconsileIssuesUsingJqlPost')).toMatchObject({ area: 'settings', reads: true });
    expect(op('updateRuleState')).toMatchObject({ area: 'automation', api: 'automation', reads: false });
    expect(op('searchRuleSummaries')?.reads).toBe(true);
    // A path parameter declared on the path, not the operation, is still the operation's.
    expect(op('createPermissionGrant')?.params.map((p) => p.name)).toEqual(['schemeId', 'expand']);
  });
});

describe('the tools', () => {
  it('are a status, find, describe and read, and one change tool per area that is on', async () => {
    const { client } = await connect(fakeJira().fetchImpl, ['fields', 'automation']);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'jira_admin_status',
      'find_admin_operations',
      'describe_admin_operation',
      'read_jira_admin',
      'change_fields',
      'change_automation',
    ]);
    const change = tools.find((tool) => tool.name === 'change_fields');
    expect(change?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tools.find((tool) => tool.name === 'read_jira_admin')?.annotations?.readOnlyHint).toBe(true);
  });

  it('say whose account they act as and whether it administers Jira', async () => {
    const { call } = await connect(fakeJira().fetchImpl);
    const status = (await call('jira_admin_status')).json();
    expect(status).toMatchObject({
      site: 'acme.atlassian.net',
      account: { accountId: 'a1', displayName: 'Ann' },
      jiraAdministrator: true,
      cloudId: CLOUD_ID,
    });
  });

  it('find operations by words, and describe one with its body schema resolved', async () => {
    const { call } = await connect(fakeJira().fetchImpl);
    const found = (await call('find_admin_operations', { query: 'custom field' })).json();
    expect(found.found).toEqual([
      expect.objectContaining({ operation: 'createCustomField', tool: 'change_fields', area: 'fields' }),
    ]);
    const described = (await call('describe_admin_operation', { operation: 'createCustomField' })).json();
    expect(described.body.schema.properties.context.properties.name.type).toBe('string');
    expect((await call('describe_admin_operation', { operation: 'deleteIssue' })).isError).toBe(true);
    // A reference deep into another schema, as the Automation spec writes some.
    const scope = (await call('describe_admin_operation', { operation: 'updateRuleScope' })).json();
    expect(scope.body.schema.properties.ruleScopeARIs.items).toEqual({ type: 'string', title: 'ARI' });
  });

  it('read with the credentials of the call, and refuse to change through read', async () => {
    const jira = fakeJira();
    const { call } = await connect(jira.fetchImpl);
    const read = await call('read_jira_admin', { operation: 'getFields' });
    expect(read.isError).toBe(false);
    const last = jira.seen.at(-1);
    expect(last).toMatchObject({
      method: 'GET',
      url: 'https://acme.atlassian.net/rest/api/3/field',
      authorization: credentials.authorization,
      redirect: 'manual',
    });
    const refused = await call('read_jira_admin', { operation: 'createCustomField', body: { name: 'x' } });
    expect(refused.json().error).toMatchObject({ kind: 'invalid_arguments', hint: 'Call it with change_fields.' });
    expect(jira.seen.some((seen) => seen.method === 'POST')).toBe(false);
  });

  it('change only through the tool of the operation’s area, with path parameters kept in their segment', async () => {
    const jira = fakeJira();
    const { call } = await connect(jira.fetchImpl);
    const wrong = await call('change_fields', {
      operation: 'createPermissionGrant',
      pathParams: { schemeId: '10000' },
      body: {},
      reason: 'test',
    });
    expect(wrong.json().error.hint).toBe('Call it with change_permissions.');
    await call('change_permissions', {
      operation: 'createPermissionGrant',
      pathParams: { schemeId: '../../../admin?x=1' },
      query: { expand: 'all' },
      body: { holder: { type: 'group', parameter: 'jira-admins' }, permission: 'ADMINISTER_PROJECTS' },
      reason: 'Admins of the group manage projects',
    });
    expect(jira.seen.at(-1)).toMatchObject({
      method: 'POST',
      url: 'https://acme.atlassian.net/rest/api/3/permissionscheme/..%2F..%2F..%2Fadmin%3Fx%3D1/permission?expand=all',
      body: { permission: 'ADMINISTER_PROJECTS' },
    });
    const stray = await call('change_permissions', {
      operation: 'createPermissionGrant',
      pathParams: { schemeId: '1', other: '2' },
      body: {},
      reason: 'test',
    });
    expect(stray.json().error.message).toBe('createPermissionGrant has no path parameter other');
    const query = await call('change_permissions', {
      operation: 'createPermissionGrant',
      pathParams: { schemeId: '1' },
      query: { jql: 'x' },
      body: {},
      reason: 'test',
    });
    expect(query.json().error.message).toBe('createPermissionGrant has no query parameter jql');
  });

  it('refuse a path parameter of dots, which the URL parser would resolve to another endpoint', async () => {
    const jira = fakeJira();
    const { call } = await connect(jira.fetchImpl);
    for (const schemeId of ['..', '.', '...']) {
      const refused = await call('change_permissions', {
        operation: 'createPermissionGrant',
        pathParams: { schemeId },
        body: {},
        reason: 'test',
      });
      expect(refused.json().error).toMatchObject({ kind: 'invalid_arguments' });
    }
    expect(jira.seen).toHaveLength(0);
  });

  it('change Automation rules at the gateway, by the site’s cloud id, asked once', async () => {
    const jira = fakeJira();
    const { call } = await connect(jira.fetchImpl);
    for (const value of ['DISABLED', 'ENABLED']) {
      await call('change_automation', {
        operation: 'updateRuleState',
        pathParams: { ruleUuid: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' },
        body: { value },
        reason: 'Pause the rule while the field is renamed',
      });
    }
    expect(jira.seen.map((seen) => `${seen.method} ${seen.url}`)).toEqual([
      'GET https://acme.atlassian.net/_edge/tenant_info',
      `PUT https://api.atlassian.com/automation/public/jira/${CLOUD_ID}/rest/v1/rule/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/state`,
      `PUT https://api.atlassian.com/automation/public/jira/${CLOUD_ID}/rest/v1/rule/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/state`,
    ]);
  });

  it("pass on Jira's own words with the next step, and cut a long answer", async () => {
    const jira = fakeJira({
      'GET https://acme.atlassian.net/rest/api/3/field': () =>
        Response.json({ errorMessages: ['You are not an administrator.'] }, { status: 403 }),
    });
    const { call } = await connect(jira.fetchImpl);
    const refused = await call('read_jira_admin', { operation: 'getFields' });
    expect(refused.isError).toBe(true);
    expect(refused.json().error).toMatchObject({
      kind: 'forbidden',
      message: 'You are not an administrator.',
      retryable: false,
      status: 403,
    });

    const long = fakeJira({
      'GET https://acme.atlassian.net/rest/api/3/field': () => Response.json(Array(500).fill({ id: 'customfield_10000' })),
    });
    const short = await connect(long.fetchImpl, [], 1_000);
    const cut = await short.call('read_jira_admin', { operation: 'getFields' });
    expect(cut.text).toMatch(/^\[truncated: \d+ characters, the first 1000 shown/);
  });

  it('follow no redirect, and pass on the task a long change runs as', async () => {
    const jira = fakeJira({
      'POST https://acme.atlassian.net/rest/api/3/field': () =>
        new Response(null, { status: 303, headers: { location: 'https://acme.atlassian.net/rest/api/3/task/10042' } }),
    });
    const { call } = await connect(jira.fetchImpl);
    const started = await call('change_fields', {
      operation: 'createCustomField',
      body: { name: 'Risk', type: 'com.atlassian.jira.plugin.system.customfieldtypes:select' },
      reason: 'test',
    });
    expect(started.json()).toMatchObject({ accepted: true, status: 303, taskId: '10042' });
    expect(jira.seen).toHaveLength(1);
  });

  it('wait and try again when Jira limits the rate', async () => {
    let calls = 0;
    const jira = fakeJira({
      'GET https://acme.atlassian.net/rest/api/3/field': () =>
        ++calls === 1 ? new Response('{}', { status: 429, headers: { 'retry-after': '0' } }) : Response.json([]),
    });
    const { call } = await connect(jira.fetchImpl);
    expect((await call('read_jira_admin', { operation: 'getFields' })).isError).toBe(false);
    expect(calls).toBe(2);
  });
});

describe('over HTTP', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  async function serve(extra: Record<string, string> = {}) {
    const jira = fakeJira();
    const server = httpServer({ ...env, ...extra }, jira.fetchImpl);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    close = () => server.close();
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { jira, base };
  }

  it("acts with each request's own credentials on the site it names", async () => {
    const { jira, base } = await serve();
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp?site=acme.atlassian.net`), {
        requestInit: { headers: { authorization: credentials.authorization } },
      }),
    );
    await client.callTool({ name: 'read_jira_admin', arguments: { operation: 'getFields' } });
    expect(jira.seen.at(-1)).toMatchObject({
      url: 'https://acme.atlassian.net/rest/api/3/field',
      authorization: credentials.authorization,
    });
    await client.close();
  });

  it('refuses a request without Basic credentials, a site that is not Jira Cloud, and one not allowed', async () => {
    const { base } = await serve({ JIRA_ALLOWED_SITES: 'acme.atlassian.net' });
    const post = (url: string, authorization?: string) =>
      fetch(`${base}${url}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(authorization && { authorization }),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
    expect((await post('/mcp?site=acme.atlassian.net')).status).toBe(401);
    expect((await post('/mcp?site=acme.atlassian.net', 'Bearer x')).status).toBe(401);
    expect((await post('/mcp?site=evil.example.com', credentials.authorization)).status).toBe(400);
    expect((await post('/mcp?site=acme.atlassian.net.evil.com', credentials.authorization)).status).toBe(400);
    expect((await post('/mcp?site=other.atlassian.net', credentials.authorization)).status).toBe(403);
    expect((await post('/mcp', credentials.authorization)).status).toBe(400);
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ status: 'ok' });
  });
});
