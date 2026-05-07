import { describe, it, expect } from 'vitest'
import { parseTcxFile } from './tcx'

function makeBlob(xml: string): Blob {
  return new Blob([xml], { type: 'application/xml' })
}

const TCX_HEAD = `<?xml version="1.0" encoding="utf-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Activities>
    <Activity Sport="Biking">
      <Id>2024-06-15T10:30:00Z</Id>`

const TCX_TAIL = `      <Creator xsi:type="Application_t">
        <Name>TrainerRoad</Name>
      </Creator>
    </Activity>
  </Activities>
</TrainingCenterDatabase>`

function trackpoint(time: string, opts: {
  hr?: number
  cadence?: number
  watts?: number
  speed?: number
  distance?: number
  altitude?: number
}): string {
  const parts: string[] = [`<Time>${time}</Time>`]
  if (opts.hr !== undefined) parts.push(`<HeartRateBpm><Value>${opts.hr}</Value></HeartRateBpm>`)
  if (opts.cadence !== undefined) parts.push(`<Cadence>${opts.cadence}</Cadence>`)
  if (opts.distance !== undefined) parts.push(`<DistanceMeters>${opts.distance}</DistanceMeters>`)
  if (opts.altitude !== undefined) parts.push(`<AltitudeMeters>${opts.altitude}</AltitudeMeters>`)
  if (opts.watts !== undefined || opts.speed !== undefined) {
    const tpx: string[] = []
    if (opts.watts !== undefined) tpx.push(`<ns3:Watts>${opts.watts}</ns3:Watts>`)
    if (opts.speed !== undefined) tpx.push(`<ns3:Speed>${opts.speed}</ns3:Speed>`)
    parts.push(`<Extensions><ns3:TPX>${tpx.join('')}</ns3:TPX></Extensions>`)
  }
  return `<Trackpoint>${parts.join('')}</Trackpoint>`
}

function makeTcx(trackpoints: string[], opts?: { startTime?: string; lapCount?: number }): string {
  const startTime = opts?.startTime ?? '2024-06-15T10:30:00Z'
  const lap = `<Lap StartTime="${startTime}">
    <TotalTimeSeconds>${trackpoints.length}</TotalTimeSeconds>
    <DistanceMeters>0</DistanceMeters>
    <Track>${trackpoints.join('')}</Track>
  </Lap>`
  return TCX_HEAD + lap.repeat(opts?.lapCount ?? 1) + TCX_TAIL
}

describe('parseTcxFile', () => {
  it('parses trackpoints with all fields', async () => {
    const xml = makeTcx([
      trackpoint('2024-06-15T10:30:00Z', { hr: 150, cadence: 90, watts: 200, speed: 8.5, distance: 0, altitude: 50 }),
      trackpoint('2024-06-15T10:30:01Z', { hr: 152, cadence: 91, watts: 210, speed: 8.6, distance: 8.5, altitude: 50 }),
    ])
    const result = await parseTcxFile(makeBlob(xml))

    expect(result.status).toBe('ok')
    expect(result.warnings).toHaveLength(0)
    expect(result.session!.records).toHaveLength(2)

    const r0 = result.session!.records[0]
    expect(r0.timestamp).toBe(Date.parse('2024-06-15T10:30:00Z'))
    expect(r0.heartRate).toBe(150)
    expect(r0.cadence).toBe(90)
    expect(r0.power).toBe(200)
    expect(r0.speed).toBe(8.5)
    expect(r0.elevation).toBe(50)
    expect(r0.distance).toBe(0)
    expect(r0.temperature).toBeNull()
  })

  it('extracts metadata: sport, deviceName, startTime', async () => {
    const xml = makeTcx([trackpoint('2024-06-15T10:30:00Z', { watts: 200 })])
    const result = await parseTcxFile(makeBlob(xml))

    expect(result.session!.sport).toBe('Biking')
    expect(result.session!.deviceName).toBe('TrainerRoad')
    expect(result.session!.startTime).toBe(Date.parse('2024-06-15T10:30:00Z'))
  })

  it('handles missing power on a trackpoint as null', async () => {
    const xml = makeTcx([
      trackpoint('2024-06-15T10:30:00Z', { hr: 100 }),
      trackpoint('2024-06-15T10:30:01Z', { hr: 102, watts: 150 }),
    ])
    const result = await parseTcxFile(makeBlob(xml))

    expect(result.session!.records[0].power).toBeNull()
    expect(result.session!.records[1].power).toBe(150)
  })

  it('warns when no power data is found', async () => {
    const xml = makeTcx([
      trackpoint('2024-06-15T10:30:00Z', { hr: 100, cadence: 80 }),
    ])
    const result = await parseTcxFile(makeBlob(xml))

    expect(result.status).toBe('ok')
    expect(result.warnings).toContain('No power data found in records')
  })

  it('warns when no records exist', async () => {
    const xml = makeTcx([])
    const result = await parseTcxFile(makeBlob(xml))

    expect(result.status).toBe('warning')
    expect(result.warnings).toContain('No usable records found')
  })

  it('returns error on malformed XML', async () => {
    const result = await parseTcxFile(makeBlob('<not><closed>'))
    expect(result.status).toBe('error')
  })

  it('returns error when no Activity element is present', async () => {
    const result = await parseTcxFile(makeBlob('<?xml version="1.0"?><root/>'))
    expect(result.status).toBe('error')
    expect(result.warnings[0]).toContain('No Activity element')
  })

  it('combines records across multiple Lap elements', async () => {
    const xml = makeTcx(
      [
        trackpoint('2024-06-15T10:30:00Z', { watts: 100 }),
        trackpoint('2024-06-15T10:30:01Z', { watts: 110 }),
      ],
      { lapCount: 3 },
    )
    const result = await parseTcxFile(makeBlob(xml))

    expect(result.session!.records).toHaveLength(6)
    expect(result.session!.laps).toHaveLength(3)
  })

  it('falls back to first record timestamp when Activity Id is missing or unparseable', async () => {
    const xml = TCX_HEAD.replace('<Id>2024-06-15T10:30:00Z</Id>', '<Id>not-a-date</Id>')
      + `<Lap StartTime="bogus"><TotalTimeSeconds>1</TotalTimeSeconds><DistanceMeters>0</DistanceMeters><Track>${trackpoint('2024-06-15T10:30:00Z', { watts: 200 })}</Track></Lap>`
      + TCX_TAIL
    const result = await parseTcxFile(makeBlob(xml))

    expect(result.session!.startTime).toBe(Date.parse('2024-06-15T10:30:00Z'))
  })
})
