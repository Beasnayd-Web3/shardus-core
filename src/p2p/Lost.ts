/*
Nodes can be lost at anytime without notifiying the network. This is different than Apoptosis where
the node sends a message to peers before exiting. When a node notifies the network that it is exiting,
the peers can remove it from their node list within 2 cycles. If a node does not notifiy the network
before exiting it will take the peers about 3 cycles to remove the node from their node list.
The lost node detection process is described in the "Lost Node Detection" Google doc under Shardus
internal documents.
*/

import * as shardusCrypto from '@shardus/crypto-utils'
import { P2P } from '@shardus/types'
import { SignedObject } from '@shardus/types/build/src/p2p/P2PTypes'
import { Handler } from 'express'
import * as http from '../http'
import { logFlags } from '../logger'
import * as utils from '../utils'
import { binarySearch, logNode, validateTypes } from '../utils'
import getCallstack from '../utils/getCallstack'
import { nestedCountersInstance } from '../utils/nestedCounters'
import { profilerInstance } from '../utils/profiler'
import { isApopMarkedNode } from './Apoptosis'
import * as Comms from './Comms'
import { config, crypto, logger, network } from './Context'
import { currentCycle, currentQuarter } from './CycleCreator'
import * as NodeList from './NodeList'
import { activeByIdOrder, byIdOrder, nodes } from './NodeList'
import * as Self from './Self'
import { generateUUID } from './Utils'
import { CycleData } from '@shardus/types/build/src/p2p/CycleCreatorTypes'

/** STATE */

// [TODO] - This enables the /kill /killother debug route and should be set to false after testing
const allowKillRoute = false

let p2pLogger

let lost: Map<string, P2P.LostTypes.LostRecord> = new Map<string, P2P.LostTypes.LostRecord>()
export let isDown = {}
let isUp = {}
let isUpTs = {}
let stopReporting = {}
let sendRefute = -1
// map of <node_id-cycle_counter>
let scheduledForLostReport: Map<string, ScheduledLostReport> = new Map<string, ScheduledLostReport>()

interface ScheduledLostReport {
  reason: string
  targetNode: P2P.NodeListTypes.Node
  timestamp: number
  scheduledInCycle: number
  requestId: string
}

//const CACHE_CYCLES = 10 replaced by multiple configs

interface PingMessage {
  m: string
}

export declare type SignedPingMessage = PingMessage & SignedObject

/** ROUTES */

const killExternalRoute: P2P.P2PTypes.Route<Handler> = {
  method: 'GET',
  name: 'kill',
  handler: (_req, res) => {
    if (allowKillRoute) {
      res.json({ status: 'left the network without telling any peers' })
      killSelf(
        'Apoptosis being called killExternalRoute()->killSelf()->emitter.emit(`apoptosized`) at src/p2p/Lost.ts'
      )
    }
  },
}

const killOtherExternalRoute: P2P.P2PTypes.Route<Handler> = {
  method: 'GET',
  name: 'killother',
  handler: (_req, res) => {
    if (allowKillRoute) {
      res.json({ status: 'killing another node' })
      killOther()
    }
  },
}

const lostReportRoute: P2P.P2PTypes.Route<P2P.P2PTypes.InternalHandler<P2P.LostTypes.SignedLostReport>> = {
  name: 'lost-report',
  handler: lostReportHandler,
}

/**
note: we are not using the SignedObject part yet
FUTURE-SLASHING
we would not want to blindly check signatures, and may later need
a way to mark a node as bad if it spams the ping endpoint too much
 */
const pingNodeRoute: P2P.P2PTypes.Route<P2P.P2PTypes.InternalHandler<SignedPingMessage>> = {
  name: 'ping-node',
  handler: (payload, response, sender) => {
    profilerInstance.scopedProfileSectionStart('ping-node')
    try {
      //used by isNodeDown to test if a node can be reached on the internal protocol
      if (payload?.m === 'ping') {
        response({ s: 'ack', r: 1 })
      }
    } finally {
      profilerInstance.scopedProfileSectionEnd('ping-node')
    }
  },
}

const lostDownRoute: P2P.P2PTypes.GossipHandler = (
  payload: P2P.LostTypes.SignedDownGossipMessage,
  sender,
  tracker
) => {
  profilerInstance.scopedProfileSectionStart('lost-down')
  try {
    downGossipHandler(payload, sender, tracker)
  } finally {
    profilerInstance.scopedProfileSectionStart('lost-down')
  }
}

