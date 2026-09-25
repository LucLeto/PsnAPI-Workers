// Posts an NPSSO to the worker's POST /admin/npsso, the last step of the
// renewal routine. Sign in to playstation.com in your own browser and copy the
// `npsso` from https://ca.account.sony.com/api/v1/ssocookie first; this script
// doesn't touch Sony's sign-in.
//
// The admin token and the NPSSO are read at hidden prompts, so they're never
// shown, saved or kept in the shell history. The script prints only whether the
// worker stored the NPSSO and until when the sign-in is valid.
//
// Usage: npm run post-npsso -- <worker URL>
//    or: set PSNAPI_WORKER_URL and run `npm run post-npsso`

import { askHidden } from './hidden-input.mjs'

const SSO_COOKIE_URL = 'https://ca.account.sony.com/api/v1/ssocookie'

// The process ends on its own with this exit code: calling process.exit()
// while stdin is closing crashes Node on Windows.
process.exitCode = await main()

async function main() {
  const workerUrl = parseWorkerUrl(
    process.argv[2] ?? process.env.PSNAPI_WORKER_URL,
  )

  if (!workerUrl) {
    return fail(
      'Usage: npm run post-npsso -- <worker URL>, e.g. https://psnapi-workers.<subdomain>.workers.dev',
    )
  }

  const adminToken = await askValue('Admin token (input hidden): ')

  if (typeof adminToken === 'number') {
    return adminToken
  }

  // Without an NPSSO the worker answers 401 for a wrong token and 400 for a
  // right one, so a typo shows up before you paste the NPSSO
  const check = await postNpsso(workerUrl, adminToken, undefined)

  if (check.status === 401) {
    return fail('The worker rejected the admin token (401)')
  }

  if (check.status !== 400) {
    return fail(
      `Unexpected answer from ${workerUrl}/admin/npsso: HTTP ${check.status}`,
    )
  }

  const npsso = await askValue('NPSSO (input hidden): ')

  if (typeof npsso === 'number') {
    return npsso
  }

  const response = await postNpsso(workerUrl, adminToken, npsso)

  if (response.status !== 204) {
    return fail(
      `The worker refused the NPSSO: HTTP ${response.status} ${await errorMessage(response)}`,
    )
  }

  const expire = await readNpssoExpiry(npsso)

  console.log(
    expire
      ? `Stored. The sign-in is valid until ${expire.toISOString()} (${((expire - Date.now()) / 86400000).toFixed(1)} days).`
      : 'Stored.',
  )

  return 0
}

// Returns the trimmed value, or an exit code when nothing usable was entered
async function askValue(question) {
  const input = await askHidden(question)

  if (input === null) {
    return 130 // Ctrl+C
  }

  const value = input.trim()

  return value || fail('Nothing entered')
}

function postNpsso(workerUrl, adminToken, npsso) {
  return fetch(`${workerUrl}/admin/npsso`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(npsso === undefined ? {} : { npsso }),
  })
}

// Sony reports the NPSSO's remaining lifetime; the response body's own copy of
// the NPSSO is ignored
async function readNpssoExpiry(npsso) {
  try {
    const response = await fetch(SSO_COOKIE_URL, {
      headers: { Cookie: `npsso=${npsso}` },
    })

    if (!response.ok) {
      return null
    }

    const json = await response.json()

    return typeof json.expires_in === 'number'
      ? new Date(Date.now() + json.expires_in * 1000)
      : null
  } catch {
    return null
  }
}

async function errorMessage(response) {
  try {
    const json = await response.json()

    return typeof json.error === 'string' ? `(${json.error})` : ''
  } catch {
    return ''
  }
}

function parseWorkerUrl(value) {
  try {
    const url = new URL(value)

    return url.protocol === 'https:' ||
      (url.protocol === 'http:' && url.hostname === 'localhost')
      ? url.origin
      : null
  } catch {
    return null
  }
}

function fail(message) {
  console.error(message)
  return 1
}
