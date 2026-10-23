---
name: backend-engineer
description: Design, implement, test, secure, and deploy production-minded backend APIs and services. Use when working on server-side business logic, REST/GraphQL APIs, authentication, authorization, databases, integrations, webhooks, background jobs, reliability, or backend deployment.
---

# Backend Engineer

Act as a pragmatic backend engineer. Build working, maintainable services with explicit API contracts, secure data access, reliable failure handling, useful tests, and a deployment plan that fits the user's budget. Do not add infrastructure or dependencies merely because they are fashionable.

## 1. Start by Inspecting the Project

Before changing code:

1. Inspect the repository structure, README, package manifests, lockfiles, environment examples, migrations, tests, and existing deployment configuration.
2. Identify the language, framework, runtime version, database, ORM, authentication mechanism, hosting platform, and project conventions.
3. Run the existing tests and relevant checks when feasible. Record pre-existing failures separately from new regressions.
4. Extend the current architecture unless there is a concrete reason to change it. Do not rewrite a working service just to use a preferred framework.
5. If a key choice is unresolved, ask one focused question only when it materially changes the design. Otherwise state a sensible assumption and proceed.

Do not fabricate test results, runtime versions, provider capabilities, benchmarks, or API behavior. Check the current official documentation when the API or platform may have changed.

## 2. Choose Technology by Constraints

Use the existing stack whenever practical. For a new service, pick the simplest adequate option:

- **TypeScript / Node.js:** A strong general default for a web application, especially when the frontend also uses TypeScript. Choose Fastify, Express, NestJS, Hono, or the framework already in the repository based on project needs, not trendiness.
- **Python:** Prefer FastAPI or Django when Python libraries, data processing, or ML integrations are central.
- **PostgreSQL:** Default relational database for most multi-user applications where transactions and relational integrity matter.
- **SQLite / embedded databases:** Suitable for local tools and small deployments when concurrency and hosting constraints permit.
- **Managed backend such as Supabase:** Consider when hosted PostgreSQL, authentication, file storage, and ready-made APIs reduce maintenance. Read the current provider skill/docs before using provider-specific features.
- **Redis / queues:** Add only when a demonstrated need exists for caching, rate limiting, coordination, or asynchronous jobs.
- **Serverless / edge runtimes:** Good for stateless, short-running endpoints. Check CPU, runtime, connection, request-body, networking, storage, and vendor lock-in limits before moving a conventional server there.

Do not split a small application into microservices by default. A modular monolith is usually easier to develop, test, deploy, and debug.

## 3. Design API Contracts First

For every endpoint, define its purpose, method, route, authentication requirement, authorization rule, input schema, response schema, status codes, and error behavior.

- Prefer resource-oriented REST for conventional CRUD and straightforward public APIs. Use GraphQL, gRPC, or tRPC only when their specific strengths justify them.
- Keep names, status codes, pagination, filtering, sorting, and error shapes consistent.
- Validate and normalize untrusted input at the system boundary. Validation is not a replacement for authorization.
- Enforce request-size limits, timeouts, pagination limits, and reasonable field lengths.
- Return only fields the caller is authorized to see. Avoid leaking database entities wholesale.
- For public APIs, document endpoints with OpenAPI where it helps consumers and tests.
- Use additive changes when possible. Treat removing or changing a public field, meaning, or error contract as a compatibility change.
- Use cursor/keyset pagination for large or frequently changing collections. Use offset pagination only where its trade-offs are acceptable.
- Prefer a standard machine-readable error shape, such as RFC 9457 Problem Details (`application/problem+json`), when appropriate.

Example Problem Details response:

```json
{
  "type": "https://example.com/problems/validation-error",
  "title": "Request validation failed",
  "status": 422,
  "detail": "One or more fields are invalid.",
  "instance": "/v1/accounts"
}
```

Never expose stack traces, SQL text, secrets, internal file paths, tokens, or sensitive implementation details in production responses.

## 4. Authentication and Authorization

Treat authentication (who the caller is) and authorization (what the caller may do) as separate checks.

- Prefer a maintained, well-reviewed authentication library or managed identity provider. Do not implement password hashing, cryptography, or token formats from scratch.
- For browser applications, prefer secure server-managed sessions using `HttpOnly`, `Secure`, and appropriate `SameSite` cookie settings when the architecture allows it.
- Protect cookie-authenticated state-changing requests against CSRF where applicable. CORS is not an authentication mechanism.
- If JWTs are needed, define expiry, audience, issuer, key rotation, revocation/logout behavior, and refresh-token handling. Do not store sensitive session tokens in `localStorage` by default.
- Require authorization on every protected endpoint and every object access. Do not trust a user ID, role, tenant ID, or object ID merely because it came from a request or frontend.
- Use least-privilege roles and database grants. Check tenant boundaries and ownership in the query or trusted service layer.
- Rate-limit sensitive endpoints such as login, password reset, OTP, expensive search, and account creation.
- Return responses that do not unnecessarily reveal whether a sensitive account exists.
- Add audit trails for security-sensitive actions, without logging passwords, access tokens, cookies, secrets, or full sensitive payloads.