const lostUpRoute: P2P.P2PTypes.GossipHandler = (
  payload: P2P.LostTypes.SignedUpGossipMessage,
  sender,
  tracker
) => {
  profilerInstance.scopedProfileSectionStart('lost-up')
  try {
    upGossipHandler(payload, sender, tracker)
  } finally {
    profilerInstance.scopedProfileSectionStart('lost-up')
  }
}

const routes = {
  external: [killExternalRoute, killOtherExternalRoute],
  internal: [lostReportRoute, pingNodeRoute],
  gossip: {
    'lost-down': lostDownRoute,
    'lost-up': lostUpRoute,
  },
}

/** FUNCTIONS */

export function init() {
  // p2pLogger = logger.getLogger('p2p')
  p2pLogger = logger.getLogger('p2p')

  p2pLogger.info('HELLO')

  // Init state
  reset()

  // Register routes
  for (const route of routes.external) {
    // [TODO] - Add Comms.registerExternalGet and Post that pass through to network.*
    //          so that we can always just use Comms.* instead of network.*
    network._registerExternal(route.method, route.name, route.handler)
  }
  for (const route of routes.internal) {
    Comms.registerInternal(route.name, route.handler)
  }
  for (const [name, handler] of Object.entries(routes.gossip)) {
    Comms.registerGossipHandler(name, handler)
  }
}

// This gets called before start of Q1
export function reset() {
  const lostCacheCycles = config.p2p.lostMapPruneCycles
  for (const [key, obj] of lost) {
    // delete old lost reports
    if (obj.cycle < currentCycle - lostCacheCycles) {
      lost.delete(key)
      continue
    }
    // delete once the target is removed from the node list
    if (!nodes.get(obj.target)) {
      lost.delete(key)
      continue
    }
  }
  pruneIsDown() // prune isUp and isDown status cache
  pruneStopReporting() // prune stopReporting cache
}

// This gets called at the start of Q3
export function getTxs(): P2P.LostTypes.Txs {
  let lostTxs = []
  let refutedTxs = []
  // Check if the node in the lost list is in the apop list; remove it if there is one
  for (const [key, obj] of lost) {
    const { target } = obj
    if (isApopMarkedNode(target)) {
      lost.delete(key)
    }
  }
  let seen = {} // used to make sure we don't add the same node twice
  for (const [key, obj] of lost) {
    if (seen[obj.target]) continue
    if (obj.message && obj.message.report && obj.message.cycle === currentCycle) {
      lostTxs.push(obj.message)
      seen[obj.target] = true
    }
  }
  seen = {}
  for (const [key, obj] of lost) {
    if (seen[obj.target]) continue
    if (obj.message && obj.message.status === 'up' && obj.message.cycle === currentCycle) {
      refutedTxs.push(obj.message)
      seen[obj.target] = true
    }
  }
  return {
    lost: [...lostTxs],
    refuted: [...refutedTxs],
  }
}

export function validateRecordTypes(rec: P2P.LostTypes.Record): string {
  let err = validateTypes(rec, { lost: 'a', refuted: 'a' })
  if (err) return err
  for (const item of rec.lost) {
    if (typeof item !== 'string') return 'items of lost array must be strings'
  }
  for (const item of rec.refuted) {
    if (typeof item !== 'string') return 'items of refuted array must be strings'
  }
  return ''
}

// This gets called during Q3 after getTxs
export function dropInvalidTxs(txs: P2P.LostTypes.Txs): P2P.LostTypes.Txs {
  const validLost = txs.lost.filter((request) => checkDownMsg(request, currentCycle)[0])
  const validRefuted = txs.refuted.filter((request) => checkUpMsg(request, currentCycle)[0])
  return { lost: validLost, refuted: validRefuted }
}

