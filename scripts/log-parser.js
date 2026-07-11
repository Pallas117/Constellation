#!/usr/bin/env node
import fs from 'fs'
import path from 'path'

const LOG_DIR = path.resolve(process.cwd(), 'data/agents/logs')
const LOG_FILE = path.join(LOG_DIR, 'backend.log')
const OUT_FILE = path.join(LOG_DIR, 'monitor.jsonl')

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '')
if (!fs.existsSync(OUT_FILE)) fs.writeFileSync(OUT_FILE, '')

let lastSize = fs.statSync(LOG_FILE).size

function parseLine(line) {
  const t = new Date().toISOString()
  if (line.includes('[LinkGuardian]')) {
    const m = line.match(/Mode:\s*(\w+),\s*Latency:\s*(-?\d+)ms/)
    return JSON.stringify({ ts: t, source: 'LinkGuardian', raw: line.trim(), mode: m ? m[1] : null, latencyMs: m ? Number(m[2]) : null })
  }
  if (line.includes('[IngestionWorker]')) {
    const m = line.match(/\[IngestionWorker\](.*)/)
    return JSON.stringify({ ts: t, source: 'IngestionWorker', raw: (m ? m[1] : line).trim() })
  }
  // Generic fallback: emit lines of interest
  if (line.trim().length > 0) return JSON.stringify({ ts: t, source: 'backend', raw: line.trim() })
  return null
}

function scanNew() {
  try {
    const stats = fs.statSync(LOG_FILE)
    if (stats.size > lastSize) {
      const rs = fs.createReadStream(LOG_FILE, { start: lastSize, end: stats.size - 1, encoding: 'utf8' })
      let buf = ''
      rs.on('data', (chunk) => { buf += chunk })
      rs.on('end', () => {
        const lines = buf.split(/\r?\n/)
        const out = []
        for (const line of lines) {
          const parsed = parseLine(line)
          if (parsed) out.push(parsed)
        }
        if (out.length > 0) fs.appendFileSync(OUT_FILE, out.join('\n') + '\n')
      })
      lastSize = stats.size
    }
  } catch (err) {
    console.error('scanNew error', err)
  }
}

console.log('Watching', LOG_FILE, '->', OUT_FILE)
setInterval(scanNew, 1500)
