// Checks how long the worker's PSN sign-in can last without a manual renewal:
// whether Sony renews the NPSSO when it's used, and whether a refresh token
// outlives the NPSSO it was exchanged from.
//
// It makes the same authorize and token calls the worker makes, plus a request
// to the ssocookie endpoint, and prints only lifetimes and the names, domains
// and expiry dates of the cookies Sony sets. The NPSSO, cookie values, the
// authorization code and the tokens are never printed or saved. For the
// `npsso` cookie it also says whether the value is the one you entered or a
// new one. The token exchange creates one more sign-in for the account, just
// like POST /admin/npsso does; its tokens are discarded.
//
// Each run is appended to npsso-check-log.json next to this script (no secrets
// in it), so a run a few days later can show whether the expiry moved forward.
//
// Usage: node scripts/check-npsso-renewal.mjs

import { readFile, writeFile } from 'node:fs/promises'
import { askHidden } from './hidden-input.mjs'

// The PlayStation App's public OAuth client, the same one the worker uses
const AUTH_BASE_URL = 'https://ca.account.sony.com/api/authz/v3/oauth'
const SSO_COOKIE_URL = 'https://ca.account.sony.com/api/v1/ssocookie'
const CLIENT_ID = '09515159-7237-4370-9b40-3806e67c0891'
const CLIENT_AUTHORIZATION =
  'Basic MDk1MTUxNTktNzIzNy00MzcwLTliNDAtMzgwNmU2N2MwODkxOnVjUGprYTV0bnRCMktxc1A='
const REDIRECT_URI = 'com.scee.psxandroid.scecompcall://redirect'
const SCOPE = 'psn:mobile.v2.core psn:clientapp'

const LOG_FILE = new URL('./npsso-check-log.json', import.meta.url)
const DAY_MS = 24 * 60 * 60 * 1000

// The process ends on its own with this exit code: calling process.exit()
// while stdin is closing crashes Node on Windows.
process.exitCode = await main()