/*
Given the txs and prev cycle record mutate the referenced record
*/
// This gets called during Q3 after dropInvalidTxs
export function updateRecord(
  txs: P2P.LostTypes.Txs,
  record: P2P.CycleCreatorTypes.CycleRecord,
  prev: P2P.CycleCreatorTypes.CycleRecord
) {
  const lostNodeIds = []
  const lostSyncingNodeIds = []
  const refutedNodeIds = []
  let seen = {} // used to make sure we don't add the same node twice
  for (const request of txs.lost) {
    if (seen[request.report.target]) continue
    lostNodeIds.push(request.report.target)
    seen[request.report.target] = true
  }
  seen = {}
  for (const request of txs.refuted) {
    if (seen[request.target]) continue
    refutedNodeIds.push(request.target)
    seen[request.target] = true
  }

  // remove activated nodes from syncing by id order
  for (const nodeId of record.activated) {
    NodeList.removeSyncingNode(nodeId)
  }

  if (config.p2p.detectLostSyncing) {
    const syncingNodes = NodeList.syncingByIdOrder
    const now = Math.floor(Date.now() / 1000)
    for (const syncingNode of syncingNodes) {
      const syncTime = now - syncingNode.joinRequestTimestamp
      console.log('syncTime vs maxSyncTime', syncTime, record.maxSyncTime)
      if (record.maxSyncTime && syncTime > record.maxSyncTime) {
        info(`Syncing time for node ${syncingNode.id}`, syncTime)
        info(`Max sync time from record`, record.maxSyncTime)
        info(`Sync time is longer than max sync time. Reporting as lost`)
        info('adding node to lost syncing list', syncingNode.id, `${syncTime} > ${record.maxSyncTime}`)
        //todo remove this later after we feel good about the system.. it wont really be that rare, so we dont want to swamp rare counters
        /* prettier-ignore */ nestedCountersInstance.countRareEvent('lost', 'sync timeout ' + `${utils.stringifyReduce(syncingNode.id)} ${syncTime} > ${record.maxSyncTime}`)
        lostSyncingNodeIds.push(syncingNode.id)
      }
    }
  }

  record.lost = lostNodeIds.sort()
  record.lostSyncing = lostSyncingNodeIds.sort()
  record.refuted = refutedNodeIds.sort()

  if (prev) {
    let apop = prev.lost.filter((id) => nodes.has(id)) // remove nodes that are no longer in the network
    let apopSyncing = []
    if (config.p2p.detectLostSyncing) {
      apopSyncing = prev.lostSyncing.filter((id) => nodes.has(id))
    }
    // remove nodes that are no longer in the network
    apop = apop.filter((id) => !refutedNodeIds.includes(id)) // remove nodes that refuted

    // filter adding nodes that are already in the apop record
    if (config.p2p.uniqueRemovedIds) {
      apop = apop.filter((id) => !record.apoptosized.includes(id))
      apopSyncing = apopSyncing.filter((id) => !record.apoptosized.includes(id))
    }
    // If the apop nodes are in the removed record also, clear them from the removed record
    if (config.p2p.uniqueRemovedIdsUpdate) {
      const nodesInRemoved = apop.filter((id) => record.removed.includes(id))
      record.removed = record.removed.filter((id) => !nodesInRemoved.includes(id))
    }
    record.apoptosized = [...apop, ...apopSyncing, ...record.apoptosized].sort()
  }
}

// This gets called before Q1 when a new cycle is created or fetched
export function parseRecord(record: P2P.CycleCreatorTypes.CycleRecord): P2P.CycleParserTypes.Change {
  // If we see our node in the refute field clear flag to send an 'up' message at start of next cycle
  //   We ndded to do this check before checking the lost field for our node.
  for (const id of record.refuted) {
    if (id === Self.id) sendRefute = -1
  }
  // Once we see any node in the lost field of the cycle record, we should stop
  //   sending lost reports for it to reduce the amount of network messages caused by the lost node
  // If we see our node in the lost field set flag to send an 'up' message at start of next cycle
  for (const id of record.lost) {
    stopReporting[id] = record.counter
    if (id === Self.id) {
      sendRefute = record.counter + 1
      warn(`self-schedule refute currentC:${currentCycle} inCycle:${record.counter} refuteat:${sendRefute}`)
      /* prettier-ignore */ nestedCountersInstance.countEvent('p2p', `self-schedule refute currentC:${currentCycle} inCycle:${record.counter}`, 1)
    }
  }

  if (record.lostSyncing.includes(Self.id)) {
    // This could happen if we take longer than maxSyncTime to sync
    error(`We got marked as lostSyncing. Being nice and leaving.`)
    Self.emitter.emit(
      'invoke-exit',
      'lostSyncing',
      getCallstack(),
      'invoke-exit being called at parseRecord() => src/p2p/Lost.ts'
    )
  }

  // We don't actually have to set removed because the Apoptosis module will do it.
  // Make sure the Lost module is listed after Apoptosis in the CycleCreator submodules list
  return {
    added: [],
    removed: [],
    updated: [],
  }
}

