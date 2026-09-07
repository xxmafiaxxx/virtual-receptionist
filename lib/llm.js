// Server-side LLM access with an automatic backup chain: the cloud provider
// configured in AI_MODEL_PROVIDER runs first; whenever it is unconfigured,
// unreachable, unauthorized, or out of credits, the local Ollama server
// (LOCAL_MODEL_URL) answers instead. Every caller in the app should go through
// chatCompletion so the backup always applies.

const CLOUD_KEYS = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' }

function cloudProvider() {
  const provider = (process.env.AI_MODEL_PROVIDER || 'openai').toLowerCase()
  const key = process.env[CLOUD_KEYS[provider]] || ''
  if (!CLOUD_KEYS[provider] || key.length <= 20) return null
  return { provider, key }
}

async function callAnthropic({ key, prompt, system, maxTokens, timeoutMs }) {
  const model = process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest'
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }], ...(system ? { system } : {}) }),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error?.message || `Anthropic returned ${r.status}`)
  return { text: (d.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim(), model }
}

async function callOpenAI({ key, prompt, system, maxTokens, timeoutMs }) {
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini'
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }] }),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error?.message || `OpenAI returned ${r.status}`)
  return { text: (d.choices?.[0]?.message?.content || '').trim(), model }
}

export async function localModels(baseUrl, timeoutMs = 5000) {
  const r = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) })
  if (!r.ok) throw new Error(`Ollama returned ${r.status}`)
  return (await r.json()).models?.map((m) => m.name) || []
}

async function callLocal({ prompt, system, maxTokens, timeoutMs }) {
  const base = (process.env.LOCAL_MODEL_URL || '').replace(/\/+$/, '')
  if (!base) throw new Error('LOCAL_MODEL_URL is not configured')
  let model = process.env.LOCAL_MODEL_MODEL
  if (!model) {
    const models = await localModels(base)
    model = models.find((m) => !/embed|bge|nomic/i.test(m)) || models[0]
  }
  if (!model) throw new Error('The local Ollama server has no models installed')
  const r = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model,
      messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }],
      stream: false,
      keep_alive: '30m',
      options: { num_predict: maxTokens },
    }),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error || `Ollama returned ${r.status}`)
  return { text: (d.message?.content || '').trim(), model }
}

// Runs the backup chain. Returns { ok, provider, model, text, ms, fallbackUsed, attempts }.
export async function chatCompletion({ prompt, system, maxTokens = 300, timeoutMs = 90000, prefer } = {}) {
  const t0 = Date.now()
  const attempts = []
  const cloud = prefer === 'local' ? null : cloudProvider()
  if (cloud) {
    try {
      const call = cloud.provider === 'anthropic' ? callAnthropic : callOpenAI
      const out = await call({ key: cloud.key, prompt, system, maxTokens, timeoutMs })
      return { ok: true, provider: cloud.provider, model: out.model, text: out.text, ms: Date.now() - t0, fallbackUsed: false, attempts }
    } catch (e) {
      attempts.push({ provider: cloud.provider, ok: false, error: String(e.message || e) })
    }
  } else if (prefer !== 'local') {
    attempts.push({ provider: process.env.AI_MODEL_PROVIDER || 'openai', ok: false, error: 'No valid API key configured — going straight to the local backup' })
  }
  try {
    // local CPU inference is slow and cold-loads can take minutes, so the backup gets a generous ceiling
    const out = await callLocal({ prompt, system, maxTokens, timeoutMs: Math.max(timeoutMs, 230000) })
    return { ok: true, provider: 'local', model: out.model, text: out.text, ms: Date.now() - t0, fallbackUsed: true, attempts }
  } catch (e) {
    attempts.push({ provider: 'local', ok: false, error: String(e.message || e) })
  }
  return { ok: false, provider: 'none', model: null, text: '', ms: Date.now() - t0, fallbackUsed: true, attempts, error: attempts.map((a) => `${a.provider}: ${a.error}`).join(' | ') }
}

export async function llmStatus() {
  const cloud = cloudProvider()
  const base = (process.env.LOCAL_MODEL_URL || '').replace(/\/+$/, '') || null
  const backup = { url: base, model: process.env.LOCAL_MODEL_MODEL || 'first available', reachable: false, models: [] }
  if (base) {
    try {
      backup.models = await localModels(base, 4000)
      backup.reachable = true
    } catch {}
  }
  return {
    primary: { provider: (process.env.AI_MODEL_PROVIDER || 'openai').toLowerCase(), configured: Boolean(cloud) },
    backup,
  }
}
