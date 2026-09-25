// Warns before the Workers Free plan's daily limits run out. The worker can't
// see those counters itself, so it asks Cloudflare's GraphQL analytics API
// for today's usage across the whole account.

interface Env {
  TOKEN_STORE?: KVNamespace
  CF_ACCOUNT_ID?: string
  CF_API_TOKEN?: string
}

interface Limit {
  kind: 'requests' | 'kvWrites'
  label: string
  daily: number
  alertBelow: number
}

// Per account, reset at 00:00 UTC
const LIMITS: Limit[] = [
  {
    kind: 'requests',
    label: 'Worker requests',
    daily: 100_000,
    alertBelow: 1_000,
  },
  { kind: 'kvWrites', label: 'KV writes', daily: 1_000, alertBelow: 150 },
]

const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql'
const USAGE_QUERY = `query Usage($accountTag: string!, $start: string!, $date: string!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $start }) {
        sum { requests }
      }
      kvOperationsAdaptiveGroups(limit: 10000, filter: { date_geq: $date, date_leq: $date }) {
        sum { requests }
        dimensions { actionType }
      }
    }
  }
}`

interface UsageResponse {
  data?: {
    viewer?: {
      accounts?: Array<{
        workersInvocationsAdaptive?: Array<{ sum: { requests: number } }>
        kvOperationsAdaptiveGroups?: Array<{
          sum: { requests: number }
          dimensions: { actionType: string }
        }>
      }>
    }
  }
  errors?: Array<{ message?: string }>
}

// Returns the messages to post: at most one per limit and day, plus one per
// day if the check itself fails. Without CF_ACCOUNT_ID and CF_API_TOKEN the
// check is skipped.
export async function usageAlerts(env: Env, now: Date): Promise<string[]> {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN || !env.TOKEN_STORE) {
    return []
  }

  const date = now.toISOString().slice(0, 10)
  let used: Record<Limit['kind'], number>

  try {
    used = await fetchUsage(env.CF_ACCOUNT_ID, env.CF_API_TOKEN, date)
  } catch (e) {
    console.error(`Usage check failed: ${e}`)

    return (await firstToday(env.TOKEN_STORE, 'check-failed', date))
      ? [`Usage check failed: \`${e}\``]
      : []
  }

  console.log(
    `Usage today: ${used.requests} Worker requests, ${used.kvWrites} KV writes`,
  )

  const messages: string[] = []

  for (const limit of LIMITS) {
    const left = Math.max(limit.daily - used[limit.kind], 0)

    if (
      left < limit.alertBelow &&
      (await firstToday(env.TOKEN_STORE, limit.kind, date))
    ) {
      messages.push(
        `Only ${format(left)} of ${format(limit.daily)} ${limit.label} left today across the Cloudflare account (resets at 00:00 UTC).`,
      )
    }
  }

  return messages
}

async function fetchUsage(
  accountTag: string,
  apiToken: string,
  date: string,
): Promise<Record<Limit['kind'], number>> {
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: USAGE_QUERY,
      variables: { accountTag, start: `${date}T00:00:00Z`, date },
    }),
  })

  if (!response.ok) {
    throw new Error(
      `Invalid status from Cloudflare analytics: ${response.status}`,
    )
  }

  const json = await response.json<UsageResponse>()

  if (json.errors?.length) {
    throw new Error(
      `Cloudflare analytics: ${json.errors[0].message ?? 'unknown error'}`,
    )
  }

  const account = json.data?.viewer?.accounts?.[0]

  if (!account) {
    throw new Error('Cloudflare analytics returned no account')
  }

  return {
    requests: sum(account.workersInvocationsAdaptive ?? []),
    kvWrites: sum(
      (account.kvOperationsAdaptiveGroups ?? []).filter(
        (group) => group.dimensions.actionType === 'write',
      ),
    ),
  }
}

function sum(groups: Array<{ sum: { requests: number } }>) {
  return groups.reduce((total, group) => total + group.sum.requests, 0)
}

// True the first time it's asked for a kind on a date. The marker is written
// while the KV write alert still has 150 writes left, so it doesn't compete
// with the writes it warns about; if writing it fails anyway, the alert may
// repeat every 15 minutes.
async function firstToday(store: KVNamespace, kind: string, date: string) {
  const key = `usage-alert:${kind}:${date}`

  if (await store.get(key)) {
    return false
  }

  try {
    await store.put(key, '1', { expirationTtl: 2 * 24 * 3600 })
  } catch (e) {
    console.error(`Failed to store the usage alert marker: ${e}`)
  }

  return true
}

function format(value: number) {
  return value.toLocaleString('en-US')
}