// This is called once per cycle at the start of Q1 by CycleCreator
export function sendRequests() {
  if (config.p2p.aggregateLostReportsTillQ1) {
    scheduledForLostReport.forEach((value: ScheduledLostReport, key: string) => {
      if (value.scheduledInCycle < currentCycle - config.p2p.delayLostReportByNumOfCycles) {
        /* prettier-ignore */ info(`Reporting lost: requestId: ${value.requestId}, scheduled in cycle: ${value.scheduledInCycle}, reporting in cycle ${currentCycle}, originally reported at ${value.timestamp}`)
        reportLost(value.targetNode, value.reason, value.requestId)
        scheduledForLostReport.delete(key)
      }
    })
  }

  for (const [key, obj] of lost) {
    if (obj.status !== 'down') continue // TEST
    if (obj.message && obj.message.checker && obj.message.checker === Self.id) {
      if (obj.gossiped) continue
      if (obj.status !== 'down') continue
      if (stopReporting[obj.message.target]) continue // TEST // this node already appeared in the lost field of the cycle record, we dont need to keep reporting
      let msg = { report: obj.message, cycle: currentCycle, status: 'down' }
      msg = crypto.sign(msg)
      obj.message = msg
      obj.gossiped = true
      info(`Gossiping node down message: ${JSON.stringify(msg)}`)
      /* prettier-ignore */ nestedCountersInstance.countEvent('p2p', 'send-lost-down', 1)
      //this next line is probably too spammy to leave in forever (but ok to comment out and keep)
      /* prettier-ignore */ nestedCountersInstance.countEvent('p2p', `send-lost-down c:${currentCycle}`, 1)
      Comms.sendGossip('lost-down', msg, '', null, byIdOrder, true)
    }
  }
  // We cannot count on the lost node seeing the gossip and refuting based on that.
  //   It has to be based on the lost node seeing it's node id in the lost field of the cycle record.
  //   Send refute is set to the cycle counter + 1 of the cycle record where we saw our id in the lost field
  //   We cannot create a message which has the down message since we may not have received that gossip
  if (sendRefute > 0) {
    warn(`pending sendRefute:${sendRefute} currentCycle:${currentCycle}`)
  }
  if (sendRefute === currentCycle) {
    let msg = { target: Self.id, status: 'up', cycle: currentCycle }
    warn(`Gossiping node up message: ${JSON.stringify(msg)}`)
    msg = crypto.sign(msg)
    /* prettier-ignore */ nestedCountersInstance.countEvent('p2p', 'self-refute', 1)
    //this next line is probably too spammy to leave in forever (but ok to comment out and keep)
    /* prettier-ignore */ nestedCountersInstance.countEvent('p2p', `self-refute c:${currentCycle}`, 1)
    Comms.sendGossip('lost-up', msg, '', null, byIdOrder, true)
  }
}

/* Module functions */

async function killSelf(message: string) {
  error(`In killSelf`)
  Self.emitter.emit('invoke-exit', 'killSelf', getCallstack(), message)
  error(`I have been killed, will not restart.`)
}

async function killOther() {
  const requestId = generateUUID()
  info(`Explicitly injecting reportLost, requestId: ${requestId}`)
  let target = activeByIdOrder[0]
  if (target.id === Self.id) target = activeByIdOrder[1]
  scheduleLostReport(target, 'killother', requestId)
}

export function scheduleLostReport(target: P2P.NodeListTypes.Node, reason: string, requestId: string) {
  if (!config.p2p.aggregateLostReportsTillQ1) return reportLost(target, reason, requestId)
  if (requestId.length == 0) requestId = generateUUID()
  info(`Scheduling lost report for ${target.id}, requestId: ${requestId}.`)
  info(`Target node details for requestId: ${requestId}: ${logNode(target)}`)
  info(`Scheduled lost report in ${currentCycle} for requestId: ${requestId}.`)

  const key = `${target.id}-${currentCycle}`

  if (scheduledForLostReport.has(key)) {
    const previousScheduleValue = scheduledForLostReport.get(key)
      /* prettier-ignore */ info(`Target node ${target.id} already scheduled for lost report. requestId: ${previousScheduleValue.requestId}.`)
      /* prettier-ignore */ info(`Previous scheduled lost report details for ${target.id}: ${JSON.stringify(previousScheduleValue)}`)
  }
  scheduledForLostReport.set(key, {
    reason: reason,
    targetNode: target,
    timestamp: Date.now(),
    scheduledInCycle: currentCycle,
    requestId: requestId,
  })
}

