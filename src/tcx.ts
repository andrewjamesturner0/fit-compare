import type { FitSession, FitRecord, Lap, ParseResult } from './types'

/**
 * TCX (Garmin Training Center XML) parser. Produces the same ParseResult /
 * FitSession shape as the .fit parser so the rest of the pipeline (resample,
 * align, stats, graph) treats both formats identically.
 *
 * Power and speed live inside <Trackpoint><Extensions><TPX> in the
 * ActivityExtension v2 namespace (typically prefixed `ns3:`). The parser
 * matches by local name only, so any prefix works.
 */

function directChildByLocalName(parent: Element, localName: string): Element | null {
  for (let i = 0; i < parent.children.length; i++) {
    const c = parent.children[i]
    if (c.localName === localName) return c
  }
  return null
}

function directChildText(parent: Element, localName: string): string | null {
  return directChildByLocalName(parent, localName)?.textContent ?? null
}

function parseNum(s: string | null | undefined): number | null {
  if (s == null) return null
  const trimmed = s.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

function extractRecord(tp: Element): FitRecord | null {
  const timeText = directChildText(tp, 'Time')
  if (!timeText) return null
  const timestamp = Date.parse(timeText)
  if (Number.isNaN(timestamp)) return null

  const hrEl = directChildByLocalName(tp, 'HeartRateBpm')
  const heartRate = hrEl ? parseNum(directChildText(hrEl, 'Value')) : null

  let power: number | null = null
  let speed: number | null = null
  const ext = directChildByLocalName(tp, 'Extensions')
  if (ext) {
    let tpx: Element | null = null
    for (let i = 0; i < ext.children.length; i++) {
      if (ext.children[i].localName === 'TPX') {
        tpx = ext.children[i]
        break
      }
    }
    if (tpx) {
      power = parseNum(directChildText(tpx, 'Watts'))
      speed = parseNum(directChildText(tpx, 'Speed'))
    }
  }

  return {
    timestamp,
    power,
    cadence: parseNum(directChildText(tp, 'Cadence')),
    heartRate,
    speed,
    distance: parseNum(directChildText(tp, 'DistanceMeters')),
    elevation: parseNum(directChildText(tp, 'AltitudeMeters')),
    temperature: null,
  }
}

export async function parseTcxFile(file: Blob): Promise<ParseResult> {
  try {
    const text = await file.text()
    const doc = new DOMParser().parseFromString(text, 'application/xml')
    if (doc.getElementsByTagName('parsererror').length > 0) {
      return { status: 'error', warnings: ['XML parse error'] }
    }

    const activities = doc.getElementsByTagNameNS('*', 'Activity')
    if (activities.length === 0) {
      return { status: 'error', warnings: ['No Activity element found in TCX'] }
    }
    const activity = activities[0]

    const sport = activity.getAttribute('Sport') ?? 'unknown'

    const idText = directChildText(activity, 'Id')
    let startTime = idText ? Date.parse(idText) : 0
    if (Number.isNaN(startTime)) startTime = 0

    const creator = directChildByLocalName(activity, 'Creator')
    const deviceName = creator
      ? (directChildText(creator, 'Name') ?? 'Unknown Device').trim() || 'Unknown Device'
      : 'Unknown Device'

    const records: FitRecord[] = []
    const laps: Lap[] = []
    for (let i = 0; i < activity.children.length; i++) {
      const lap = activity.children[i]
      if (lap.localName !== 'Lap') continue
      const lapStart = Date.parse(lap.getAttribute('StartTime') ?? '')
      laps.push({
        startTime: Number.isNaN(lapStart) ? 0 : lapStart,
        totalElapsedTime: parseNum(directChildText(lap, 'TotalTimeSeconds')) ?? 0,
        totalDistance: parseNum(directChildText(lap, 'DistanceMeters')) ?? 0,
      })
      for (let t = 0; t < lap.children.length; t++) {
        const track = lap.children[t]
        if (track.localName !== 'Track') continue
        for (let c = 0; c < track.children.length; c++) {
          const tp = track.children[c]
          if (tp.localName === 'Trackpoint') {
            const rec = extractRecord(tp)
            if (rec) records.push(rec)
          }
        }
      }
    }

    if (startTime === 0 && records.length > 0) startTime = records[0].timestamp

    const warnings: string[] = []
    if (records.length === 0) warnings.push('No usable records found')
    const hasPower = records.some((r) => r.power !== null)
    if (!hasPower && records.length > 0) warnings.push('No power data found in records')

    const session: FitSession = {
      startTime,
      deviceName,
      manufacturer: 'unknown',
      sport,
      laps,
      records,
    }

    const status = records.length === 0 ? 'warning' : 'ok'
    return { status, session, warnings }
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { status: 'error', warnings: [message] }
  }
}
