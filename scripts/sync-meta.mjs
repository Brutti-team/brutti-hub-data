#!/usr/bin/env node
// Read-only Meta sync for brutti-hub-data.
// Ports syncMetaInsights from the Apps Script backend (Code.gs):
//   Facebook: /{page}/published_posts + post insights (post_media_view, post_total_media_view_unique, lifetime)
//   Instagram: /{ig-user}/media + media insights (views, reach, shares, saved, total_interactions)
// Only GET requests are made (plus Graph batch POST, which wraps GETs). No publish endpoints.
// The token is sent in an Authorization header and never logged or written to disk.
//
// Env:
//   META_PAGE_ACCESS_TOKEN, META_PAGE_ID, META_INSTAGRAM_USER_ID (optional), META_GRAPH_VERSION (default v23.0)
//   LOOKBACK_DAYS   how far back to refresh posts + metrics each run (default 90)
//   DRY_RUN=1       do everything but write nothing
//   MOCK_GRAPH=path use a JSON fixture instead of the network (for validation)
import { readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const META_DIR = path.join(ROOT, 'meta')
const RECENT_DAYS = 400
const MAX_RECENT_PER_PLATFORM = 1500
const CAPTION_MAX = 220
const STYLE_LIBRARY_SIZE = 50
const FB_METRICS = ['post_media_view', 'post_total_media_view_unique']
const IG_METRICS = 'views,reach,shares,saved,total_interactions'
const PAGE_LIMIT = 25
const MAX_PAGES = 40
const BATCH_SIZE = 10

const env = process.env
const TOKEN = env.META_PAGE_ACCESS_TOKEN || ''
const PAGE_ID = env.META_PAGE_ID || ''
const IG_ID = env.META_INSTAGRAM_USER_ID || ''
const VERSION = env.META_GRAPH_VERSION || 'v23.0'
const LOOKBACK_DAYS = Number(env.LOOKBACK_DAYS) > 0 ? Number(env.LOOKBACK_DAYS) : 90
const DRY_RUN = env.DRY_RUN === '1'
const MOCK = env.MOCK_GRAPH || ''
const NOW = new Date(env.SYNC_NOW || Date.now())

const redact = (text) => {
  let out = String(text || '')
  if (TOKEN) out = out.split(TOKEN).join('[hidden]')
  return out.replace(/access_token=[^&\s"]+/gi, 'access_token=[hidden]').replace(/EAA[A-Za-z0-9]{20,}/g, '[hidden]').slice(0, 300)
}
const log = (...args) => console.log(...args.map((a) => redact(typeof a === 'string' ? a : JSON.stringify(a))))
const sleep = (ms) => (MOCK ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)))

class GraphError extends Error {
  constructor(message, code) { super(redact(message)); this.code = code }
}

// ---------- Graph access (GET-only, plus batched GETs) ----------
let mock = null
async function loadMock() {
  if (!MOCK || mock) return
  mock = JSON.parse(await readFile(MOCK, 'utf8'))
}

function mockLookup(relative) {
  const key = relative.replace(/^v[\d.]+\//, '').split('?')[0]
  const query = new URLSearchParams(relative.split('?')[1] || '')
  const after = query.get('after')
  const byKey = mock.responses[key]
  if (byKey === undefined) return { error: { message: `No mock for ${key}`, code: 100 } }
  if (Array.isArray(byKey)) return byKey[after ? Number(after) : 0] || { data: [] }
  return byKey
}

async function graphGet(relative, params = {}) {
  const qs = new URLSearchParams(params).toString()
  const rel = qs ? `${relative}${relative.includes('?') ? '&' : '?'}${qs}` : relative
  if (MOCK) {
    await loadMock()
    const body = mockLookup(rel)
    if (body.error) throw new GraphError(body.error.message || 'Graph error', body.error.code)
    return body
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetch(`https://graph.facebook.com/${rel}`, { headers: { Authorization: `Bearer ${TOKEN}` } })
    const body = await res.json().catch(() => ({}))
    if (res.ok && !body.error) return body
    const code = body?.error?.code
    // 4/17/32/613 are rate limits; retry with backoff.
    if ([4, 17, 32, 613].includes(code) && attempt < 2) { await sleep(5000 * 2 ** attempt); continue }
    throw new GraphError(body?.error?.message || `Graph request failed (${res.status})`, code)
  }
  throw new GraphError('Graph request failed after retries')
}

async function graphBatch(relativeUrls) {
  if (MOCK) {
    await loadMock()
    return relativeUrls.map((url) => ({ code: 200, body: JSON.stringify(mockLookup(url)) }))
  }
  const batch = JSON.stringify(relativeUrls.map((relative_url) => ({ method: 'GET', relative_url })))
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetch('https://graph.facebook.com', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ batch, include_headers: 'false' }).toString(),
    })
    const body = await res.json().catch(() => null)
    if (res.ok && Array.isArray(body)) return body
    if (attempt < 2) await sleep(1500 * 2 ** attempt)
  }
  return relativeUrls.map(() => null) // metrics stay as before; retried next run
}

