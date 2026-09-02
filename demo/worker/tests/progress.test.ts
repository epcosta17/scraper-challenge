import { describe, it, expect } from 'vitest'
import type { JobProgressUpdate } from '@pje/core'
import { createProgressPublisher } from '../src/progress.ts'

function harness(minIntervalMs = 250) {
  const writes: JobProgressUpdate[] = []
  let clock = 1000
  const publisher = createProgressPublisher({
    write: (p) => { writes.push(p) },
    minIntervalMs,
    now: () => clock,
  })
  return { writes, publisher, tick: (ms: number) => { clock += ms } }
}

describe('createProgressPublisher', () => {
  it('writes the first report straight away, so a total appears at once', () => {
    const { writes, publisher } = harness()
    publisher.publish({ done: 0, total: 300 })
    expect(writes).toEqual([{ done: 0, total: 300 }])
  })

  it('holds reports that arrive inside the interval', () => {
    const { writes, publisher, tick } = harness(250)
    publisher.publish({ done: 0, total: 300 })
    tick(50)
    publisher.publish({ done: 1 })
    publisher.publish({ done: 2 })
    expect(writes).toHaveLength(1)
  })

  it('writes the newest held report once the interval has passed', () => {
    const { writes, publisher, tick } = harness(250)
    publisher.publish({ done: 0, total: 300 })
    publisher.publish({ done: 1 })
    publisher.publish({ done: 2 })
    tick(300)
    publisher.publish({ done: 3 })
    // Only the newest count survives; the ones it overtook were never news.
    expect(writes).toEqual([{ done: 0, total: 300 }, { done: 3, total: 300 }])
  })

  it('remembers a total reported once, so later count-only reports keep it', () => {
    const { writes, publisher, tick } = harness(0)
    publisher.publish({ done: 0, total: 5, totalIsEstimate: true })
    tick(1)
    publisher.publish({ done: 1 })
    expect(writes[1]).toEqual({ done: 1, total: 5, totalIsEstimate: true })
  })

  it('flushes whatever it is holding, so the last count is never lost', () => {
    const { writes, publisher, tick } = harness(250)
    publisher.publish({ done: 0, total: 3 })
    tick(10)
    publisher.publish({ done: 3 })
    publisher.flush()
    expect(writes).toEqual([{ done: 0, total: 3 }, { done: 3, total: 3 }])
  })

  it('flushing twice writes nothing the second time', () => {
    const { writes, publisher } = harness(250)
    publisher.publish({ done: 0, total: 3 })
    publisher.publish({ done: 3 })
    publisher.flush()
    publisher.flush()
    expect(writes).toHaveLength(2)
  })

  it('flushes nothing at all when nothing was ever published', () => {
    const { writes, publisher } = harness()
    publisher.flush()
    expect(writes).toEqual([])
  })

  it('carries the stage through, and never holds a change of it back', () => {
    const written: JobProgressUpdate[] = []
    let clock = 0
    const pub = createProgressPublisher({
      write: (p) => { written.push(p) },
      minIntervalMs: 250,
      now: () => clock,
    })

    pub.publish({ done: 0, total: null })
    clock = 10
    // Inside the interval, so the count alone would be held. The stage is not
    // a count: these arrive maybe six times in a whole case, and each one is
    // the answer to "is this thing still alive?" for however long the step
    // takes. Holding one back until the *next* step is exactly as useless as
    // not sending it — by then it is describing the past.
    pub.publish({ done: 0, stage: 'fetching the summary PDF' })
    expect(written).toHaveLength(2)
    expect(written[1]).toMatchObject({ stage: 'fetching the summary PDF' })

    // A repeat of the same stage is not news, and goes back to being throttled
    // like any other count.
    clock = 20
    pub.publish({ done: 1, stage: 'fetching the summary PDF' })
    expect(written).toHaveLength(2)

    // A stage set once keeps being reported with later counts, so every write
    // is a complete statement of where the job is.
    clock = 400
    pub.publish({ done: 2 })
    expect(written[2]).toMatchObject({ done: 2, stage: 'fetching the summary PDF' })

    // And clearing it is a change like any other: it goes out at once.
    clock = 410
    pub.publish({ done: 2, stage: null })
    expect(written[3]).toMatchObject({ stage: null })
  })
})
