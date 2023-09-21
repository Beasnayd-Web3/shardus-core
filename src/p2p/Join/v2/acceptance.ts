import { hexstring, P2P } from "@shardus/types";
import { err, ok } from "neverthrow";
import { EventEmitter } from "events";
import { Result } from "neverthrow";
import * as http from '../../../http'
import { getRandom } from "../../../utils";
import { crypto } from "../../Context";
import { JoinedConsensor } from "@shardus/types/build/src/p2p/JoinTypes";

let activeNodes: P2P.P2PTypes.Node[] = []
let alreadyCheckingAcceptance = false

/**
  * Provide a list of active nodes that the join protocol can use to confirm
  * whether or not this node was accepted into the cycle.
  */
export function provideActiveNodes(nodes: P2P.P2PTypes.Node[]): void {
  activeNodes = nodes
}

const eventEmitter = new EventEmitter()
export function getEventEmitter(): EventEmitter {
  return eventEmitter
}

export async function confirmAcceptance(onCycleMarker: hexstring): Promise<Result<boolean, Error>> {
  if (alreadyCheckingAcceptance) {
    return err(new Error('already checking acceptance'))
  }
  alreadyCheckingAcceptance = true

  if (activeNodes.length === 0) {
    // disable this flag since we're returning
    alreadyCheckingAcceptance = false
    return err(new Error('no active nodes provided'))
  }

  // we need to query for the cycle record from a node to confirm that we were,
  // in fact, accepted during the cycle
  const randomNode = getRandom(activeNodes, 1)[0]

  let cycle: P2P.CycleCreatorTypes.CycleRecord
  try {
    cycle = await getCycleFromNode(randomNode, onCycleMarker)
  } catch (e) {
    // disable this flag since we're returning
    alreadyCheckingAcceptance = false
    return err(new Error(`error getting cycle from node ${randomNode.ip}:${randomNode.port}: ${e}`))
  }

  const ourPublicKey = crypto.getPublicKey()
  const included = cycle.joinedConsensors.some((joinedConsensor: JoinedConsensor) => joinedConsensor.publicKey === ourPublicKey)

  // disable this flag since we're done
  alreadyCheckingAcceptance = false

  return ok(included)
}

async function getCycleFromNode(node: P2P.P2PTypes.Node, cycleMarker: hexstring): Promise<P2P.CycleCreatorTypes.CycleRecord> {
  const url = `http://${node.ip}:${node.port}/cycle-by-marker?marker=${cycleMarker}`
  const cycle: P2P.CycleCreatorTypes.CycleRecord =
    await http.get(url)

  return cycle
}
