// The fake Cloudflare API: a local stand-in on this computer's loopback address, for every test that
// would otherwise need Cloudflare (spec docs/plans/cloudflare-setup-in-app, test matrix). Used by the
// unit and integration tests of the connection, the secrets gate, the Settings journey, the wrangler
// trace and overlap tests and the packaged smoke. No request ever leaves the machine.
//
//   const api = await startCloudflareApiStub()             // as before: any token, one site `talks`
//   const api = await startCloudflareApiStub({ tokens: { 'made-up-token…': { accounts: ['acc1'] } },
//                                              accounts: [{ id: 'acc1', name: 'Ada' }] })
//
// Give `api.baseUrl` (`http://127.0.0.1:<port>/client/v4`) to wrangler as CLOUDFLARE_API_BASE_URL
// through the launcher's `set` side, or to the app as TW_E2E_CLOUDFLARE_API_BASE_URL (with TW_E2E=1).
//
// What it models, enough for the app's own calls and for wrangler's `pages deploy`, `deploy` and
// `secret bulk` to run to their end:
//   - tokens: with no `tokens` option every token is accepted and may do everything (the earlier
//     behaviour). With one, a token it does not list is refused, and each listed token has a status
//     (`active`, `expired`, `disabled`), the accounts it can see and what it may do with Pages
//     (`pages`) and Workers (`workers`): `true` to edit, `'read'` to read only, `false` nothing.
//     It is strict about that: issuing an upload token, creating a deployment or a site, uploading
//     a Worker, setting its secrets or its address all need edit; `'read'` can only look;
//   - the account list is paged (`page`, `per_page`, with `result_info`), as Cloudflare's is;
//   - accounts, Pages sites per account (look up, create, custom domains, upload, deployments);
//   - zones (`options.zones`: [{ id, name, account }]; `GET /zones?name=&account.id=`, and
//     `GET /zones/<id>/workers/routes`) and the Workers custom domains of an account
//     (`GET /accounts/<id>/workers/domains`, filled from `options.workerDomains`: { account: [hostname] }).
//     A token's `zones` and `routes` grants work like `pages` and `workers` (`false` refuses the read);
//   - Workers per account (look up, upload with its migrations, versions, the workers.dev
//     subdomain, secrets), as the app's own upload of the live service sends them (ticket 11):
//     the multipart upload is read part by part (`request.parts`; the Worker keeps its `module`
//     bytes and `metadata`), the migration tag is kept and reported by the services lookup, and a
//     migration that does not follow from the deployed tag is refused as Cloudflare refuses it;
//     custom domains are attached (`PUT …/scripts/<name>/domains/records`, replacing the Worker's
//     own) and removed (`DELETE /accounts/<id>/workers/domains/<id>`), and the list can be filtered
//     by `?service=`.
// Anything else is answered 404 (no such route) and listed in `api.unknown`: a caller cannot pass
// by asking for something the fake does not model.
//
// Knobs, changed by a test while the server runs (`api.model`):
//   hang(request)    → true: that request is never answered (a time-out for the caller);
//   answer(request)  → { status, body }: that request gets exactly this instead. With `wait` (a
//                      promise) the answer is held until it settles; with `throws` (fetch only) the
//                      request fails to send with that error.
//   delay(request)   → a promise: the ordinary answer is held until it settles.
// `createFakeCloudflare` is the same model with no server and `fakeCloudflareFetch` a `fetch` over it,
// for tests that need no network at all.
// `api.requests` records every request: method, path, the Authorization header, the content type
// and the body (with `parts` when it is multipart).
// Every refusal carries REPLY_TEXT_MARK in its message, so a test can show that no text of a reply
// reaches a window, a log or an error.
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

export const REPLY_TEXT_MARK = 'stand-in-reply-text'
export const WORKERS_SUBDOMAIN = 'stand-in'
/** A Workers custom domain's id, in Cloudflare's shape (32 lowercase hex), made from its hostname. */
export const workerDomainId = (hostname) => createHash('sha256').update(String(hostname)).digest('hex').slice(0, 32)

