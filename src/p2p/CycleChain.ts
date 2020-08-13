import { Logger } from 'log4js'
import { crypto, logger } from './Context'
import { CycleRecord } from './CycleCreator'
import { nodes } from './NodeList'
import { LooseObject } from './Types'

/** TYPES */

export interface UnfinshedCycle {
  metadata: LooseObject
  updates: LooseObject
  data: CycleRecord
}

/** STATE */

let p2pLogger: Logger

export let cycles: CycleRecord[] // [OLD, ..., NEW]
export let cyclesByMarker: { [marker: string]: CycleRecord }

export let oldest: CycleRecord
export let newest: CycleRecord

reset()

/** FUNCTIONS */

export function init() {
  p2pLogger = logger.getLogger('p2p')
}

export function reset() {
  cycles = []
  cyclesByMarker = {}
  oldest = null
  newest = null
}

export function getNewest() {
  return newest
}

export function append(cycle: CycleRecord) {
  const marker = computeCycleMarker(cycle)
  if (!cyclesByMarker[marker]) {
    cycles.push(cycle)
    cyclesByMarker[marker] = cycle
    newest = cycle
    if (!oldest) oldest = cycle
  }
}
export function prepend(cycle: CycleRecord) {
  const marker = computeCycleMarker(cycle)
  if (!cyclesByMarker[marker]) {
    cycles.unshift(cycle)
    cyclesByMarker[marker] = cycle
    oldest = cycle
    if (!newest) newest = cycle
  }
}
export function validate(prev: CycleRecord, next: CycleRecord): boolean {
  const prevMarker = computeCycleMarker(prev)
  if (next.previous !== prevMarker) return false
  // [TODO] More validation
  return true
}

export function getCycleChain(start, end = start + 100) {
  if (!oldest) return []
  if (end < oldest.counter) return []
  if (start < oldest.counter) start = oldest.counter
  if (start > end) return []

  const offset = oldest.counter
  const relStart = start - offset
  const relEnd = end - offset

  // Limit how many are returned
  if (end - start > 100) end = start + 100

  return cycles.slice(relStart, relEnd + 1)
}

export function getLatestCycles(amount) {
  if (cycles.length < amount) {
    return cycles
  }
  return cycles.slice(0 - amount)
}

export function getCycleByTimestamp(timestamp) {
  let secondsTs = Math.floor(timestamp * 0.001)
  // search from end, to improve normal case perf
  for (let i = cycles.length - 1; i >= 0; i--) {
    let cycle = cycles[i]
    if (cycle.start <= secondsTs && cycle.start + cycle.duration > secondsTs) {
      return cycle
    }
  }
  return null
}

export function getCycleByCounter(counter) {
  for (let i = cycles.length - 1; i >= 0; i--) {
    let cycle = cycles[i]
    if (cycle.counter === counter) {
      return cycle
    }
  }
  return null
}

export function prune(keep: number) {
  const drop = cycles.length - keep
  if (drop <= 0) return
  cycles.splice(0, drop)
  oldest = cycles[0]
}

/** HELPER FUNCTIONS */

export function computeCycleMarker(fields) {
  const cycleMarker = crypto.hash(fields)
  return cycleMarker
}

const idToPort: { [id: string]: number } = {}

export function getDebug() {
  const chain = cycles.map((record) => {
    const ctr = record.counter
    const prev = record.previous.slice(0, 4)
    const rhash = crypto.hash(record).slice(0, 4)
    const actv = record.active
    const exp = record.expired
    const joind = record.joinedConsensors.map((c) => c.externalPort)
    const actvd = record.activated.map((id) => {
      if (idToPort[id]) return idToPort[id]
      idToPort[id] = nodes.get(id).externalPort
      return idToPort[id]
    })
    //    const rmvd = record.removed.map(id => idToPort[id])
    const rmvd = record.removed.map((id) =>
      idToPort[id] ? idToPort[id] : 'x' + id.slice(0, 3)
    )
    const lost = record.lost.map((id) =>
      idToPort[id] ? idToPort[id] : 'x' + id.slice(0, 3)
    )
    const refu = record.refuted.map((id) =>
      idToPort[id] ? idToPort[id] : 'x' + id.slice(0, 3)
    )
    const apopd = record.apoptosized.map((id) =>
      idToPort[id] ? idToPort[id] : 'x' + id.slice(0, 3)
    )
    const rfshd = record.refreshedConsensors.map(
      (c) => `${c.externalPort}:${c.counterRefreshed}`
    )

    const str = `      ${ctr}:${prev}:${rhash} { actv:${actv}, exp:${exp}, joind:[${joind.join()}], actvd:[${actvd.join()}], lost:[${lost.join()}] refu:[${refu.join()}] apop:[${apopd.join()}] rmvd:[${rmvd.join()}], rfshd:[${rfshd.join()}] }`

    return str
  })

  const output = `
    DIGESTED:   ${newest ? newest.counter : newest}
    CHAIN:
${chain.join('\n')}`

  return output
}
