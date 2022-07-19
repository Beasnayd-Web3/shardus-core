import { Logger } from 'log4js'
import { stringify } from '@shardus/crypto-utils'
import { P2P } from '@shardus/types'
import {
  binarySearch,
  insertSorted,
  propComparator,
  propComparator2
} from '../utils'
import { crypto, logger } from './Context'
import * as CycleChain from './CycleChain'
import { id } from './Self'
import deepmerge = require('deepmerge')
import { sync } from './Sync'

/** STATE */

let p2pLogger: Logger

export let nodes: Map<P2P.NodeListTypes.Node['id'], P2P.NodeListTypes.Node> // In order of joinRequestTimestamp [OLD, ..., NEW]
export let byPubKey: Map<P2P.NodeListTypes.Node['publicKey'], P2P.NodeListTypes.Node>
export let byIpPort: Map<string, P2P.NodeListTypes.Node>
export let byJoinOrder: P2P.NodeListTypes.Node[] // In order of joinRequestTimestamp [OLD, ..., NEW]
export let byIdOrder: P2P.NodeListTypes.Node[]
export let othersByIdOrder: P2P.NodeListTypes.Node[] // used by sendGossipIn
export let activeByIdOrder: P2P.NodeListTypes.Node[]
export let syncingByIdOrder: P2P.NodeListTypes.Node[]
export let activeOthersByIdOrder: P2P.NodeListTypes.Node[]
export let potentiallyRemoved: Set<P2P.NodeListTypes.Node['id']>

const VERBOSE = false // Use to dump complete NodeList and CycleChain data

reset()

/** FUNCTIONS */

export function init() {
  p2pLogger = logger.getLogger('p2p')
}

export function reset() {
  nodes = new Map()
  byPubKey = new Map()
  byIpPort = new Map()
  byJoinOrder = []
  byIdOrder = []
  othersByIdOrder = []
  activeByIdOrder = []
  syncingByIdOrder = []
  activeOthersByIdOrder = []
  potentiallyRemoved = new Set()
}

export function addNode(node: P2P.NodeListTypes.Node) {
  console.log('thant: adding node', node)
  // Don't add duplicates
  if (nodes.has(node.id)) {
    warn(
      `NodeList.addNode: tried to add duplicate ${
        node.externalPort
      }: ${stringify(node)}\n` + `${new Error().stack}`
    )

    return
  }

  nodes.set(node.id, node)
  byPubKey.set(node.publicKey, node)
  byIpPort.set(ipPort(node.internalIp, node.internalPort), node)

  // Insert sorted by joinRequestTimstamp into byJoinOrder
  insertSorted(byJoinOrder, node, propComparator2('joinRequestTimestamp', 'id'))

  // Insert sorted by id into byIdOrder
  insertSorted(byIdOrder, node, propComparator('id'))

  // Dont insert yourself into othersbyIdOrder
  if (node.id !== id) {
    insertSorted(othersByIdOrder, node, propComparator('id'))
  }
  // If syncing, insert sorted by id into syncingByIdOrder
  if (node.status === P2P.P2PTypes.NodeStatus.SYNCING) {
    insertSorted(syncingByIdOrder, node, propComparator('id'))
  }

  // If active, insert sorted by id into activeByIdOrder
  if (node.status === P2P.P2PTypes.NodeStatus.ACTIVE) {
    insertSorted(activeByIdOrder, node, propComparator('id'))

    // Dont insert yourself into activeOthersByIdOrder
    if (node.id !== id) {
      insertSorted(activeOthersByIdOrder, node, propComparator('id'))
    }

    // remove active node from syncing list
    removeSyncingNode(node.id)
  }
}
export function addNodes(newNodes: P2P.NodeListTypes.Node[]) {
  for (const node of newNodes) addNode(node)
}

export function removeSyncingNode(id) {
  const idx = binarySearch(syncingByIdOrder, { id }, propComparator('id'))
  console.log('Removing syncing node', id, idx)
  if (idx >= 0) syncingByIdOrder.splice(idx, 1)
}

