import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AREAS } from './areas.js';
import { type Credentials, type JiraClient, JiraError } from './jira.js';
import { type Catalog, findOperations, type Operation } from './specs.js';

// The tools. One reads anything in every area; each area has a change tool of its own, so that an
// MCP client's approval policy can tell a new custom field from a new permission grant. Every
// operation of Atlassian's API in these areas is reachable: find it, describe it, call it.

export type Context = {
  catalog: () => Promise<Catalog>;
  client: JiraClient;
  /** The credentials of the call in hand: from the environment, or from the request (HTTP). */
  credentials: () => Credentials;
  /** The areas whose change tools are on. */
  areas: string[];
  maxChars: number;
};

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };

function answer(value: unknown, maxChars: number): Result {
  const text = JSON.stringify(value, null, 1);
  if (text.length <= maxChars) return { content: [{ type: 'text', text }] };
  return {
    content: [
      {
        type: 'text',
        text:
          `[truncated: ${text.length} characters, the first ${maxChars} shown. Ask for less: a page ` +
          '(startAt, maxResults), a filter, or one item by its id.]\n' +
          text.slice(0, maxChars),
      },
    ],
  };
}

function refusal(error: unknown): Result {
  const known =
    error instanceof JiraError
      ? error
      : new JiraError('jira_unavailable', (error as Error).message, 'Try again; if it persists, check the server log.');
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: {
            kind: known.kind,
            message: known.message,
            hint: known.hint,
            retryable: known.retryable,
            ...(known.status && { status: known.status }),
          },
        }),
      },
    ],
  };
}

async function operation(context: Context, id: string): Promise<Operation> {
  const catalog = await context.catalog();
  const op = catalog.operations.get(id);
  if (!op)
    throw new JiraError(
      'invalid_arguments',
      `There is no administration operation ${id}`,
      'Find it with find_admin_operations; ids are case-sensitive, such as createCustomField.',
    );
  return op;
}

const Call = {
  operation: z.string().min(1).max(200).describe('The operation id, such as getAllWorkflowSchemes'),
  pathParams: z
    .record(z.string(), z.union([z.string(), z.number()]))
    .optional()
    .describe('Values of the path parameters, such as { "id": "10001" }'),
  query: z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]),
    )
    .optional()
    .describe('Query parameters, such as { "startAt": 0, "maxResults": 50 }'),
};

const summaryOf = (id: string, op: Operation) => ({
  operation: id,
  method: op.method,
  path: op.path,
  area: op.area,
  summary: op.summary,
  tool: op.reads ? 'read_jira_admin' : `change_${op.area}`,
  ...(op.deprecated && { deprecated: true }),
});