function nextRelative(next) {
  if (!next) return ''
  const m = String(next).match(/^https:\/\/graph\.facebook\.com\/(.+?)\?(.*)$/)
  if (!m) return ''
  const q = new URLSearchParams(m[2])
  q.delete('access_token')
  return `${m[1]}?${q.toString()}`
}

// ---------- Value helpers (ported from Code.gs) ----------
const numericOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const insightScalar = (v) => {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number' || typeof v === 'string') return numericOrNull(v)
  if (typeof v === 'object') {
    if (v.value !== undefined && v.value !== null && typeof v.value !== 'object') return numericOrNull(v.value)
    if (v.total !== undefined) return numericOrNull(v.total)
  }
  return null
}
const insightTotalValue = (total) => {
  if (total === null || total === undefined || total === '') return null
  if (typeof total !== 'object') return numericOrNull(total)
  const direct = insightScalar(total.value)
  if (direct !== null && direct !== 0) return direct
  const results = []
  ;(total.breakdowns || []).forEach((b) => (b.results || []).forEach((r) => { const n = insightScalar(r?.value); if (n !== null) results.push(n) }))
  return results.length ? results.reduce((a, b) => a + b, 0) : direct
}
const insightValue = (item) => {
  if (!item) return null
  const fromTotal = insightTotalValue(item.total_value)
  const values = item.values || []
  const fromValues = values.length ? insightScalar(values[values.length - 1].value) : null
  if (fromTotal !== null && fromTotal !== 0) return fromTotal
  if (fromValues !== null && fromValues !== 0) return fromValues
  return fromTotal !== null ? fromTotal : fromValues
}
const metaCount = (f) => (f && f.summary ? numericOrNull(f.summary.total_count) : null)
const engagementTotal = (p) => {
  let total = 0; let any = false
  for (const k of ['reactions', 'comments', 'shares', 'saves']) {
    const n = numericOrNull(p[k]); if (n !== null) { total += n; any = true }
  }
  return any ? total : null
}
const METRIC_KEYS = ['views', 'reach', 'reactions', 'comments', 'shares', 'saves', 'engagement']
const hasMetric = (p) => METRIC_KEYS.some((k) => p[k] !== null && p[k] !== undefined)
const isoUtc = (t) => {
  const d = new Date(String(t || '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  return Number.isNaN(d.getTime()) ? String(t || '') : d.toISOString().replace('.000Z', '+00:00').replace('Z', '+00:00')
}
const createdMs = (p) => { const n = new Date(p.createdTime).getTime(); return Number.isFinite(n) ? n : 0 }

// ---------- Fetchers ----------
async function walk(firstRelative, params, stopBeforeMs) {
  const items = []
  let rel = firstRelative; let first = true; let pages = 0
  while (rel && pages < MAX_PAGES) {
    const body = await graphGet(rel, first ? params : {})
    first = false; pages += 1
    const data = body.data || []
    items.push(...data)
    const oldest = data.reduce((min, d) => Math.min(min, new Date(d.created_time || d.timestamp || 0).getTime() || min), Infinity)
    if (oldest < stopBeforeMs) break
    rel = body.paging?.next ? nextRelative(body.paging.next) : (MOCK && body.paging?.after ? `${firstRelative.split('?')[0]}?after=${body.paging.after}` : '')
    await sleep(500)
  }
  return items.filter((d) => new Date(d.created_time || d.timestamp || 0).getTime() >= stopBeforeMs)
}

async function fetchFacebook(sinceMs, unavailable) {
  const fields = 'id,message,created_time,permalink_url,attachments{media_type,type},reactions.summary(true),comments.summary(true),shares'
  const raw = await walk(`${VERSION}/${encodeURIComponent(PAGE_ID)}/published_posts`, { fields, limit: String(PAGE_LIMIT) }, sinceMs)
  const metrics = {}
  for (let i = 0; i < raw.length; i += BATCH_SIZE) {
    const chunk = raw.slice(i, i + BATCH_SIZE)
    const res = await graphBatch(chunk.map((p) => `${VERSION}/${encodeURIComponent(p.id)}/insights?metric=${encodeURIComponent(FB_METRICS.join(','))}&period=lifetime`))
    chunk.forEach((p, idx) => {
      const out = {}
      try { (JSON.parse(res[idx]?.body || '{}').data || []).forEach((e) => { out[e.name] = insightValue(e) }) } catch { /* blank */ }
      FB_METRICS.forEach((n) => { if (out[n] === undefined) { out[n] = null; unavailable[n] = true } })
      metrics[p.id] = out
    })
    await sleep(1000)
  }
  return raw.map((p) => {
    const m = metrics[p.id] || {}
    const att = p.attachments?.data?.[0]
    const post = {
      sourceId: String(p.id || ''), platform: 'facebook', createdTime: isoUtc(p.created_time), message: String(p.message || '').slice(0, CAPTION_MAX),
      permalink: p.permalink_url || '', format: att ? (att.media_type || att.type || 'post') : 'post',
      views: m.post_media_view ?? null, reach: m.post_total_media_view_unique ?? null,
      reactions: metaCount(p.reactions), comments: metaCount(p.comments), shares: p.shares ? numericOrNull(p.shares.count) : null, saves: null,
    }
    post.engagement = engagementTotal(post)
    return post
  }).filter((p) => p.sourceId && (hasMetric(p) || p.message))
}

async function fetchInstagram(sinceMs, unavailable) {
  if (!IG_ID) return []
  const fields = 'id,caption,media_type,permalink,timestamp,like_count,comments_count'
  const raw = await walk(`${VERSION}/${encodeURIComponent(IG_ID)}/media`, { fields, limit: String(PAGE_LIMIT) }, sinceMs)
  const metrics = {}
  for (let i = 0; i < raw.length; i += BATCH_SIZE) {
    const chunk = raw.slice(i, i + BATCH_SIZE)
    const res = await graphBatch(chunk.map((p) => `${VERSION}/${encodeURIComponent(p.id)}/insights?metric=${encodeURIComponent(IG_METRICS)}`))
    chunk.forEach((p, idx) => {
      const out = { views: null, reach: null, shares: null, saves: null, engagement: null }
      try {
        const body = JSON.parse(res[idx]?.body || '{}')
        if (body.error) unavailable.instagram = true
        ;(body.data || []).forEach((e) => {
          const v = insightValue(e)
          if (e.name === 'views') out.views = v
          if (e.name === 'reach') out.reach = v
          if (e.name === 'shares') out.shares = v
          if (e.name === 'saved') out.saves = v
          if (e.name === 'total_interactions') out.engagement = v
        })
      } catch { unavailable.instagram = true }
      metrics[p.id] = out
    })
    await sleep(1000)
  }
  return raw.map((p) => {
    const m = metrics[p.id] || {}
    const post = {
      sourceId: String(p.id || ''), platform: 'instagram', createdTime: isoUtc(p.timestamp), message: String(p.caption || '').slice(0, CAPTION_MAX),
      permalink: p.permalink || '', format: String(p.media_type || 'post').toLowerCase(),
      views: m.views ?? null, reach: m.reach ?? null, reactions: numericOrNull(p.like_count), comments: numericOrNull(p.comments_count),
      shares: m.shares ?? null, saves: m.saves ?? null,
    }
    post.engagement = m.engagement !== null && m.engagement !== undefined ? m.engagement : engagementTotal(post)
    return post
  }).filter((p) => p.sourceId && (hasMetric(p) || p.message))
}

// ---------- Data files ----------
async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')) }

async function loadExisting() {
  const files = (await readdir(META_DIR)).filter((f) => /^posts-(recent|archive-\d{4})\.json$/.test(f))
  const byId = new Map()
  for (const f of files) {
    const data = await readJson(path.join(META_DIR, f))
    for (const p of data.posts || []) byId.set(p.sourceId, p)
  }
  return { byId, files }
}

const sameMetrics = (a, b) => ['message', 'permalink', 'format', ...METRIC_KEYS].every((k) => (a[k] ?? null) === (b[k] ?? null))
const byPlatform = (list) => list.reduce((acc, p) => { acc[p.platform] = (acc[p.platform] || 0) + 1; return acc }, {})
const rankValue = (p) => { for (const k of ['engagement', 'reach', 'reactions', 'views']) if (p[k] !== null && p[k] !== undefined) return p[k]; return 0 }
const stripVolatile = (obj) => { const { exportedAt, cutoff, ...rest } = obj; return rest }

async function writeIfChanged(file, data, changed) {
  const target = path.join(META_DIR, file)
  let prev = null
  try { prev = await readJson(target) } catch { /* new file */ }
  if (prev && JSON.stringify(stripVolatile(prev)) === JSON.stringify(stripVolatile(data))) return false
  changed.push(file)
  if (!DRY_RUN) await writeFile(target, `${JSON.stringify(data, null, 2)}\n`)
  return true
}

function styleSignals(text) {
  const t = String(text || '').trim()
  return {
    lineCount: t ? t.split(/\n+/).filter(Boolean).length : 0,
    question: /\?/.test(t),
    firstPerson: /\b(kami|kita|saya|aku)\b/i.test(t),
    sabahanCasual: /\b(bah|ba|kan|ndak|mau|kasi|bikin|macam|suda|pun)\b/i.test(t),
    reflective: /\b(belajar|ingat|cerita|perjalanan|syukur|bangga|terharu|silap|salah)\b/i.test(t),
    practical: /\b(tips?|cara|senang|boleh|guna|pilih|ruang|fungsi)\b/i.test(t),
  }
}

async function checkToken() {
  try {
    await graphGet(`${VERSION}/${encodeURIComponent(PAGE_ID)}`, { fields: 'id' })
    return 'valid'
  } catch (error) {
    return /expired|invalid|session|oauth|permission|token/i.test(error.message) || [102, 190, 200, 210].includes(error.code) ? 'expired' : 'error'
  }
}

async function main() {
  if (!MOCK && (!TOKEN || !PAGE_ID)) {
    console.error('META_PAGE_ACCESS_TOKEN and META_PAGE_ID secrets are required. Nothing was changed.')
    process.exit(1)
  }
  const nowIso = NOW.toISOString()
  const sinceMs = NOW.getTime() - LOOKBACK_DAYS * 86400000
  const tokenStatus = await checkToken()
  const changed = []
  const statusPrev = await readJson(path.join(META_DIR, 'status.json')).catch(() => ({}))

  if (tokenStatus !== 'valid') {
    log(`Token check: ${tokenStatus}. Post files left unchanged.`)
    await writeIfChanged('status.json', { ...statusPrev, exportedAt: nowIso, tokenStatus, tokenCheckedAt: statusPrev.tokenStatus === tokenStatus ? statusPrev.tokenCheckedAt || nowIso : nowIso }, changed)
    log(`Changed files: ${changed.join(', ') || 'none'}`)
    process.exit(tokenStatus === 'expired' ? 2 : 1)
  }

  const unavailable = {}
  const fetched = [...await fetchFacebook(sinceMs, unavailable), ...await fetchInstagram(sinceMs, unavailable)]
  const { byId } = await loadExisting()
  let added = 0; let updated = 0
  for (const p of fetched) {
    const prev = byId.get(p.sourceId)
    if (!prev) { byId.set(p.sourceId, { ...p, syncedAt: nowIso }); added += 1; continue }
    // Keep older metric values when Meta returned nothing this run.
    const merged = { ...prev }
    for (const k of Object.keys(p)) if (p[k] !== null && p[k] !== undefined && p[k] !== '') merged[k] = p[k]
    if (!sameMetrics(prev, merged)) { merged.syncedAt = nowIso; byId.set(p.sourceId, merged); updated += 1 }
  }

  const all = [...byId.values()].sort((a, b) => createdMs(b) - createdMs(a))
  const cutoffMs = NOW.getTime() - RECENT_DAYS * 86400000
  const recent = []; const archives = new Map(); const perPlatform = {}
  for (const p of all) {
    const ms = createdMs(p)
    perPlatform[p.platform] = perPlatform[p.platform] || 0
    if (ms >= cutoffMs && perPlatform[p.platform] < MAX_RECENT_PER_PLATFORM) { recent.push(p); perPlatform[p.platform] += 1; continue }
    const year = new Date(ms).getUTCFullYear()
    if (!archives.has(year)) archives.set(year, [])
    archives.get(year).push(p)
  }
  const sourceUpdatedAt = all.reduce((max, p) => (p.syncedAt && p.syncedAt > max ? p.syncedAt : max), '') || null

  await writeIfChanged('posts-recent.json', {
    exportedAt: nowIso, sourceUpdatedAt, windowDays: RECENT_DAYS, cutoff: new Date(cutoffMs).toISOString(), maxPerPlatform: MAX_RECENT_PER_PLATFORM,
    captionMaxChars: CAPTION_MAX, count: recent.length, byPlatform: byPlatform(recent), posts: recent,
  }, changed)
  const archiveCounts = {}
  for (const year of [...archives.keys()].sort()) {
    const list = archives.get(year).sort((a, b) => createdMs(a) - createdMs(b))
    archiveCounts[year] = list.length
    await writeIfChanged(`posts-archive-${year}.json`, { exportedAt: nowIso, year, count: list.length, byPlatform: byPlatform(list), captionMaxChars: CAPTION_MAX, posts: list }, changed)
  }
  const style = all.filter((p) => String(p.message || '').trim()).sort((a, b) => rankValue(b) - rankValue(a) || createdMs(b) - createdMs(a)).slice(0, STYLE_LIBRARY_SIZE)
    .map((p, i) => ({ rank: i + 1, platform: p.platform, format: p.format, caption: p.message, reactions: p.reactions, engagement: p.engagement, createdTime: p.createdTime, permalink: p.permalink, styleSignals: styleSignals(p.message) }))
  await writeIfChanged('style-library.json', { exportedAt: nowIso, count: style.length, items: style }, changed)

  const postsChanged = changed.length > 0
  const status = {
    exportedAt: postsChanged ? nowIso : statusPrev.exportedAt || nowIso,
    sourceUpdatedAt,
    syncedPostCount: all.length,
    recentPostCount: recent.length,
    facebook: { count: all.filter((p) => p.platform === 'facebook').length },
    instagram: { count: all.filter((p) => p.platform === 'instagram').length },
    archiveCounts,
    lookbackDays: LOOKBACK_DAYS,
    unavailableMetrics: Object.keys(unavailable).sort(),
    tokenStatus,
    tokenCheckedAt: statusPrev.tokenStatus === tokenStatus && !postsChanged ? statusPrev.tokenCheckedAt || nowIso : nowIso,
  }
  if (postsChanged || statusPrev.tokenStatus !== tokenStatus) await writeIfChanged('status.json', status, changed)
  log(`Fetched ${fetched.length} posts (new ${added}, updated ${updated}). Total ${all.length}, recent ${recent.length}.`)
  log(`${DRY_RUN ? '[dry run] Would change' : 'Changed'} files: ${changed.join(', ') || 'none'}`)
}

main().catch((error) => { console.error(`Meta sync failed: ${redact(error.message)}`); process.exit(1) })
