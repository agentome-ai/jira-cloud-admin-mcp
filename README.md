# jira-cloud-admin-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent administer Jira Cloud:
projects, issue types, custom fields and their contexts, screens, workflows and workflow schemes,
permission and notification schemes, groups, and **Automation rules**.

It covers every administration operation of Atlassian's own API, 468 of them, read from
Atlassian's OpenAPI specifications, so it follows the API as Atlassian changes it. Changes go
through **one tool per area**, so your MCP client can let an agent edit fields freely while
every permission change waits for you.

Built by [Agentome](https://agentome.ai), where it runs a Jira admin agent whose every change
goes through approval.

## Tools

| Tool | What it does |
| --- | --- |
| `jira_admin_status` | The site, whose account the tools act as, whether it administers Jira, which change tools are on |
| `find_admin_operations` | Finds operations by words, such as `custom field context` or `rule state` |
| `describe_admin_operation` | An operation's parameters and JSON body, with the schema resolved |
| `read_jira_admin` | Calls any operation that only reads: a GET, or a search or check sent as POST |
| `change_projects` | Projects, categories, components, versions, roles, the schemes a project uses |
| `change_issue_types` | Issue types, issue type schemes, issue type screen schemes |
| `change_fields` | Custom fields, contexts, options, field configurations and schemes |
| `change_screens` | Screens, tabs, tab fields, screen schemes |
| `change_workflows` | Workflows, statuses, transition rules, workflow schemes and drafts |
| `change_permissions` | Permission schemes and grants, issue security schemes and levels |
| `change_notifications` | Notification schemes |
| `change_priorities` | Priorities, priority schemes, resolutions |
| `change_people` | Groups and members, users, application roles |
| `change_filters` | Filters, their sharing, dashboards |
| `change_settings` | Jira settings, announcement banner, time tracking, link types, webhooks |
| `change_automation` | Automation rules: create, update, enable, disable, delete, scope, templates, manual rules |

An agent works in four steps: find the operation, describe it, read the current state, then change
it with the tool the operation names, saying why in `reason`. Each change tool refuses
operations of other areas, and `read_jira_admin` refuses anything that changes Jira.

Every failure comes back as a result the agent can act on: a `kind` (`auth_failed`, `forbidden`,
`not_found`, `rejected`, `rate_limited`, ...), Jira's own message, a `hint` and `retryable`.
Long answers are cut with a note on how to ask for less.

## Quick start

You need a Jira Cloud site, an account that administers it, and an
[API token](https://id.atlassian.com/manage-profile/security/api-tokens) of that account.

**Claude Code**

```bash
claude mcp add jira-admin \
  -e JIRA_SITE=acme.atlassian.net -e JIRA_EMAIL=you@acme.com -e JIRA_API_TOKEN=... \
  -- npx -y jira-cloud-admin-mcp
```

**Codex**

```bash
codex mcp add jira-admin \
  --env JIRA_SITE=acme.atlassian.net --env JIRA_EMAIL=you@acme.com --env JIRA_API_TOKEN=... \
  -- npx -y jira-cloud-admin-mcp
```

**Any MCP client**

```json
{
  "mcpServers": {
    "jira-admin": {
      "command": "npx",
      "args": ["-y", "jira-cloud-admin-mcp"],
      "env": {
        "JIRA_SITE": "acme.atlassian.net",
        "JIRA_EMAIL": "you@acme.com",
        "JIRA_API_TOKEN": "<API token>"
      }
    }
  }
}
```

Start on a test site. The changes are live at once.

## Shared over HTTP

For a gateway that many people's agents go through, run it over HTTP. It keeps no credentials:
each request brings its own.

```bash
npx -y jira-cloud-admin-mcp --http --host 0.0.0.0 --port 8080
```

- The endpoint is `POST /mcp?site=acme.atlassian.net`, stateless streamable HTTP. `GET /health`
  answers `{"status":"ok"}`.
- Each request sends `Authorization: Basic <base64 of email:api-token>`, which goes to Jira as is.
- `JIRA_SITE` sets the site for requests that name none. `JIRA_ALLOWED_SITES` limits the sites
  requests may name.
- It calls only `<site>.atlassian.net` and `api.atlassian.com`, and follows no redirect.

Put it behind your own TLS, on a network only your gateway reaches.

## In Agentome

[Agentome](https://agentome.ai) runs AI agents as employees of a company, on the company's own
servers, with grants, budgets and approvals. To give an agent Jira administration:

1. Run this server over HTTP next to Agentome.
2. In **Library**, select **Add an MCP server**:
   - **Name**: `jira-admin`.
   - **Address**: `http://<host>:8080/mcp?site=acme.atlassian.net`.
   - **Sign-in**: a token, typed whole as `Basic <base64 of email:api-token>`. It stays encrypted
     on the Agentome server and never reaches a person's computer.
3. Add the skills in [`skills/`](skills) to the Library: **Upload a skill folder** and pick each
   one's folder.
4. Create the agent, give it the server and the skills, and set the policies in **Tools &
   policies**:
   - the read tools: **Allow**;
   - each `change_*` tool: **Ask**, or **Allow** for areas you trust it with.

Each change the agent makes then waits in **Approvals** with its operation, its body and the
agent's reason, and the run's transcript keeps what it read and changed.

## Skills

Three [agent skills](skills) come with the package. Give them to the agent with the server:

- `jira-cloud-admin`: how to work: status, find, describe, read, change, check; company- and
  team-managed projects; recipes for fields, workflows and permissions.
- `jira-automation-rules`: Automation rules: build on an existing rule's JSON, start disabled,
  scope by project ARIs.
- `jira-change-safety`: the way back for every change, what never to change without a person,
  and how to report.

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `JIRA_SITE` | | The site, such as `acme.atlassian.net`. Needed over stdio |
| `JIRA_EMAIL`, `JIRA_API_TOKEN` | | The account over stdio. Over HTTP each request sends its own |
| `JIRA_ADMIN_AREAS` | `all` | Change tools to offer: `all`, `none` (read only), or a list such as `fields,screens,automation` |
| `JIRA_ALLOWED_SITES` | | HTTP: the only sites requests may name |
| `JIRA_ADMIN_MAX_RESULT_CHARS` | `50000` | Longest result before it is cut |
| `JIRA_OPENAPI_DIR` | | A folder with `jira.json` and `automation.json`, for a server that cannot reach `dac-static.atlassian.com` |

The server fetches Atlassian's specifications from `dac-static.atlassian.com` on first use and
keeps them for a day in `~/.cache/jira-cloud-admin-mcp`.

## Security

- **Your account, your rights.** The tools act as the account whose token they get, with its
  rights. An agent that should only read gets `JIRA_ADMIN_AREAS=none`, or an account that may
  only read.
- **Fixed hosts.** Requests go to the site's `*.atlassian.net` host and to `api.atlassian.com`
  only. Path parameters are encoded as one segment each, and query parameters are only those the
  operation declares, so an argument cannot reach another endpoint.
- **No stored credentials.** Over HTTP no credential is kept between requests, and none is
  logged.

Report a vulnerability privately: [security advisories](https://github.com/agentome-ai/jira-cloud-admin-mcp/security/advisories/new).

## License

MIT. Jira, Jira Cloud and Atlassian are trademarks of Atlassian; this project is not made or
endorsed by Atlassian.