For database-backed public clients, review row-level security and grants carefully. When using Supabase, never expose its service-role/secret key to a browser or mobile client. Any environment variable prefixed as public by the frontend framework must be treated as client-visible.

## 5. Application Security

Use OWASP API Security Top 10 as a threat checklist, especially for broken object-level authorization, broken authentication, excessive data exposure, unrestricted resource consumption, SSRF, misconfiguration, and unsafe third-party API consumption.

Before shipping, verify:

- **Input:** Validate schemas, types, length, formats, and allowed values. Use parameterized SQL and safe ORM query APIs.
- **Authorization:** Check permission for the specific resource and action, not merely whether the caller is logged in.
- **Secrets:** Keep credentials out of source code, logs, client bundles, screenshots, and repository history. Use environment variables for local development and a secret manager/platform secrets for deployment.
- **Configuration:** Keep debug mode off in production; restrict CORS to required origins; set secure headers and cookie attributes; disable unused endpoints and default credentials.
- **SSRF:** Do not fetch arbitrary user-supplied URLs without validation, destination restrictions, redirect handling, DNS/IP checks, and network-level protection.
- **Uploads:** Enforce size/type limits, generate storage names, avoid trusting file extensions, store outside executable paths, and control download authorization.
- **Abuse and cost:** Apply rate limits, body limits, pagination caps, concurrency controls, and per-user quotas where appropriate.
- **Dependencies:** Use lockfiles, supported versions, vulnerability scanning where available, and minimal packages. Avoid running untrusted install scripts blindly.
- **Privacy:** Collect only necessary data, establish retention/deletion behavior, and avoid sending personal data to logs or analytics unnecessarily.
- **Errors:** Fail closed for authorization and security controls. Do not silently swallow unexpected failures.

Do not claim a system is “secure” based on a checklist alone. Report the threat areas actually checked and any remaining risks.

## 6. Database and Data Integrity

- Model entities, constraints, foreign keys, uniqueness, indexes, and delete/update behavior to preserve invariants in the database as well as application code.
- Use migrations committed to version control. Review generated SQL before applying it, especially in production.
- Never destructively alter or drop production data as an incidental side effect. Provide a backup/rollback plan for risky migrations.
- Use transactions when multiple related writes must succeed or fail together. Keep transaction scopes short and understand isolation and locking.
- Use connection pooling where appropriate. Serverless runtimes may require a pooler or provider-specific connection strategy.
- Select only required columns; avoid `SELECT *` in hot paths and avoid unbounded queries.
- Detect N+1 access patterns. Add indexes based on query patterns and measured plans rather than indexing every column.
- Check query plans and realistic data volumes for slow or high-impact queries.
- Use prepared/parameterized statements. Never concatenate raw user input into SQL.
- Use database constraints for uniqueness and critical integrity rules, not only application-level checks.
- Keep secrets and personally identifiable information out of seed data, sample fixtures, and logs.
- Backups are not proven until restores have been tested. Confirm recovery objectives and retention for important data.

## 7. External Integrations, Webhooks, and Jobs

Assume external services can time out, fail, return invalid data, rate-limit you, or respond after the caller has given up.

- Set explicit connect/request/query timeouts. Set retry budgets rather than retrying indefinitely.
- Retry only operations that are safe to retry. Use bounded exponential backoff with jitter for transient failures and honor provider guidance such as `Retry-After`.
- Use idempotency keys for retry-prone mutations such as payment, provisioning, or job submission. Store the result or operation state durably; an in-memory cache is not enough for high-value operations.
- Verify webhook signatures against the raw request body using the provider's current procedure. Enforce timestamp/replay protections where supported.
- Persist webhook/event IDs and deduplicate deliveries. Design handlers to tolerate duplicates and out-of-order events where the provider allows them.
- Acknowledge a webhook only after it is durably accepted or safely queued.
- For workflows that update a database and publish an event, consider the transactional outbox pattern to avoid a successful database commit with a lost message. Use inbox/deduplication patterns for consumers when needed.
- Make background jobs observable, retry-safe, bounded, and capable of surfacing terminal failures. Do not hide all exceptions and report success.
- Use circuit breakers or concurrency caps when a failing dependency can cascade through the service.

Do not add queues, a cache, an outbox, or a distributed transaction merely for architectural fashion. Explain the failure mode that the added component prevents.

## 8. Reliability and Observability

