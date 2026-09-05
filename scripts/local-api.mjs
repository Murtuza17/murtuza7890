/**
 * A minimal PostgREST-compatible shim over a local Postgres.
 *
 * Dev and CI only — Supabase runs the real PostgREST in production. This exists
 * so the whole app can be run and tested end to end with no Supabase account,
 * no network and no credentials, which is also how the UI gets exercised in CI.
 *
 * It implements exactly the two shapes src/data/supabase.ts uses:
 *     POST /rest/v1/rpc/<fn>          named arguments, JSON body
 *     GET  /rest/v1/<table>?select=*&order=<col>.<dir>&limit=<n>
 *
 *     node scripts/local-api.mjs [port] [database]
 */
import { createServer } from 'node:http'
import pg from 'pg'

// PostgREST returns dates and timestamps as ISO strings. node-pg hydrates them
// into Date objects by default, which is a different contract and hid a real
// expiry-parsing bug behind a shim that was "close enough".
for (const oid of [1082 /* date */, 1114 /* timestamp */, 1184 /* timestamptz */]) {
  pg.types.setTypeParser(oid, (v) => v)
}

const PORT = Number(process.argv[2] ?? 54321)
const DATABASE = process.argv[3] ?? 'vetswap_test'

const pool = new pg.Pool({
  host: process.env.PGHOST ?? '/tmp',
  port: Number(process.env.PGPORT ?? 55432),
  user: 'postgres',
  database: DATABASE,
})

// Only ever interpolate identifiers that match this. Everything else is a
// bound parameter.
const IDENT = /^[a-z_][a-z0-9_]*$/

const READABLE = new Set([
  'clinics_public', 'drugs', 'batch_stock', 'requests', 'transfers', 'stock_movements',
  'events', 'clinic_drug_consumption',
])

const CALLABLE = new Set([
  'clinic_login', 'accept_transfer', 'decline_transfer', 'cancel_transfer',
  'dispatch_transfer', 'confirm_handoff', 'log_movement', 'create_batch',
  'create_request', 'claim_from_match', 'sweep_expired_reservations',
])

const send = (res, code, body) => {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  })
  res.end(JSON.stringify(body))
}

createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, null)

  const url = new URL(req.url, 'http://localhost')
  const path = url.pathname.replace(/^\/rest\/v1\//, '')

  try {
    if (req.method === 'POST' && path.startsWith('rpc/')) {
      const fn = path.slice(4)
      if (!IDENT.test(fn) || !CALLABLE.has(fn)) return send(res, 404, { message: 'no such function' })

      const chunks = []
      for await (const c of req) chunks.push(c)
      const args = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}

      const names = Object.keys(args).filter((k) => IDENT.test(k))
      const params = names.map((n, i) => `${n} => $${i + 1}`).join(', ')
      const values = names.map((n) => args[n])

      const { rows } = await pool.query(`select public.${fn}(${params}) as result`, values)
      return send(res, 200, rows[0]?.result ?? null)
    }

    if (req.method === 'GET') {
      const table = path
      if (!IDENT.test(table) || !READABLE.has(table)) return send(res, 404, { message: 'no such table' })

      let sql = `select * from public.${table}`
      const order = url.searchParams.get('order')
      if (order) {
        const [col, dir] = order.split('.')
        if (IDENT.test(col)) sql += ` order by ${col} ${dir === 'desc' ? 'desc' : 'asc'}`
      }
      const limit = Number(url.searchParams.get('limit'))
      if (Number.isInteger(limit) && limit > 0) sql += ` limit ${limit}`

      const { rows } = await pool.query(sql)
      return send(res, 200, rows)
    }

    send(res, 404, { message: 'not found' })
  } catch (err) {
    send(res, 400, { message: err.message })
  }
}).listen(PORT, () => {
  console.log(`local-api on http://localhost:${PORT}/rest/v1  (db: ${DATABASE})`)
})