// This gets called from Shardus when network module emits timeout or error
function reportLost(target, reason: string, requestId: string) {
  info(`Reporting lost for ${target.id}, requestId: ${requestId}.`)
  info(`Target node details for requestId: ${requestId}: ${logNode(target)}`)
  if (target.id === Self.id) return // don't report self
  if (stopReporting[target.id]) return // this node already appeared in the lost field of the cycle record, we dont need to keep reporting
  // we set isDown cache to the cycle number here; to speed up deciding if a node is down
  isDown[target.id] = currentCycle
  const key = `${target.id}-${currentCycle}`
  const lostRec = lost.get(key)
  if (lostRec) return // we have already seen this node for this cycle
  let obj = { target: target.id, status: 'reported', cycle: currentCycle }
  const checker = getCheckerNode(target.id, currentCycle)
  if (checker.id === Self.id && activeByIdOrder.length >= 3) return // we cannot be reporter and checker if there is 3 or more nodes in the network
  let msg: P2P.LostTypes.LostReport = {
    target: target.id,
    checker: checker.id,
    reporter: Self.id,
    cycle: currentCycle,
  }
  // [TODO] - remove the following line after testing killother
  if (allowKillRoute && reason === 'killother') msg.killother = true
    /* prettier-ignore */ info(`Sending investigate request. requestId: ${requestId}, reporter: ${Self.ip}:${Self.port} id: ${Self.id}`)
    /* prettier-ignore */ info(`Sending investigate request. requestId: ${requestId}, checker: ${checker.internalIp}:${checker.internalPort} node details: ${logNode(checker)}`)
    /* prettier-ignore */ info(`Sending investigate request. requestId: ${requestId}, target: ${target.internalIp}:${target.internalPort} node details: ${logNode(target)}`)
    /* prettier-ignore */ info(`Sending investigate request. requestId: ${requestId}, msg: ${JSON.stringify(msg)}`)

  const msgCopy = JSON.parse(shardusCrypto.stringify(msg))
  msgCopy.timestamp = Date.now()
  msgCopy.requestId = requestId
  msg = crypto.sign(msgCopy)
  lost.set(key, obj)
  Comms.tell([checker], 'lost-report', msg)
}

function getCheckerNode(id, cycle) {
  const obj = { id, cycle }
  const near = crypto.hash(obj)
  function compareNodes(i, r) {
    return i > r.id ? 1 : i < r.id ? -1 : 0
  }
  let idx = binarySearch(activeByIdOrder, near, compareNodes)
  const oidx = idx
  if (idx < 0) idx = (-1 - idx) % activeByIdOrder.length
  if (activeByIdOrder[idx].id === id) idx = (idx + 1) % activeByIdOrder.length // skip to next node if the selected node is target
    info(`in getCheckerNode oidx:${oidx} idx:${idx} near:${near}  cycle:${cycle}  id:${id}`)
    info(`${JSON.stringify(activeByIdOrder.map((n) => n.id))}`)
  return activeByIdOrder[idx]
}

async function lostReportHandler(payload, response, sender) {
  profilerInstance.scopedProfileSectionStart('lost-report')
  try {
    let requestId = generateUUID()
    /* prettier-ignore */ info(`Got investigate request requestId: ${requestId}, req: ${JSON.stringify(payload)} from ${logNode(sender)}`)
    let err = ''
    // for request tracing
    err = validateTypes(payload, { timestamp: 'n', requestId: 's' })
    if (!err) {
      /* prettier-ignore */ info(`Lost report tracing, requestId: ${payload.requestId}, timestamp: ${payload.timestamp}, sender: ${logNode(sender)}`)
      requestId = payload.requestId
    }
    err = validateTypes(payload, { target: 's', reporter: 's', checker: 's', cycle: 'n', sign: 'o' })
    if (err) {
      warn(`requestId: ${requestId} bad input ${err}`)
      return
    }
    err = validateTypes(payload.sign, { owner: 's', sig: 's' })
    if (err) {
      warn(`requestId: ${requestId} bad input ${err}`)
      return
    }
    if (stopReporting[payload.target]) return // this node already appeared in the lost field of the cycle record, we dont need to keep reporting
    const key = `${payload.target}-${payload.cycle}`
    if (lost.get(key)) return // we have already seen this node for this cycle
    const [valid, reason] = checkReport(payload, currentCycle + 1)
    if (!valid) {
      warn(`Got bad investigate request. requestId: ${requestId}, reason: ${reason}`)
      return
    }
    if (sender !== payload.reporter) return // sender must be same as reporter
    if (payload.checker !== Self.id) return // the checker should be our node id
    let obj: P2P.LostTypes.LostRecord = {
      target: payload.target,
      cycle: payload.cycle,
      status: 'checking',
      message: payload,
    }
    lost.set(key, obj)
    // check if we already know that this node is down
    if (isDown[payload.target]) {
      obj.status = 'down'
      return
    }
    let result = await isDownCache(nodes.get(payload.target), requestId)
    /* prettier-ignore */ info(`isDownCache for requestId: ${requestId}, result ${result}`)
    if (allowKillRoute && payload.killother) result = 'down'
    if (obj.status === 'checking') obj.status = result
    info('Status after checking is ' + obj.status)
    // At start of Q1 of the next cycle sendRequests() will start a gossip if the node was found to be down
  } finally {
    profilerInstance.scopedProfileSectionEnd('lost-report')
  }
}