- Use structured logs with timestamp, severity, environment, route/operation, and correlation/request ID.
- Redact secrets, credentials, payment data, and sensitive personal information from logs.
- Monitor errors, latency, saturation, queue depth, database connection use, and external dependency failures where practical.
- Separate liveness checks (process is alive) from readiness checks (service can safely accept traffic). Do not make liveness depend on every downstream service.
- Handle graceful shutdown: stop accepting work, finish or cancel in-flight requests safely, and close database pools and consumers.
- Set request, outbound HTTP, database, and job timeouts at the correct layer.
- Define resource limits and graceful degradation behavior. Avoid unlimited in-memory queues and unbounded result sets.
- Keep error messages useful for operators while keeping client responses safe.
- Provide a short runbook for common failure modes when the service matters beyond a throwaway prototype.

Do not promise a latency or availability SLO unless it is measured and the required monitoring exists.

## 9. Testing and Verification

Use the right test level for each risk:

1. **Unit tests:** Business rules, validation, permissions, edge cases, and calculations.
2. **Integration tests:** Database constraints/transactions, authentication middleware, external client adapters, and HTTP handlers.
3. **Contract tests:** API schemas, webhook signatures, and compatibility with consumers where applicable.
4. **End-to-end tests:** A few critical user journeys across the deployed or representative stack.
5. **Security tests:** Unauthenticated access, cross-user/cross-tenant access, malformed input, abusive request rates, unsafe files, and secret exposure.

Prefer realistic integration environments such as disposable test databases or containers when suitable. Do not mock the very behavior the test is intended to verify. Test failure paths, not only happy paths.

Before declaring a task complete:

- Run the relevant test suite, type checker, linter, and build when available.
- Add or update tests for changed behavior.
- Test invalid inputs, missing/expired authentication, and authorization failures.
- Verify migrations from a clean database and, when relevant, from the previous schema.
- Review the final diff for unrelated edits, accidentally committed secrets, and generated artifacts.
- State exactly what ran and what did not run. If deployment or external integration could not be verified, say so.

## 10. Cost-Aware Deployment

Choose the cheapest hosting model that meets the service's actual runtime and reliability requirements. Verify current provider limits and terms before committing.

- **Static site:** Use static hosting; do not rent a server to serve HTML, CSS, images, and built frontend assets.
- **Small, stateless API:** Consider an edge/serverless runtime when execution time, networking, database access, and CPU limits fit.
- **CRUD app with auth and database:** Consider a managed backend such as Supabase if it reduces operational work; evaluate free-tier inactivity behavior, database size, egress, backups, and security rules.
- **Conventional Node/Python server:** Compare managed app platforms with a low-cost VPS. A VPS is cheaper at some levels but makes the operator responsible for OS patching, firewalls, process supervision, TLS, backups, and monitoring.
- **Production data:** Do not rely on an expiring free database, ephemeral local disk, or undocumented free-tier behavior.
- **Domain:** The domain registration is separate from hosting. Compare renewals and included taxes, not just the first-year promotion.
- **Email:** Domain ownership does not automatically include a mailbox. Treat inbound mail hosting and reliable outbound transactional email as separate services.
- **Budget controls:** Set billing alerts/usage limits where available, remove abandoned resources, and document what happens when a free quota is exceeded.

Never claim a host is “free forever.” Explain free-tier limits, cold starts, paused projects, data persistence, and the point at which paid usage begins.

## 11. Working Style and Deliverables

For feature work, follow this sequence:

1. Restate the implementation goal and identify relevant constraints.
2. Inspect the current code and describe the smallest sensible design.
3. Implement complete, runnable logic rather than TODO-heavy scaffolding.
4. Add validation, authorization, error handling, and tests alongside the feature.
5. Explain required environment variables and how to run/test locally.
6. Include migration and deployment steps when applicable.
7. Summarize changed files, commands/tests run, deployment limitations, and material security/cost trade-offs.

Keep responses direct. Avoid generic lectures, unnecessary abstraction, invented APIs, and wholesale rewrites. Ask before destructive changes such as dropping data, rotating production credentials, or deploying a change that can cause a billing event.

## 12. Reference Sources

Load only the references relevant to the current task and verify version-sensitive guidance against official docs.

- Backend patterns and implementation boundaries: https://github.com/magnus919/agent-skills/tree/main/backend-engineering
- General production backend skill reference: https://github.com/echohaoran/AI-AGENT-Skills/tree/main/sources/document-xlsx/frameworks/shared-skills/skills/software-backend
- Supabase-specific skill (use only when the project actually uses Supabase): https://github.com/supabase/agent-skills/tree/main/skills/supabase
- Supabase PostgreSQL optimization skill: https://github.com/supabase/agent-skills/tree/main/skills/supabase-postgres-best-practices
- OWASP API Security Top 10: https://owasp.org/API-Security/
- RFC 9457 Problem Details: https://www.rfc-editor.org/rfc/rfc9457
- PostgreSQL documentation: https://www.postgresql.org/docs/current/
- Node.js documentation: https://nodejs.org/docs/latest/api/
- OpenAPI specification: https://spec.openapis.org/oas/latest.html

**Core rule:** Ship the simplest backend that is secure enough for its threat model, testable, observable, maintainable, and economically appropriate.
