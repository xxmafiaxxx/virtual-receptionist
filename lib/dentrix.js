import { adminDb } from './firebase-admin'
import { decryptSecret } from './secret-crypto'

const TIMEOUT_MS = 8000

// Bridge URL/token live encrypted in users/{uid}/private/integration-secrets
// (saved from Admin → Connectors → Dentrix), with env fallback for headless setups.
export async function dentrixConfig(uid) {
  let url = process.env.DENTRIX_BRIDGE_URL || ''
  let token = process.env.DENTRIX_BRIDGE_TOKEN || ''
  try {
    const snap = await adminDb.doc(`users/${uid}/private/integration-secrets`).get()
    const secrets = snap.data()?.secrets || {}
    url = decryptSecret(secrets.dentrixBridgeUrl) || url
    token = decryptSecret(secrets.dentrixBridgeToken) || token
  } catch {}
  return { url: String(url).replace(/\/+$/, ''), token }
}

export async function bridgeFetch(config, path) {
  if (!config.url || !config.token) {
    return {
      status: 503,
      body: { error: 'The Dentrix bridge is not configured yet. Open Connectors → Dentrix, save the bridge URL and token, then test again.' },
    }
  }
  try {
    const res = await fetch(config.url + path, {
      headers: { Authorization: `Bearer ${config.token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const body = await res.json().catch(() => ({}))
    return { status: res.status, body }
  } catch {
    return {
      status: 502,
      body: { error: 'The Dentrix bridge is unreachable. Confirm the bridge is running on the practice machine (npm start) and the tunnel is up.' },
    }
  }
}