export function removeNode(id) {
  let idx

  // Omar added this so we don't crash if a node gets remove more than once
  if (!nodes.has(id)) {
    console.log('Tried to delete a node that is not in the nodes list.', id)
    console.trace()
    return
  }

  // Remove from arrays
  idx = binarySearch(activeOthersByIdOrder, { id }, propComparator('id'))
  if (idx >= 0) activeOthersByIdOrder.splice(idx, 1)

  idx = binarySearch(activeByIdOrder, { id }, propComparator('id'))
  if (idx >= 0) activeByIdOrder.splice(idx, 1)

  idx = binarySearch(othersByIdOrder, { id }, propComparator('id'))
  if (idx >= 0) othersByIdOrder.splice(idx, 1)

  idx = binarySearch(byIdOrder, { id }, propComparator('id'))
  if (idx >= 0) byIdOrder.splice(idx, 1)

  idx = binarySearch(syncingByIdOrder, { id }, propComparator('id'))
  if (idx >= 0) syncingByIdOrder.splice(idx, 1)

  const joinRequestTimestamp = nodes.get(id).joinRequestTimestamp
  idx = binarySearch(
    byJoinOrder,
    { joinRequestTimestamp, id },
    propComparator2('joinRequestTimestamp', 'id')
  )
  if (idx >= 0) byJoinOrder.splice(idx, 1)

  // Remove from maps
  const node = nodes.get(id)
  byIpPort.delete(ipPort(node.internalIp, node.internalPort))
  byPubKey.delete(node.publicKey)
  nodes.delete(id)
}
export function removeNodes(ids: string[]) {
  for (const id of ids) removeNode(id)
}

export function updateNode(update: P2P.NodeListTypes.Update) {
  const node = nodes.get(update.id)
  if (node) {
    // Update node properties
    for (const key of Object.keys(update)) {
      node[key] = update[key]
    }
    //test if this node is in the active list already.  if it is not, then we can add it
    let idx = binarySearch(activeByIdOrder, { id:node.id }, propComparator('id'))
    if (idx < 0) {
      // Add the node to active arrays, if needed
      if (update.status === P2P.P2PTypes.NodeStatus.ACTIVE) {
        insertSorted(activeByIdOrder, node, propComparator('id'))
        // Don't add yourself to
        if (node.id !== id) {
          insertSorted(activeOthersByIdOrder, node, propComparator('id'))
        }
        // remove active node from syncing list
        console.log('updateNode: removing active node from syncing list')
        removeSyncingNode(node.id)
      }
    }
  }
}
export function updateNodes(updates: P2P.NodeListTypes.Update[]) {
  for (const update of updates) updateNode(update)
}

export function createNode(joined: P2P.JoinTypes.JoinedConsensor) {
  const node: P2P.NodeListTypes.Node = {
    ...joined,
    curvePublicKey: crypto.convertPublicKeyToCurve(joined.publicKey),
    status: P2P.P2PTypes.NodeStatus.SYNCING,
  }

  return node
}

export function ipPort(ip: string, port: number) {
  return ip + ':' + port
}

function idTrim(id) {
  return id.substr(0, 4)
}

export function getDebug() {
  let output = `
    NODES:
      hash:                  ${crypto.hash(byJoinOrder).slice(0, 5)}
      byJoinOrder:           [${byJoinOrder
        .map(
          (node) =>
            `${node.externalIp}:${node.externalPort}-${node.counterRefreshed}`
        )
        .join()}]
      byIdOrder:             [${byIdOrder
        .map(
          (node) =>
            `${node.externalIp}:${node.externalPort}` + '-x' + idTrim(node.id)
        )
        .join()}]
      othersByIdOrder:       [${othersByIdOrder.map(
        (node) => `${node.externalIp}:${node.externalPort}`
      )}]
      activeByIdOrder:       [${activeByIdOrder.map(
        (node) => `${node.externalIp}:${node.externalPort}`
      )}]
      activeOthersByIdOrder: [${activeOthersByIdOrder.map(
        (node) => `${node.externalIp}:${node.externalPort}`
      )}]
      `
  if (VERBOSE)
    output += `
    NODELIST:   ${stringify(byJoinOrder)}
    CYCLECHAIN: ${stringify(CycleChain.cycles)}
  `
  return output
}

/** ROUTES */

function info(...msg) {
  const entry = `NodeList: ${msg.join(' ')}`
  p2pLogger.info(entry)
}

function warn(...msg) {
  const entry = `NodeList: ${msg.join(' ')}`
  p2pLogger.warn(entry)
}

function error(...msg) {
  const entry = `NodeList: ${msg.join(' ')}`
  p2pLogger.error(entry)
}