async function main() {
  const input = await askHidden('NPSSO (input hidden): ')

  if (input === null) {
    return 130 // Ctrl+C
  }

  const npsso = input.trim()

  if (!npsso) {
    return fail('No NPSSO entered')
  }

  const checkedAt = new Date()
  const cookie = { Cookie: `npsso=${npsso}` }

  const authorize = await fetch(
    `${AUTH_BASE_URL}/authorize?${new URLSearchParams({
      access_type: 'offline',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: SCOPE,
    })}`,
    { headers: cookie, redirect: 'manual' },
  )
  const location = authorize.headers.get('location') ?? ''
  const accepted = location.includes('?code=')
  const ssoCookie = await fetch(SSO_COOKIE_URL, { headers: cookie })
  const ssoBody = await ssoCookie.json().catch(() => null)

  const run = {
    checkedAt: checkedAt.toISOString(),
    npssoExpiresAt: expiryAfter(checkedAt, ssoBody?.expires_in),
    refreshTokenExpiresAt: null,
    requests: [
      {
        request: 'authorize',
        status: authorize.status,
        accepted,
        cookies: describeCookies(authorize, npsso, checkedAt),
      },
      {
        request: 'ssocookie',
        status: ssoCookie.status,
        bodyNpsso: compareNpsso(ssoBody?.npsso, npsso),
        cookies: describeCookies(ssoCookie, npsso, checkedAt),
      },
    ],
  }

  if (accepted) {
    const token = await fetch(`${AUTH_BASE_URL}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: CLIENT_AUTHORIZATION,
      },
      body: new URLSearchParams({
        code: new URLSearchParams(location.split('redirect/')[1]).get('code'),
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
        token_format: 'jwt',
      }),
    })
    // Only the two lifetimes are kept, the tokens go out of scope here
    const { expires_in: accessExpiresIn, refresh_token_expires_in: refreshExpiresIn } =
      await token.json().catch(() => ({}))

    run.refreshTokenExpiresAt = expiryAfter(checkedAt, refreshExpiresIn)
    run.requests.push({
      request: 'token',
      status: token.status,
      accessTokenExpiresIn: accessExpiresIn ?? null,
      refreshTokenExpiresIn: refreshExpiresIn ?? null,
      cookies: describeCookies(token, npsso, checkedAt),
    })
  }

  printRun(run)
  await compareWithPreviousRun(run)
  await appendToLog(run)

  return 0
}

// Only names and dates leave this function, never a value
function describeCookies(response, npsso, checkedAt) {
  return response.headers.getSetCookie().map((header) => {
    const [pair, ...attributes] = header.split(';').map((part) => part.trim())
    const separator = pair.indexOf('=')
    const name = separator === -1 ? pair : pair.slice(0, separator)
    const value = separator === -1 ? '' : pair.slice(separator + 1)
    const attribute = (key) =>
      attributes
        .find((a) => a.toLowerCase().startsWith(`${key.toLowerCase()}=`))
        ?.split('=')
        .slice(1)
        .join('=')

    const maxAge = attribute('Max-Age')
    const expires = attribute('Expires')
    let expiresAt = null

    if (maxAge !== undefined) {
      expiresAt = new Date(checkedAt.getTime() + Number(maxAge) * 1000)
    } else if (expires !== undefined) {
      expiresAt = new Date(expires)
    }

    return {
      name,
      domain: attribute('Domain') ?? '(request host)',
      expiresAt: expiresAt && !isNaN(expiresAt) ? expiresAt.toISOString() : null,
      ...(name === 'npsso' ? { value: compareNpsso(value, npsso) } : {}),
    }
  })
}

function expiryAfter(from, seconds) {
  return typeof seconds === 'number'
    ? new Date(from.getTime() + seconds * 1000).toISOString()
    : null
}

function days(seconds) {
  return `${(seconds / 86400).toFixed(2)} days`
}

function compareNpsso(value, npsso) {
  if (value === undefined || value === null || value === '') {
    return 'empty'
  }

  return value === npsso ? 'same as entered' : 'new value'
}

function printRun(run) {
  const checkedAt = new Date(run.checkedAt)

  console.log(`Checked at ${run.checkedAt}\n`)

  for (const request of run.requests) {
    const details = [`HTTP ${request.status}`]

    if ('accepted' in request) {
      details.push(`NPSSO accepted: ${request.accepted ? 'yes' : 'no'}`)
    }

    if ('bodyNpsso' in request) {
      details.push(`npsso in response body: ${request.bodyNpsso}`)
    }

    if ('refreshTokenExpiresIn' in request) {
      details.push(
        `access token lifetime: ${request.accessTokenExpiresIn ?? 'missing'} s`,
        `refresh token lifetime: ${request.refreshTokenExpiresIn === null ? 'missing' : `${request.refreshTokenExpiresIn} s (${days(request.refreshTokenExpiresIn)})`}`,
      )
    }

    console.log(`${request.request}: ${details.join(', ')}`)

    if (request.cookies.length === 0) {
      console.log('  no cookies set')
    }

    for (const c of request.cookies) {
      const expiry = c.expiresAt
        ? `expires ${c.expiresAt} (in ${((new Date(c.expiresAt) - checkedAt) / DAY_MS).toFixed(1)} days)`
        : 'session cookie, no expiry'
      const value = c.value ? `, value: ${c.value}` : ''

      console.log(`  ${c.name} (${c.domain}): ${expiry}${value}`)
    }
  }

  console.log('')
  console.log(`NPSSO expires:         ${run.npssoExpiresAt ?? 'unknown (no expires_in from ssocookie)'}`)
  console.log(`Refresh token expires: ${run.refreshTokenExpiresAt ?? 'unknown (no token exchange)'}`)

  if (run.npssoExpiresAt && run.refreshTokenExpiresAt) {
    const gap = (new Date(run.refreshTokenExpiresAt) - new Date(run.npssoExpiresAt)) / 1000

    console.log(
      Math.abs(gap) < 3600
        ? 'The refresh token ends with the NPSSO: it is capped by the NPSSO, so exchanging it later gains nothing.'
        : gap > 0
          ? `The refresh token outlives the NPSSO by ${days(gap)}: exchanging shortly before the NPSSO expires extends the sign-in.`
          : `The refresh token ends ${days(-gap)} before the NPSSO.`,
    )
  }
}

async function compareWithPreviousRun(run) {
  const log = await readLog()
  const previous = log.at(-1)

  console.log('')

  if (!previous) {
    console.log('First run: run it again in a few days to see whether the NPSSO expiry moves.')
    return
  }

  console.log(`Previous run: ${previous.checkedAt}`)
  printMovement('npsso cookie expiry', npssoCookieExpiry(previous), npssoCookieExpiry(run))
  // Runs from before the ssocookie lifetime was recorded don't have it
  printMovement('NPSSO expiry (ssocookie)', previous.npssoExpiresAt, run.npssoExpiresAt)
}

function printMovement(label, before, current) {
  if (!before || !current) {
    console.log(`${label}: ${before ?? 'not set'} then, ${current ?? 'not set'} now`)
    return
  }

  const moved = (new Date(current) - new Date(before)) / DAY_MS

  console.log(
    `${label}: ${before} then, ${current} now ` +
      // A fixed expiry recomputed from a lifetime in seconds drifts by a second or two
      (Math.abs(moved) < 0.01
        ? '(unchanged)'
        : `(moved ${moved > 0 ? 'forward' : 'back'} by ${Math.abs(moved).toFixed(1)} days)`),
  )
}

function npssoCookieExpiry(run) {
  for (const request of run.requests) {
    const npsso = request.cookies.find((c) => c.name === 'npsso')

    if (npsso?.expiresAt) {
      return npsso.expiresAt
    }
  }

  return null
}

async function readLog() {
  try {
    return JSON.parse(await readFile(LOG_FILE, 'utf8'))
  } catch {
    return []
  }
}

async function appendToLog(run) {
  const log = await readLog()

  log.push(run)
  await writeFile(LOG_FILE, `${JSON.stringify(log, null, 2)}\n`)
}

function fail(message) {
  console.error(message)
  return 1
}