const ok = (result, extra = {}) => ({ status: 200, body: { success: true, errors: [], messages: [], result, ...extra } })
const failure = (status, code, message) => ({ status, body: { success: false, errors: [{ code, message: `${message} (${REPLY_TEXT_MARK})` }], messages: [], result: null } })

/**
 * The model without a server: what the stand-in knows and how it answers one request. Tests of pure
 * logic put it behind a `fetch` of their own (`fakeCloudflareFetch`); `startCloudflareApiStub` puts
 * it behind a loopback HTTP server.
 */
export function createFakeCloudflare(options = {}) {
  const requests = []
  const unknown = []
  const jwt = ['{"alg":"none"}', JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }), 'sig'].map((part) => Buffer.from(part).toString('base64url')).join('.')
  const open = !options.tokens
  const model = {
    /** token → { status, accounts: [id], pages, workers } */
    tokens: new Map(Object.entries(options.tokens ?? {}).map(([token, grant]) => [token, { status: 'active', accounts: [], pages: true, workers: true, zones: true, routes: true, ...grant }])),
    accounts: options.accounts ?? [],
    /** account id → Map(site name → { domains: [{ name, status }] }). `*` holds the sites every account has. */
    sites: new Map([['*', new Map((options.sites ?? ['talks']).map((name) => [name, { domains: [] }]))]]),
    /** account id → Map(worker name → { uploads, secrets: [names], migrationTag, module, metadata, workersDev }) */
    workers: new Map(),
    /** [{ id, name, account }] */
    zones: options.zones ?? [],
    /** account id → [{ id, hostname, service, environment }]. Those given as options belong to another Worker. */
    workerDomains: new Map(Object.entries(options.workerDomains ?? {}).map(([account, hosts]) => [account, hosts.map((hostname) => ({ id: workerDomainId(hostname), hostname, service: 'talkweaver-live', environment: 'production' }))])),
    hang: null,
    answer: null,
    delay: null,
  }
  for (const [account, names] of Object.entries(options.accountSites ?? {})) model.sites.set(account, new Map(names.map((name) => [name, { domains: [] }])))
  // A site's custom domains as Cloudflare lists them (GET …/pages/projects/<name>/domains): { account: { site: [{ name, status }] } }.
  for (const [account, bySite] of Object.entries(options.siteDomains ?? {})) {
    for (const [name, domains] of Object.entries(bySite)) {
      if (!model.sites.has(account)) model.sites.set(account, new Map())
      model.sites.get(account).set(name, { domains: domains.map((domain) => ({ id: `domain-${domain.name}`, zone_tag: 'zone-tag-0001', ...domain })) })
    }
  }

  const sitesOf = (account) => {
    if (!model.sites.has(account)) model.sites.set(account, new Map())
    return model.sites.get(account)
  }
  const siteOf = (account, name) => sitesOf(account).get(name) ?? model.sites.get('*').get(name)
  const workersOf = (account) => {
    if (!model.workers.has(account)) model.workers.set(account, new Map())
    return model.workers.get(account)
  }
  const projectBody = (name) => ({ id: `site-${name}`, name, subdomain: `${name}.pages.dev`, production_branch: 'main', domains: [`${name}.pages.dev`], deployment_configs: { production: {}, preview: {} } })
  const deploymentBody = (name) => ({ id: 'dep00000001', url: `https://dep00000001.${name}.pages.dev`, environment: 'production', aliases: [], project_name: name, latest_stage: { name: 'deploy', status: 'success' }, stages: [{ name: 'deploy', status: 'success' }] })

  const noRoute = (method, path) => { unknown.push(`${method} ${path}`); return failure(404, 7003, 'No route for that URI') }
  const denied = () => failure(403, 10000, 'Authentication error')

  function route(request) {
    const { method, path, body } = request
    const bearer = /^Bearer (.+)$/.exec(request.authorization)?.[1] ?? ''
    const grant = open ? { status: 'active', accounts: null, pages: true, workers: true, zones: true, routes: true } : model.tokens.get(bearer)
    // Uploads are authorised with the upload token the API itself issued, not the person's token.
    if (path.startsWith('/pages/assets/')) {
      if (path === '/pages/assets/check-missing') return ok(JSON.parse(body.toString() || '{}').hashes ?? [])
      return ok(null)
    }
    if (path === '/user/tokens/verify') {
      if (!grant) return failure(401, 1000, 'Invalid API Token')
      return ok({ id: 'token-id-0001', status: grant.status })
    }
    if (!grant || grant.status !== 'active') return failure(403, 10000, 'Authentication error')
    const sees = (account) => grant.accounts === null || grant.accounts.includes(account)
    if (path === '/accounts' && method === 'GET') {
      const listed = grant.accounts === null ? model.accounts : model.accounts.filter((account) => grant.accounts.includes(account.id))
      const query = new URLSearchParams(request.search ?? '')
      const perPage = Math.min(Math.max(Number(query.get('per_page')) || 20, 5), 50)
      const page = Math.max(Number(query.get('page')) || 1, 1)
      const slice = listed.slice((page - 1) * perPage, page * perPage)
      return ok(slice, { result_info: { page, per_page: perPage, count: slice.length, total_count: listed.length, total_pages: Math.ceil(listed.length / perPage) } })
    }
    if (path === '/user' || path === '/memberships') return ok(path === '/user' ? { id: 'user-0001', email: 'person@example.invalid' } : [])
    if (path === '/zones' && method === 'GET') {
      if (!grant.zones) return denied()
      const query = new URLSearchParams(request.search ?? '')
      const name = query.get('name')
      const account = query.get('account.id')
      const found = model.zones.filter((zone) => (!name || zone.name === name) && (!account || zone.account === account) && (grant.accounts === null || grant.accounts.includes(zone.account)))
      return ok(found.map(({ id, name: zoneName }) => ({ id, name: zoneName, status: 'active' })))
    }
    const zoneRoutes = /^\/zones\/([^/]+)\/workers\/routes$/.exec(path)
    if (zoneRoutes && method === 'GET') {
      const zone = model.zones.find((entry) => entry.id === decodeURIComponent(zoneRoutes[1]))
      if (!zone) return failure(404, 7003, 'No route for that URI')
      return grant.routes ? ok([]) : denied()
    }
    const scoped = /^\/accounts\/([^/]+)(\/.*)?$/.exec(path)
    if (!scoped) return noRoute(method, path)
    const account = scoped[1]
    const rest = scoped[2] ?? ''
    if (!sees(account)) return failure(403, 10000, 'Authentication error')

    // ── Pages ──
    if (rest.startsWith('/pages/')) {
      if (!grant.pages) return failure(403, 10000, 'Authentication error')
      if (rest === '/pages/projects' && method === 'POST') {
        if (grant.pages !== true) return failure(403, 10000, 'Authentication error')
        let name = ''
        try { name = String(JSON.parse(body.toString()).name ?? '') } catch { /* no name */ }
        if (!/^[a-z0-9][a-z0-9-]{0,57}$/.test(name)) return failure(400, 8000015, 'Invalid project name')
        if (siteOf(account, name)) return failure(409, 8000002, 'A project with this name already exists')
        sitesOf(account).set(name, { domains: [] })
        return ok(projectBody(name))
      }
      if (rest === '/pages/projects' && method === 'GET') return ok([...new Set([...model.sites.get('*').keys(), ...sitesOf(account).keys()])].map(projectBody))
      const site = /^\/pages\/projects\/([^/]+)(\/.*)?$/.exec(rest)
      if (site) {
        const name = decodeURIComponent(site[1])
        const found = siteOf(account, name)
        if (!found) return failure(404, 8000007, 'Project not found')
        const tail = site[2] ?? ''
        if (tail === '') return ok(projectBody(name))
        if (tail === '/domains' && method === 'GET') return ok(found.domains)
        // Publishing needs edit: the upload token and the deployment are both refused to a reader.
        if (tail === '/upload-token') return grant.pages === true ? ok({ jwt }) : denied()
        if (tail === '/deployments' && method === 'POST') return grant.pages === true ? ok(deploymentBody(name)) : denied()
        if (/^\/deployments(?:\/dep00000001)?$/.test(tail) && method === 'GET') return ok(deploymentBody(name))
      }
      return noRoute(method, path)
    }

    // ── Workers ──
    if (rest.startsWith('/workers/')) {
      if (!grant.workers) return failure(403, 10000, 'Authentication error')
      const workers = workersOf(account)
      if (rest === '/workers/scripts' && method === 'GET') return ok([...workers.keys()].map((id) => ({ id })))
      if (rest === '/workers/domains' && method === 'GET') {
        const query = new URLSearchParams(request.search ?? '')
        const service = query.get('service')
        const environment = query.get('environment')
        // An entry kept without an environment is listed without one (and matches no environment filter).
        return ok((model.workerDomains.get(account) ?? []).filter((domain) => (!service || domain.service === service) && (!environment || domain.environment === environment))
          .map(({ id, hostname, service: owner, environment: env }) => ({ id, hostname, service: owner, ...(env ? { environment: env } : {}) })))
      }
      const domainRecord = /^\/workers\/domains\/([^/]+)$/.exec(rest)
      if (domainRecord && method === 'DELETE') {
        if (grant.workers !== true) return denied()
        const list = model.workerDomains.get(account) ?? []
        const at = list.findIndex((domain) => domain.id === decodeURIComponent(domainRecord[1]))
        if (at === -1) return failure(404, 100117, 'Domain not found')
        list.splice(at, 1)
        return ok(null)
      }
      if (rest === '/workers/subdomain') return ok({ subdomain: WORKERS_SUBDOMAIN })
      const service = /^\/workers\/services\/([^/]+)(\/.*)?$/.exec(rest)
      if (service) {
        const worker = workers.get(service[1])
        if (!worker) return failure(404, 10090, 'This Worker does not exist on your account')
        return ok({ id: service[1], default_environment: { environment: 'production', script: { tag: 'tag-0001', last_deployed_from: 'wrangler', ...(worker.migrationTag ? { migration_tag: worker.migrationTag } : {}) } } })
      }
      const settled = /^\/workers\/workers\/([^/]+)$/.exec(rest)
      if (settled) {
        if (!workers.has(settled[1])) return failure(404, 10007, 'This Worker does not exist on your account')
        return ok({ id: settled[1], name: settled[1], subdomain: { enabled: true, previews_enabled: true }, tags: [], observability: { enabled: true } })
      }
      const script = /^\/workers\/scripts\/([^/]+)(\/.*)?$/.exec(rest)
      if (script) {
        const name = script[1]
        const tail = script[2] ?? ''
        const existing = workers.get(name)
        const made = () => {
          if (!workers.has(name)) workers.set(name, { uploads: 0, secrets: [], migrationTag: null, module: null, metadata: null, workersDev: false })
          return workers.get(name)
        }
        if (tail === '' && method === 'PUT') {
          if (grant.workers !== true) return failure(403, 10000, 'Authentication error')
          const parts = request.parts ?? []
          const metadataPart = parts.find((part) => part.name === 'metadata')
          let metadata = null
          try { metadata = metadataPart ? JSON.parse(metadataPart.bytes.toString('utf8')) : null } catch { /* unreadable */ }
          if (!metadata) return failure(400, 10021, 'No metadata part in the upload')
          const module = parts.find((part) => part.name === metadata.main_module)
          if (!module || module.bytes.length === 0) return failure(400, 10021, 'No main module in the upload')
          // Migrations as Cloudflare takes them: `old_tag` must be the tag deployed now, and with a tag deployed one must be given.
          const migrations = metadata.migrations
          const deployedTag = existing?.migrationTag ?? null
          if (migrations && (migrations.old_tag ?? null) !== deployedTag) return failure(400, 10079, 'The migration tag precondition failed')
          const worker = made()
          worker.uploads += 1
          worker.module = module.bytes
          worker.metadata = metadata
          if (migrations?.new_tag) worker.migrationTag = migrations.new_tag
          return ok({ id: name, etag: 'etag-0001', startup_time_ms: 1, pipeline_hash: 'hash-0001', tag: 'tag-0001', deployment_id: 'deployment-0001', migration_tag: worker.migrationTag })
        }
        if (tail === '/secrets' && method === 'GET') {
          if (!existing) return failure(404, 10007, 'This Worker does not exist on your account')
          return ok(existing.secrets.map((secret) => ({ name: secret, type: 'secret_text' })))
        }
        if (tail === '/secrets-bulk' || tail === '/secrets') {
          if (grant.workers !== true) return failure(403, 10000, 'Authentication error')
          const worker = made()
          let names = []
          try { const sent = JSON.parse(body.toString()); names = Object.keys(sent.secrets ?? { [sent.name]: true }) } catch { /* nothing named */ }
          worker.secrets = [...new Set([...worker.secrets, ...names])]
          return ok({})
        }
        if (!existing) return failure(404, 10007, 'This Worker does not exist on your account')
        if (method !== 'GET' && grant.workers !== true) return denied()
        if (tail === '/subdomain' && method === 'POST') {
          let enabled = false
          try { enabled = JSON.parse(body.toString()).enabled === true } catch { /* not JSON */ }
          existing.workersDev = enabled
          return ok({ enabled, previews_enabled: false })
        }
        if (tail === '/subdomain') return ok({ enabled: existing.workersDev, previews_enabled: false })
        if (tail === '/domains/records' && method === 'PUT') {
          if (grant.routes === false) return denied()
          let sent = null
          try { sent = JSON.parse(body.toString()) } catch { /* not JSON */ }
          if (!sent || !Array.isArray(sent.origins)) return failure(400, 100116, 'No origins given')
          const list = model.workerDomains.get(account) ?? []
          // override_scope: the Worker's own domains are replaced by the ones given.
          const others = list.filter((domain) => domain.service !== name || domain.environment !== 'production' || !sent.override_scope)
          const taken = others.find((domain) => sent.origins.some((origin) => origin.hostname === domain.hostname))
          if (taken && !sent.override_existing_origin) return failure(409, 100117, 'The domain is in use by another Worker')
          const kept = others.filter((domain) => !sent.origins.some((origin) => origin.hostname === domain.hostname))
          model.workerDomains.set(account, [...kept, ...sent.origins.map((origin) => ({ id: workerDomainId(origin.hostname), hostname: origin.hostname, service: name, environment: 'production' }))])
          return ok(sent.origins.map((origin) => ({ id: workerDomainId(origin.hostname), hostname: origin.hostname, service: name, environment: 'production' })))
        }
        if (tail === '/script-settings' || tail === '/settings') return ok({ tags: [], logpush: false, tail_consumers: [], observability: { enabled: true }, bindings: [], migration_tag: existing.migrationTag })
        if (tail === '/versions' && method === 'POST') { existing.uploads += 1; return ok({ id: 'version-0001', number: existing.uploads, startup_time_ms: 1, resources: { script: { etag: 'etag-0001' } } }) }
        if (tail === '/versions') return ok({ items: [{ id: 'version-0001', number: existing.uploads, metadata: {} }] })
        if (tail.startsWith('/versions/')) return ok({ id: 'version-0001', number: existing.uploads, metadata: {}, resources: { bindings: [], script: {}, script_runtime: {} } })
        if (tail === '/deployments' && method === 'POST') return ok({ id: 'deployment-0001' })
        if (tail === '/deployments') return ok({ deployments: [{ id: 'deployment-0001', source: 'wrangler', strategy: 'percentage', versions: [{ version_id: 'version-0001', percentage: 100 }] }] })
        if (tail === '/routes' || tail === '/schedules' || tail === '/domains' || tail === '/tails') return ok([])
      }
    }
    return noRoute(method, path)
  }

  /** Record one request and answer it: `{ status, body }`, or null when it is to be left hanging. */
  function handle(recorded) {
    requests.push(recorded)
    if (model.hang?.(recorded)) return null
    let reply
    try { reply = model.answer?.(recorded) ?? route(recorded) } catch { reply = failure(500, 0, 'The stand-in failed') }
    const wait = model.delay?.(recorded)
    return wait ? { ...reply, wait } : reply
  }
  return { requests, unknown, model, handle, reached: () => requests.map((request) => `${request.method} ${request.path}`) }
}