export function registerTools(server: McpServer, context: Context): void {
  const areaKeys = AREAS.map((area) => area.key) as [string, ...string[]];

  server.registerTool(
    'jira_admin_status',
    {
      title: 'Jira admin status',
      description:
        'Checks the connection: the site, whose account the tools act as, whether it is a Jira administrator, and which change tools are on. Call it first, and when calls fail with auth_failed or forbidden.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const credentials = context.credentials();
        const catalog = await context.catalog();
        const myself = await context.client.call(await operation(context, 'getCurrentUser'), credentials);
        const permissions = (await context.client.call(
          await operation(context, 'getMyPermissions'),
          credentials,
          { query: { permissions: 'ADMINISTER' } },
        )) as { permissions?: { ADMINISTER?: { havePermission?: boolean } } };
        const me = myself as { accountId?: string; displayName?: string; emailAddress?: string };
        return answer(
          {
            site: credentials.site,
            account: { accountId: me.accountId, displayName: me.displayName, email: me.emailAddress },
            jiraAdministrator: permissions.permissions?.ADMINISTER?.havePermission === true,
            cloudId: await context.client.cloudId(credentials),
            operations: catalog.operations.size,
            specifications: catalog.versions,
            changeTools: context.areas.map((area) => `change_${area}`),
          },
          context.maxChars,
        );
      } catch (error) {
        return refusal(error);
      }
    },
  );

  server.registerTool(
    'find_admin_operations',
    {
      title: 'Find admin operations',
      description:
        "Finds operations of Jira Cloud's administration API and the Automation API by words, such as 'custom field context' or 'workflow scheme draft publish'. Returns each one's id, method, path, area and the tool that calls it. Describe one before calling it.",
      inputSchema: {
        query: z.string().min(1).max(200).describe('Words the operation id, summary or path holds'),
        area: z.enum(areaKeys).optional().describe('Only this area'),
        limit: z.number().int().min(1).max(50).optional().describe('At most this many, 15 by default'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, area, limit }) => {
      try {
        const catalog = await context.catalog();
        const found = findOperations(catalog, query, area, limit ?? 15);
        return answer(
          {
            found: found.map(({ id, op }) => summaryOf(id, op)),
            ...(found.length === 0 && {
              hint: 'Nothing holds every word. Try fewer or other words, or no area.',
            }),
          },
          context.maxChars,
        );
      } catch (error) {
        return refusal(error);
      }
    },
  );

  server.registerTool(
    'describe_admin_operation',
    {
      title: 'Describe an admin operation',
      description:
        "Shows what an operation does and what it takes: its path and query parameters and the JSON body, with the body's schema resolved. Read this before calling an operation for the first time.",
      inputSchema: { operation: Call.operation },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ operation: id }) => {
      try {
        const catalog = await context.catalog();
        const op = await operation(context, id);
        return answer(
          {
            ...summaryOf(id, op),
            description: op.description.slice(0, 3000),
            parameters: op.params.map((p) => ({
              name: p.name,
              in: p.in,
              required: p.required,
              description: p.description,
              schema: catalog.expand(op, p.schema, 1),
            })),
            ...(op.body && {
              body: { required: op.body.required, schema: catalog.expand(op, op.body.schema, 3) },
            }),
          },
          context.maxChars,
        );
      } catch (error) {
        return refusal(error);
      }
    },
  );

  server.registerTool(
    'read_jira_admin',
    {
      title: 'Read Jira configuration',
      description:
        'Calls an operation that only reads, in any area: a GET, or a search or check sent as POST. Changes nothing. Use paging (startAt, maxResults) for long lists.',
      inputSchema: {
        ...Call,
        body: z.unknown().optional().describe('The JSON body of a search or check sent as POST'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ operation: id, pathParams, query, body }) => {
      try {
        const op = await operation(context, id);
        if (!op.reads)
          throw new JiraError(
            'invalid_arguments',
            `${id} changes Jira; it is not a read`,
            `Call it with change_${op.area}.`,
          );
        const result = await context.client.call(op, context.credentials(), { pathParams, query, body });
        return answer(result, context.maxChars);
      } catch (error) {
        return refusal(error);
      }
    },
  );

  for (const area of AREAS.filter((each) => context.areas.includes(each.key))) {
    server.registerTool(
      `change_${area.key}`,
      {
        title: `Change ${area.key.replace('_', ' ')}`,
        description:
          `Calls an operation that changes Jira: ${area.about}. The change is live at once. ` +
          'Read the current state first, describe the operation, and say why in reason.',
        inputSchema: {
          ...Call,
          body: z.unknown().optional().describe('The JSON body the operation takes'),
          reason: z
            .string()
            .min(1)
            .max(500)
            .describe('Why this change, in a sentence, for whoever approves or audits it'),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      async ({ operation: id, pathParams, query, body }) => {
        try {
          const op = await operation(context, id);
          if (op.area !== area.key)
            throw new JiraError(
              'invalid_arguments',
              `${id} is in ${op.area}, not ${area.key}`,
              op.reads ? 'It only reads: call it with read_jira_admin.' : `Call it with change_${op.area}.`,
            );
          if (op.reads)
            throw new JiraError('invalid_arguments', `${id} only reads`, 'Call it with read_jira_admin.');
          const result = await context.client.call(op, context.credentials(), { pathParams, query, body });
          return answer(result, context.maxChars);
        } catch (error) {
          return refusal(error);
        }
      },
    );
  }
}