function checkReport(report, expectCycle) {
  if (!report || typeof report !== 'object') return [false, 'no report given']
  if (!report.reporter || typeof report.reporter !== 'string') return [false, 'no reporter field']
  if (!report.checker || typeof report.checker !== 'string') return [false, 'no checker field']
  if (!report.target || typeof report.target !== 'string') return [false, 'no target field']
  if (!report.cycle || typeof report.cycle !== 'number') return [false, 'no cycle field']
  if (!report.sign || typeof report.sign !== 'object') return [false, 'no sign field']
  if (report.target == Self.id) return [false, 'target is self'] // Don' accept if target is our node
  const cyclediff = expectCycle - report.cycle
  if (cyclediff < 0) return [false, 'reporter cycle is not as expected; too new']
  if (cyclediff >= 2) return [false, 'reporter cycle is not as expected; too old']
  if (report.target === report.reporter) return [false, 'target cannot be reporter'] // the target should not be the reporter
  if (report.checker === report.target) return [false, 'target cannot be checker'] // the target should not be the reporter
  if (report.checker === report.reporter) {
    if (activeByIdOrder.length >= 3) return [false, 'checker cannot be reporter']
  }
  if (!nodes.has(report.target)) return [false, 'target not in network']
  if (!nodes.has(report.reporter)) return [false, 'reporter not in network']
  if (!nodes.has(report.checker)) return [false, 'checker not in network']
  let checkerNode = getCheckerNode(report.target, report.cycle)
  if (checkerNode.id !== report.checker)
    return [false, `checker node should be ${checkerNode.id} and not ${report.checker}`] // we should be the checker based on our own calculations
  if (!crypto.verify(report, nodes.get(report.reporter).publicKey)) return [false, 'bad sign from reporter'] // the report should be properly signed
  return [true, '']
}

/*
This cache uses two lookup tables: isUp and isDown
The tables map a node id to the cycle counter when the node up/down status was checked
When we check a node and find it to be up we set isUp[node_id] = current_cycle_counter
When we check a node and find it to be down we set isDown[node_id] = current_cycle_counter
At the start of each cycle we delete entries in the tables that are older than 5 cycles.
A conditional check for an entry that is not in the table has a result of false
and a conditional check for a nonzero entry has a result of true.
We export the isDown table so that other modules can easily check if a node is down.
However, if isDown returns false it does not mean that a node is not actually down.
But if it returns true it means that the node was found to be down recently.
Also if isUp returns false it does not mean that a node is actually up, but if it
returns true it means that it was found to be up recently.
*/
async function isDownCache(node, requestId: string) {
  // First check the isUp isDown caches to see if we already checked this node before
  const id = node.id

  if (config.p2p.isDownCacheEnabled) {
    if (isDown[id]) {
      /* prettier-ignore */ nestedCountersInstance.countEvent('p2p', 'isDownCheck-skipped-down', 1)
      info(`node with id ${node.id} found in isDown for requestId: ${requestId}`)
      return 'down'
    }
    if (isUp[id]) {
      /* prettier-ignore */ nestedCountersInstance.countEvent('p2p', 'isDownCheck-skipped-up', 1)
      info(`node with id ${node.id} found in isUp for requestId: ${requestId}`)
      return 'up'
    }
  }
  const status = await isDownCheck(node)
  info(`isDownCheck for requestId: ${requestId} on node with id ${node.id} is ${status}`)
  if (status === 'down') {
    isDown[id] = currentCycle
  } else {
    isUp[id] = currentCycle
  }
  return status
}

export function setIsUpTs(nodeId: string) {
  let timestamp = Date.now()
  isUpTs[nodeId] = timestamp
}