/** The parts of a multipart/form-data body: [{ name, filename, type, bytes }]. Empty when it is not one. */
export function multipartParts(body, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? '')
  if (!/^multipart\/form-data/i.test(contentType ?? '') || !boundary) return []
  const marker = Buffer.from(`--${boundary[1] ?? boundary[2]}`)
  const parts = []
  let at = body.indexOf(marker)
  while (at !== -1) {
    const start = at + marker.length
    if (body.subarray(start, start + 2).toString() === '--') break
    const next = body.indexOf(marker, start)
    if (next === -1) break
    const chunk = body.subarray(start + 2, next - 2) // after CRLF, before the CRLF that ends the part
    const split = chunk.indexOf('\r\n\r\n')
    const head = chunk.subarray(0, split).toString('utf8')
    const disposition = /content-disposition:[^\r\n]*/i.exec(head)?.[0] ?? ''
    parts.push({
      name: /\bname="([^"]*)"/.exec(disposition)?.[1] ?? '',
      filename: /\bfilename="([^"]*)"/.exec(disposition)?.[1] ?? null,
      type: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim() ?? null,
      bytes: Buffer.from(chunk.subarray(split + 4)),
    })
    at = next
  }
  return parts
}

/**
 * A `fetch` over the model, with no network at all. A request left hanging never settles, and (like
 * a stuck connection) does not notice being aborted unless `honourAbort` is set.
 */
