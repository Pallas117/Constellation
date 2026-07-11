#!/usr/bin/env node
import 'dotenv/config'
import fs from 'fs'
import path from 'path'

const LOG_DIR = path.resolve(process.cwd(), 'data/agents/logs')
const IN_FILE = path.join(LOG_DIR, 'monitor.jsonl')
const OUT_FILE = path.join(LOG_DIR, 'alerts.jsonl')

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })
if (!fs.existsSync(IN_FILE)) fs.writeFileSync(IN_FILE, '')
if (!fs.existsSync(OUT_FILE)) fs.writeFileSync(OUT_FILE, '')

let lastSize = fs.statSync(IN_FILE).size
const DEDUP_SECONDS = parseInt(process.env.ALERT_DEDUP_SECONDS || '300', 10)
const recentAlerts = new Map()

function scanNew() {
  try {
    const stats = fs.statSync(IN_FILE)
    if (stats.size > lastSize) {
      const rs = fs.createReadStream(IN_FILE, { start: lastSize, end: stats.size - 1, encoding: 'utf8' })
      let buf = ''
      rs.on('data', (chunk) => { buf += chunk })
      rs.on('end', () => {
        const lines = buf.split(/\r?\n/).filter(Boolean)
        const alerts = []
        for (const line of lines) {
          try {
            const obj = JSON.parse(line)
            if (obj.source === 'LinkGuardian' && obj.latencyMs && obj.latencyMs > 200) {
              const a = { ts: new Date().toISOString(), type: 'latency_spike', latencyMs: obj.latencyMs, raw: obj.raw }
              alerts.push(a)
            }
            if (obj.source === 'IngestionWorker' && typeof obj.raw === 'string' && obj.raw.includes('ML Forecast failed')) {
              const a = { ts: new Date().toISOString(), type: 'ml_forecast_failed', raw: obj.raw }
              alerts.push(a)
            }
          } catch (e) {
            // ignore parse errors
          }
        }
        if (alerts.length > 0) {
          const out = alerts.map(a => JSON.stringify(a)).join('\n') + '\n'
          fs.appendFileSync(OUT_FILE, out)
          for (const a of alerts) console.log('ALERT:', a)
          ;(async () => {
            for (const a of alerts) {
              try {
                const key = `${a.type}:${(a.raw || '').slice(0,200)}`
                const now = Date.now()
                const last = recentAlerts.get(key) || 0
                if (now - last < DEDUP_SECONDS * 1000) {
                  console.log('Skipping duplicate alert (dedup):', key)
                  continue
                }
                recentAlerts.set(key, now)
                // send notifications (if configured)
                await sendSlack(a)
                await createLinearIssue(a)
              } catch (e) {
                console.error('error emitting alert notifications', e)
              }
            }
          })()
        }
      })
      lastSize = stats.size
    }
  } catch (err) {
    console.error('scanNew error', err)
  }
}

const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL || process.env.SLACK_WEBHOOK
const LINEAR_API_KEY = process.env.LINEAR_API_KEY
const LINEAR_TEAM_ID = process.env.LINEAR_TEAM_ID

async function sendSlack(alert) {
  if (!SLACK_WEBHOOK) return
  try {
    const body = { text: `Alert: ${alert.type} - ${alert.raw || JSON.stringify(alert)}` }
    const res = await fetch(SLACK_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!res.ok) console.error('Slack webhook failed', await res.text())
    else console.log('Slack notification sent')
  } catch (e) {
    console.error('sendSlack error', e)
  }
}

async function createLinearIssue(alert) {
  if (!LINEAR_API_KEY || !LINEAR_TEAM_ID) return
  try {
    const title = `Alert: ${alert.type}`
    const description = alert.raw || JSON.stringify(alert, null, 2)
    const query = `mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success, issue { id, url } } }`
    const input = { title, description, teamId: LINEAR_TEAM_ID }
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINEAR_API_KEY}` },
      body: JSON.stringify({ query, variables: { input } })
    })
    const j = await res.json()
    if (j.errors) console.error('Linear API error', j.errors)
    else console.log('Linear issue created', j.data && j.data.issueCreate && j.data.issueCreate.issue && j.data.issueCreate.issue.url)
  } catch (e) {
    console.error('createLinearIssue error', e)
  }
}

console.log('Watching', IN_FILE, '->', OUT_FILE)
setInterval(scanNew, 1000)
