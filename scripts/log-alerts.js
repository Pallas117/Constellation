#!/usr/bin/env node
import 'dotenv/config'
import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Alerts stay on this machine: alerts.jsonl and the console. With ALERTS_VIA_ARGO=1 each
// alert also goes to the phone through Argo (`argo notify`): masked, rate-limited, queued
// while offline and logged on this Mac (`argo egress`). Raw log lines never leave.

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
                await notifyArgo(a)
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

const VIA_ARGO = process.env.ALERTS_VIA_ARGO === '1'
const ARGO = process.env.ARGO || path.join(os.homedir(), '.local/bin/argo')

// argoArgs names the alert without the log line it came from.
function argoArgs(alert) {
  const what = alert.type === 'latency_spike' ? `link latency ${Number(alert.latencyMs)} ms` : 'the ML forecast failed'
  return ['notify', '-key', `gauss-${alert.type.replace(/_/g, '-')}`, '-every', '30m', 'Gauss backend', what]
}

function notifyArgo(alert) {
  if (!VIA_ARGO) return Promise.resolve()
  return new Promise((resolve) => {
    execFile(ARGO, argoArgs(alert), { timeout: 60_000 }, (err) => {
      if (err) console.error('argo notify failed:', err.message)
      resolve()
    })
  })
}

console.log('Watching', IN_FILE, '->', OUT_FILE)
setInterval(scanNew, 1000)
