#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { AREAS } from './areas.js';
import { httpServer, runStdio } from './server.js';
import { VERSION } from './version.js';

const HELP = `jira-cloud-admin-mcp ${VERSION}: an MCP server for Jira Cloud administration.

Over stdio, for one person's MCP client:
  JIRA_SITE=acme.atlassian.net JIRA_EMAIL=you@acme.com JIRA_API_TOKEN=... jira-cloud-admin-mcp

Over HTTP, for a shared gateway (each request sends Authorization: Basic and ?site=):
  jira-cloud-admin-mcp --http [--host 127.0.0.1] [--port 8080]

Settings:
  JIRA_ADMIN_AREAS             change tools to offer: all (default), none, or a list of
                               ${AREAS.map((area) => area.key).join(', ')}
  JIRA_ALLOWED_SITES           HTTP: the only sites requests may name, comma-separated
  JIRA_ADMIN_MAX_RESULT_CHARS  longest result before it is cut (default 50000)
  JIRA_OPENAPI_DIR             a folder with jira.json and automation.json, instead of fetching
                               Atlassian's specifications
`;

async function main() {
  const { values } = parseArgs({
    options: {
      http: { type: 'boolean' },
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: process.env.PORT ?? '8080' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (values.help) return void process.stdout.write(HELP);
  if (values.version) return void process.stdout.write(`${VERSION}\n`);
  if (!values.http) return runStdio(process.env);
  const port = Number(values.port);
  httpServer(process.env).listen(port, values.host, () => {
    process.stderr.write(`jira-cloud-admin-mcp ${VERSION} on http://${values.host}:${port}/mcp\n`);
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`jira-cloud-admin-mcp: ${(error as Error).message}\n`);
  process.exit(1);
});