export function isNodeUpRecent(
  nodeId: string,
  maxAge: number
): { upRecent: boolean; state: string; age: number } {
  let lastCheck = isUpTs[nodeId]
  let age = Date.now() - lastCheck

  if (isNaN(age)) {
    return { upRecent: false, state: 'noLastState', age }
  }

  if (age < maxAge) return { upRecent: true, state: 'up', age }
  return { upRecent: false, state: 'noLastState', age }
}

export function isNodeDown(nodeId: string): { down: boolean; state: string } {
  // First check the isUp isDown caches to see if we already checked this node before
  if (isDown[nodeId]) return { down: true, state: 'down' }
  if (isUp[nodeId]) return { down: false, state: 'up' }
  return { down: false, state: 'noLastState' }
}

export function isNodeLost(nodeId: string): boolean {
  // First check the isUp isDown caches to see if we already checked this node before
  const key = `${nodeId}-${currentCycle}`
  const lostRec = lost.get(key)
  if (lostRec != null) {
    return true
  }
  return false
}

// This is called once per cycle by reset
function pruneIsDown() {
  const cachePruneAge = config.p2p.isDownCachePruneCycles

  for (const [key, value] of Object.entries(isDown)) {
    if (value < currentCycle - cachePruneAge) delete isDown[key]
  }
  for (const [key, value] of Object.entries(isUp)) {
    if (value < currentCycle - cachePruneAge) delete isUp[key]
  }
}

function pruneStopReporting() {
  const stopReportingPruneCycles = config.p2p.stopReportingLostPruneCycles

  for (const [key, value] of Object.entries(stopReporting)) {
    if (value < currentCycle - stopReportingPruneCycles) delete stopReporting[key]
  }
}

// Make sure that both the external and internal ports are working
//   if either is not working then the node is considered down.
// If internal and external are both on the same IP then only need to check one.
// This function has some deep knowledge from Sync and Apoptosis APIs
//    and could break if they are changed.
// [TODO] - create our own APIs to test the internal and external connection.
//          Although this could allow a rouge node to more easily fool checks.
async function isDownCheck(node) {
  // Check the internal route
  // The timeout for this is controled by the network.timeout paramater in server.json
  info(`Checking internal connection for ${node.id}`)

  //using the 'apoptosize' route to check if the node is up.
  const res = await Comms.ask(node, 'apoptosize', { id: 'isDownCheck' })
  try {
    if (typeof res.s !== 'string') {
      /* prettier-ignore */ nestedCountersInstance.countEvent('p2p', 'isDownCheck-down-1', 1)
      return 'down'
    }
  } catch {
    /* prettier-ignore */ nestedCountersInstance.countEvent('p2p', 'isDownCheck-down-2', 1)
    return 'down'
  }

  //Note 20230630:  the code below here has not likely had any coverage for a few years due to an upstream issue

  if (node.externalIp === node.internalIp) return 'up'
  info(`Checking external connection for ${node.id}`)
  // Check the external route if ip is different than internal
  const queryExt = async (node) => {
    const ip = node.ip ? node.ip : node.externalIp
    const port = node.port ? node.port : node.externalPort
    // the queryFunction must return null if the given node is our own
    // while syncing nodeList we dont have node.id, so use ip and port
    if (ip === Self.ip && port === Self.port) return null
    const resp: { newestCycle: CycleData } = await http.get(`${ip}:${port}/sync-newest-cycle`)
    return resp
  }
  const resp = await queryExt(node) // if the node is down, reportLost() will set status to 'down'
  try {
    if (typeof resp.newestCycle.counter !== 'number') return 'down'
  } catch {
    /* prettier-ignore */ nestedCountersInstance.countEvent('p2p', 'isDownCheck-down-3', 1)
    return 'down'
  }
  /* prettier-ignore */ nestedCountersInstance.countEvent('p2p', 'isDownCheck-up-1', 1)
  return 'up'
}