export function fakeCloudflareFetch(fake, { honourAbort = false } = {}) {
  return async (address, init = {}) => {
    const url = new URL(address)
    const headers = new Headers(init.headers)
    const path = url.pathname.replace(/^\/client\/v4/, '')
    // Any body as its bytes on the wire (a FormData body serialised with its boundary, as fetch sends it).
    let body = Buffer.from(typeof init.body === 'string' ? init.body : '')
    let contentType = headers.get('content-type') ?? ''
    if (init.body !== undefined && typeof init.body !== 'string') {
      const wire = new Request('http://stand-in.invalid/', { method: 'POST', body: init.body })
      body = Buffer.from(await wire.arrayBuffer())
      contentType = contentType || wire.headers.get('content-type') || ''
    }
    const reply = fake.handle({
      method: init.method ?? 'GET', path, search: url.search, origin: url.origin, headers: Object.fromEntries(headers),
      authorization: headers.get('authorization') ?? '', contentType, body, parts: multipartParts(body, contentType), redirect: init.redirect,
    })
    if (reply === null) {
      return new Promise((_resolve, reject) => {
        if (honourAbort) init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }
    if (reply.throws) throw reply.throws
    if (reply.wait) await reply.wait
    return new Response(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } })
  }
}

export function startCloudflareApiStub(options = {}) {
  const fake = createFakeCloudflare(options)
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', async () => {
      const url = new URL(request.url, 'http://stub')
      const path = url.pathname.replace(/^\/client\/v4/, '')
      const body = Buffer.concat(chunks)
      const contentType = request.headers['content-type'] ?? ''
      const reply = fake.handle({ method: request.method, path, search: url.search, headers: { ...request.headers }, authorization: request.headers.authorization ?? '', contentType, body, parts: multipartParts(body, contentType) })
      if (reply === null) return
      if (reply.wait) await reply.wait
      const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)
      response.writeHead(reply.status, { 'content-type': reply.contentType ?? 'application/json', ...(reply.headers ?? {}) })
      response.end(text)
    })
  })
  return new Promise((resolveStub) => server.listen(0, '127.0.0.1', () => resolveStub({
    ...fake, port: server.address().port, baseUrl: `http://127.0.0.1:${server.address().port}/client/v4`,
    close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(done) }),
  })))
}