function downGossipHandler(payload: P2P.LostTypes.SignedDownGossipMessage, sender, tracker) {
  info(`Got downGossip: ${JSON.stringify(payload)}`)
  let err = ''
  err = validateTypes(payload, { cycle: 'n', report: 'o', status: 's', sign: 'o' })
  if (err) {
    warn('bad input ' + err)
    return
  }
  err = validateTypes(payload.report, { target: 's', reporter: 's', checker: 's', cycle: 'n', sign: 'o' })
  if (err) {
    warn('bad input report ' + err)
    return
  }
  err = validateTypes(payload.report.sign, { owner: 's', sig: 's' })
  if (err) {
    warn('bad input report sign ' + err)
    return
  }
  err = validateTypes(payload.sign, { owner: 's', sig: 's' })
  if (err) {
    warn('bad input sign ' + err)
    return
  }
  const key = `${payload.report.target}-${payload.report.cycle}`
  let rec = lost.get(key)
  if (rec && ['up', 'down'].includes(rec.status)) return // we have already gossiped this node for this cycle
  let [valid, reason] = checkQuarter(payload.report.checker, sender)
  if (!valid) {
    warn(`Bad downGossip message. reason:${reason} message:${JSON.stringify(payload)}`)
    warn(`cycle:${currentCycle} quarter:${currentQuarter} sender:${sender}`)
    return
  }
  ;[valid, reason] = checkDownMsg(payload, currentCycle)
  if (!valid) {
    warn(`Bad downGossip message. reason:${reason}. message:${JSON.stringify(payload)}`)
    warn(`cycle:${currentCycle} quarter:${currentQuarter} sender:${sender}`)
    return
  }
  let obj: P2P.LostTypes.LostRecord = {
    target: payload.report.target,
    cycle: payload.report.cycle,
    status: 'down',
    message: payload,
  }
  lost.set(key, obj)
  Comms.sendGossip('lost-down', payload, tracker, Self.id, byIdOrder, false)
  // After message has been gossiped in Q1 and Q2 we wait for getTxs() to be invoked in Q3
}

function checkQuarter(source, sender) {
  if (![1, 2].includes(currentQuarter)) return [false, 'not in Q1 or Q2']
  if (sender === source && currentQuarter === 2) return [false, 'originator cannot gossip in Q2']
  return [true, '']
}

function checkDownMsg(payload: P2P.LostTypes.SignedDownGossipMessage, expectedCycle) {
  if (payload.cycle !== expectedCycle) return [false, 'checker cycle is not as expected']
  const [valid, reason] = checkReport(payload.report, expectedCycle - 1)
  if (!valid) return [valid, reason]
  if (!crypto.verify(payload, nodes.get(payload.report.checker).publicKey))
    return [false, `bad sign from checker.`]
  return [true, '']
}

function upGossipHandler(payload, sender, tracker) {
  info(`Got upGossip: ${JSON.stringify(payload)}`)
  let err = ''
  err = validateTypes(payload, { cycle: 'n', target: 's', status: 's', sign: 'o' })
  if (err) {
    warn('bad input ' + err)
    return
  }
  err = validateTypes(payload.sign, { owner: 's', sig: 's' })
  if (err) {
    warn('bad input sign ' + err)
    return
  }
  if (!stopReporting[payload.target]) {
    warn('Bad upGossip. We did not see this node in the lost field, but got a up msg from it; ignoring it')
    return
  }
  let [valid, reason] = checkQuarter(payload.target, sender)
  if (!valid) {
    warn(`Bad upGossip message. reason:${reason} message:${JSON.stringify(payload)}`)
    return
  }
  const key = `${payload.target}-${payload.cycle}`
  const rec = lost.get(key)
  if (rec && rec.status === 'up') return // we have already gossiped this node for this cycle
  ;[valid, reason] = checkUpMsg(payload, currentCycle)
  if (!valid) {
    warn(`Bad upGossip message. reason:${reason} message:${JSON.stringify(payload)}`)
    return
  }
  let obj = { target: payload.target, status: 'up', cycle: payload.cycle, message: payload }
  lost.set(key, obj)
  Comms.sendGossip('lost-up', payload, tracker, Self.id, byIdOrder, false)
  // the getTxs() function will loop through the lost object to make txs in Q3 and build the cycle record from them
}

function checkUpMsg(payload: P2P.LostTypes.SignedUpGossipMessage, expectedCycle) {
  if (!nodes.has(payload.target))
    return [false, `target is not an active node  ${payload.target}  ${JSON.stringify(activeByIdOrder)}`]
  if (!crypto.verify(payload, nodes.get(payload.target).publicKey)) return [false, 'bad sign from target']
  return [true, '']
}

function info(...msg) {
  const entry = `Lost: ${msg.join(' ')}`
  p2pLogger.info(entry)
}

function warn(...msg) {
  const entry = `Lost: ${msg.join(' ')}`
  p2pLogger.warn(entry)
}

function error(...msg) {
  const entry = `Lost: ${msg.join(' ')}`
  p2pLogger.error(entry)
}
