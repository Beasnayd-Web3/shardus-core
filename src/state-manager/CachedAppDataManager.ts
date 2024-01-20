import { StateManager as StateManagerTypes } from '@shardus/types'
import { Route } from '@shardus/types/build/src/p2p/P2PTypes'
import { Logger as Log4jsLogger } from 'log4js'
import StateManager from '.'
import Crypto from '../crypto'
import Logger, { logFlags } from '../logger'
import { P2PModuleContext as P2P } from '../p2p/Context'
import * as Shardus from '../shardus/shardus-types'
import { AppObjEnum } from '../shardus/shardus-types'
import { InternalRouteEnum } from '../types/enum/InternalRouteEnum'
import { RequestErrorEnum } from '../types/enum/RequestErrorEnum'
import { InternalBinaryHandler } from '../types/Handler'
import { getStreamWithTypeCheck, requestErrorHandler, verificationDataCombiner } from '../types/Helpers'
import { cSendCachedAppDataReq, deserializeSendCachedAppDataReq, SendCachedAppDataReq, serializeSendCachedAppDataReq } from '../types/SendCachedAppDataReq'
import * as utils from '../utils'
import { reversed } from '../utils'
import Profiler, { profilerInstance } from '../utils/profiler'
import ShardFunctions from './shardFunctions'
import {
  CacheAppDataRequest,
  CacheAppDataResponse,
  CachedAppData,
  CacheTopic,
  QueueEntry,
  StringNodeObjectMap,
} from './state-manager-types'

class CachedAppDataManager {
  app: Shardus.App
  crypto: Crypto
  config: Shardus.StrictServerConfiguration
  profiler: Profiler
  p2p: P2P

  logger: Logger

  mainLogger: Log4jsLogger
  fatalLogger: Log4jsLogger
  shardLogger: Log4jsLogger
  statsLogger: Log4jsLogger

  statemanager_fatal: (key: string, log: string) => void
  stateManager: StateManager

  // cachedAppDataArray: CachedAppData[]
  cacheTopicMap: Map<string, CacheTopic>

  constructor(
    stateManager: StateManager,
    profiler: Profiler,
    app: Shardus.App,
    logger: Logger,
    crypto: Crypto,
    p2p: P2P,
    config: Shardus.StrictServerConfiguration
  ) {
    this.crypto = crypto
    this.app = app
    this.logger = logger
    this.config = config
    this.profiler = profiler
    this.p2p = p2p

    if (logger == null) {
      return // for debug
    }

    this.mainLogger = logger.getLogger('main')
    this.fatalLogger = logger.getLogger('fatal')
    this.shardLogger = logger.getLogger('shardDump')
    this.statsLogger = logger.getLogger('statsDump')
    this.statemanager_fatal = stateManager.statemanager_fatal
    this.stateManager = stateManager

    this.cacheTopicMap = new Map()
    setInterval(this.pruneCachedItems.bind(this), 1000 * config.p2p.cycleDuration) // prune every cycle
  }

  setupHandlers(): void {
    this.p2p.registerInternal('send_cachedAppData', async (payload: CacheAppDataResponse) => {
      profilerInstance.scopedProfileSectionStart('send_cachedAppData')
      try {
        const dummy = payload.cachedAppData as any
        console.log(`send_cachedAppData`, dummy.appData.data.receipt);
        console.log(`send_cachedAppData full payload`, JSON.stringify(payload));
        const cachedAppData = payload.cachedAppData
        const existingCachedAppData = this.getCachedItem(payload.topic, cachedAppData.dataID)
        if (existingCachedAppData) {
          console.log(`We have already processed this cached data`, cachedAppData)
          return
        }
        // insert cachedAppData
        this.insertCachedItem(payload.topic, cachedAppData.dataID, cachedAppData.appData, cachedAppData.cycle)
      } catch (e) {
        this.mainLogger.error(`Error while processing send_cacheAppData`, e)
      } finally {
        profilerInstance.scopedProfileSectionEnd('send_cachedAppData')
      }
    })

    // serialized handler
    const send_cacheAppData2Handler: Route<InternalBinaryHandler<Buffer>> = {
      name: InternalRouteEnum.send_cachedAppData2,
      handler: (payload, response, header, sign) => {
        profilerInstance.scopedProfileSectionStart('send_cachedAppData2')

        const errorHandler = (
          errorType: RequestErrorEnum,
          opts?: { customErrorLog?: string; customCounterSuffix?: string }
        ): void => requestErrorHandler(InternalRouteEnum.send_cachedAppData2, errorType, header, opts)

        try{
          const requestStream = getStreamWithTypeCheck(payload, cSendCachedAppDataReq)

          if(!requestStream) return errorHandler(RequestErrorEnum.InvalidRequest)

          // verification data checks
          if (header.verification_data == null) {
            return errorHandler(RequestErrorEnum.MissingVerificationData)
          }

          const verificationDataParts = header.verification_data.split(':')
          if (verificationDataParts.length !== 2) {
            return errorHandler(RequestErrorEnum.InvalidVerificationData)
          }

          const req = deserializeSendCachedAppDataReq(requestStream)
          const appDeserializedData = this.stateManager.app.binaryDeserializeObject(
            AppObjEnum.CachedAppData,
            req.cachedAppData.appData 
          )
          const cachedAppData: CachedAppData = {
            dataID: req.cachedAppData.dataID,
            appData: appDeserializedData,
            cycle: req.cachedAppData.cycle,
          }

          if (cachedAppData == null) {
            return errorHandler(RequestErrorEnum.InvalidRequest)
          }
          if (cachedAppData.dataID !== verificationDataParts[1]) {
            return errorHandler(RequestErrorEnum.InvalidVerificationData)
          }

          if (cachedAppData.appData == verificationDataParts[0]) {
            return errorHandler(RequestErrorEnum.InvalidRequest)
          }

          const existingCachedAppData = this.getCachedItem(req.topic, cachedAppData.dataID)
          if (existingCachedAppData) {
            console.log(`We have already processed this cached data`, cachedAppData)
            return
          }
          this.insertCachedItem(req.topic, cachedAppData.dataID, cachedAppData.appData, cachedAppData.cycle)
        } finally {
          profilerInstance.scopedProfileSectionEnd('send_cachedAppData2')
        }
      }
    }

    this.p2p.registerInternal(InternalRouteEnum.send_cachedAppData2,send_cacheAppData2Handler)

    this.p2p.registerInternal('get_cached_app_data', async (payload: CacheAppDataRequest, respond: (arg0: CachedAppData) => Promise<void>) => {
      profilerInstance.scopedProfileSectionStart('get_cached_app_data')
      try {
        const { topic, dataId } = payload
        const foundCachedAppData = this.getCachedItem(topic, dataId)
        if (foundCachedAppData == null) {
          this.mainLogger.error(`Cannot find cached data for topic: ${topic}, dataId: ${dataId}`)
        }
        await respond(foundCachedAppData)
        profilerInstance.scopedProfileSectionEnd('get_cached_app_data')
        return
      } catch (e) {
        this.mainLogger.error(`Error while processing get_cachedAppData`, e)
      } finally {
        profilerInstance.scopedProfileSectionEnd('get_cached_app_data')
      }
    })
  }

  registerTopic(topic: string, maxCycleAge: number, maxCacheElements: number): boolean {
    const cacheTopic: CacheTopic = {
      topic,
      maxCycleAge,
      maxCacheElements,
      cacheAppDataMap: new Map(),
      cachedAppDataArray: [],
    }
    if (this.cacheTopicMap.has(topic)) return false
    this.cacheTopicMap.set(topic, cacheTopic)
    if (logFlags.verbose) this.mainLogger.debug(`Cache topic ${topic} is successfully registered.`)
    return true
  }

  getCachedItem(topic: string, dataID: string): CachedAppData {
    const cacheTopic = this.cacheTopicMap.get(topic)
    if (!cacheTopic) return
    const cachedAppData = cacheTopic.cacheAppDataMap.get(dataID)
    return cachedAppData
  }

  // Check and prune cache items for each topic
  pruneCachedItems(): void {
    for (const [, cacheTopic] of this.cacheTopicMap.entries()) {
      let count = 0
      const { maxCycleAge, maxCacheElements } = cacheTopic
      const prunedCachedAppDataArray = []
      for (const cachedAppData of reversed(cacheTopic.cachedAppDataArray)) {
        count += 1
        const cycleAge = this.stateManager.currentCycleShardData.cycleNumber - cachedAppData.cycle

        if (cycleAge > maxCycleAge || count > maxCacheElements) {
          if (logFlags.verbose) {
            this.mainLogger.debug(
              `Deleting dataId ${cachedAppData.dataID} from cache map. cycleAge: ${cycleAge}, count: ${count}`
            )
          }
          cacheTopic.cacheAppDataMap.delete(cachedAppData.dataID)
        } else {
          prunedCachedAppDataArray.push(cachedAppData)
        }
      }
      cacheTopic.cachedAppDataArray = prunedCachedAppDataArray.reverse()
      if (logFlags.verbose) {
        this.mainLogger.debug(
          `Updated cached array size: ${cacheTopic.cachedAppDataArray.length}, cacheMapSize: ${cacheTopic.cacheAppDataMap.size}`
        )
      }
    }
  }

  insertCachedItem(topic: string, dataID: string, appData: unknown, cycle: number): void {
    const cachedAppData: CachedAppData = {
      dataID,
      appData,
      cycle,
    }
    const cacheTopic: CacheTopic = this.cacheTopicMap.get(topic)
    if (!cacheTopic) {
      this.statemanager_fatal(
        'insertCachedItem',
        `Topic ${topic} is not registered yet. ${JSON.stringify(this.cacheTopicMap)}`
      )
      return
    }
    if (!cacheTopic.cacheAppDataMap.has(dataID)) {
      cacheTopic.cacheAppDataMap.set(dataID, cachedAppData)
      cacheTopic.cachedAppDataArray.push(cachedAppData)
    }
  }

  async sendCorrespondingCachedAppData(
    topic: string,
    dataID: string,
    appData: unknown,
    cycle: number,
    _formId: string,
    txId: string
  ): Promise<unknown> {
    if (this.stateManager.currentCycleShardData == null) {
      throw new Error('sendCorrespondingCachedAppData: currentCycleShardData == null')
    }
    if (dataID == null) {
      throw new Error('sendCorrespondingCachedAppData: dataId == null')
    }
    const queueEntry: QueueEntry = this.stateManager.transactionQueue.getQueueEntry(txId)
    const fromKey = queueEntry.executionShardKey ? queueEntry.executionShardKey : queueEntry.txKeys.allKeys[0]
    const uniqueKeys = [fromKey, dataID]
    const ourNodeData = this.stateManager.currentCycleShardData.nodeShardData
    let correspondingAccNodes: Shardus.Node[] = []
    const dataKeysWeHave = []
    const dataValuesWeHave = []
    const dataMap: { [accountID: string]: any } = {} // eslint-disable-line @typescript-eslint/no-explicit-any
    const remoteShardsByKey: { [accountID: string]: StateManagerTypes.shardFunctionTypes.NodeShardData } = {} // shard home nodes that we do not have the data for.
    let loggedPartition = false

    const localHomeNode = ShardFunctions.findHomeNode(
      this.stateManager.currentCycleShardData.shardGlobals,
      fromKey,
      this.stateManager.currentCycleShardData.parititionShardDataMap
    )

    const remoteHomeNode = ShardFunctions.findHomeNode(
      this.stateManager.currentCycleShardData.shardGlobals,
      dataID,
      this.stateManager.currentCycleShardData.parititionShardDataMap
    )

    for (const key of uniqueKeys) {
      let hasKey = false
      if (remoteHomeNode.node.id === ourNodeData.node.id) {
        hasKey = true
      } else {
        //perf todo: this seems like a slow calculation, coult improve this
        for (const node of remoteHomeNode.nodeThatStoreOurParitionFull) {
          if (node.id === ourNodeData.node.id) {
            hasKey = true
            break
          }
        }
      }

      const isGlobalKey = false

      if (hasKey === false) {
        if (loggedPartition === false) {
          loggedPartition = true
          /* prettier-ignore */
          if (logFlags.verbose) this.mainLogger.debug(`sendCorrespondingCachedAppData hasKey=false: ${utils.stringifyReduce(remoteHomeNode.nodeThatStoreOurParitionFull.map((v) => v.id))}`);
          /* prettier-ignore */
          if (logFlags.verbose) this.mainLogger.debug(`sendCorrespondingCachedAppData hasKey=false: full: ${utils.stringifyReduce(remoteHomeNode.nodeThatStoreOurParitionFull)}`);
        }
        /* prettier-ignore */
        if (logFlags.verbose) this.mainLogger.debug(`sendCorrespondingCachedAppData hasKey=false  key: ${utils.stringifyReduce(key)}`);
      }

      if (hasKey) {
        const data = appData

        if (isGlobalKey === false) {
          dataMap[key] = data // eslint-disable-line security/detect-object-injection
          dataKeysWeHave.push(key)
          dataValuesWeHave.push(data)
        }
        this.insertCachedItem(topic, dataID, data, cycle)
      } else {
        remoteShardsByKey[key] = remoteHomeNode // eslint-disable-line security/detect-object-injection
      }
    }

    let edgeNodeIds = []
    let consensusNodeIds = []

    const nodesToSendTo: StringNodeObjectMap = {}
    const doOnceNodeAccPair = new Set<string>() //can skip  node+acc if it happens more than once.

    for (const key of uniqueKeys) {
      for (const key2 of uniqueKeys) {
        if (key !== key2) {
          const ourLocalConsensusIndex = localHomeNode.consensusNodeForOurNodeFull.findIndex(
            (a) => a.id === ourNodeData.node.id
          )
          if (ourLocalConsensusIndex === -1) {
            continue
          }
          edgeNodeIds = []
          consensusNodeIds = []
          correspondingAccNodes = []
          const ourSendingGroupSize = localHomeNode.consensusNodeForOurNodeFull.length
          const targetConsensusGroupSize = remoteHomeNode.consensusNodeForOurNodeFull.length
          const targetEdgeGroupSize = remoteHomeNode.edgeNodes.length
          const patchedListSize = remoteHomeNode.patchedOnNodes.length
          const indices = ShardFunctions.debugFastStableCorrespondingIndicies(
            ourSendingGroupSize,
            targetConsensusGroupSize,
            ourLocalConsensusIndex + 1
          )
          const edgeIndices = ShardFunctions.debugFastStableCorrespondingIndicies(
            ourSendingGroupSize,
            targetEdgeGroupSize,
            ourLocalConsensusIndex + 1
          )

          let patchIndices = []
          if (remoteHomeNode.patchedOnNodes.length > 0) {
            patchIndices = ShardFunctions.debugFastStableCorrespondingIndicies(
              ourSendingGroupSize,
              remoteHomeNode.patchedOnNodes.length,
              ourLocalConsensusIndex + 1
            )
          }
          for (const index of indices) {
            const node = remoteHomeNode.consensusNodeForOurNodeFull[index - 1] // fastStableCorrespondingIndicies is one based so adjust for 0 based array
            if (node != null && node.id !== ourNodeData.node.id) {
              nodesToSendTo[node.id] = node
              consensusNodeIds.push(node.id)
            }
          }
          for (const index of edgeIndices) {
            const node = remoteHomeNode.edgeNodes[index - 1] // fastStableCorrespondingIndicies is one based so adjust for 0 based array
            if (node != null && node.id !== ourNodeData.node.id) {
              nodesToSendTo[node.id] = node
              edgeNodeIds.push(node.id)
            }
          }
          for (const index of patchIndices) {
            const node = remoteHomeNode.edgeNodes[index - 1] // fastStableCorrespondingIndicies is one based so adjust for 0 based array

            if (node != null && node.id !== ourNodeData.node.id) {
              nodesToSendTo[node.id] = node
            }
          }
          const cacheAppDataToSend: CachedAppData = {
            dataID,
            appData,
            cycle,
          }
          const message: CacheAppDataResponse = { topic, cachedAppData: cacheAppDataToSend }
          for (const [accountID, node] of Object.entries(nodesToSendTo)) {
            const keyPair = accountID + key
            if (node != null && doOnceNodeAccPair.has(keyPair) === false) {
              doOnceNodeAccPair.add(keyPair)
              correspondingAccNodes.push(node)
            }
          }

          if (logFlags.verbose) {
            if (logFlags.playback) {
              this.logger.playbackLogNote(
                'sendCorrespondingCachedAppData',
                dataID,
                `sendCorrespondingCachedAppData nodesToSendTo:${
                  Object.keys(nodesToSendTo).length
                } doOnceNodeAccPair:${doOnceNodeAccPair.size} indices:${JSON.stringify(
                  indices
                )} edgeIndicies:${JSON.stringify(edgeIndices)} patchIndicies:${JSON.stringify(
                  patchIndices
                )}  doOnceNodeAccPair: ${JSON.stringify([
                  ...doOnceNodeAccPair.keys(),
                ])} ourLocalConsensusIndex:${ourLocalConsensusIndex} ourSendingGroupSize:${ourSendingGroupSize} targetEdgeGroupSize:${targetEdgeGroupSize} targetEdgeGroupSize:${targetEdgeGroupSize} patchedListSize:${patchedListSize}`
              )
            }
          }

          if (correspondingAccNodes.length > 0) {
            const remoteRelation = ShardFunctions.getNodeRelation(
              remoteHomeNode,
              this.stateManager.currentCycleShardData.ourNode.id
            )
            const localRelation = ShardFunctions.getNodeRelation(
              localHomeNode,
              this.stateManager.currentCycleShardData.ourNode.id
            )
            /* prettier-ignore */
            if (logFlags.playback) this.logger.playbackLogNote("shrd_sendCorrespondingCachedAppData", `${dataID}`, `remoteRel: ${remoteRelation} localRel: ${localRelation} qId: ${dataID} AccountBeingShared: ${utils.makeShortHash(key)} EdgeNodes:${utils.stringifyReduce(edgeNodeIds)} ConsensusNodes${utils.stringifyReduce(consensusNodeIds)}`);

            // Filter nodes before we send tell()
            const filteredNodes = this.stateManager.filterValidNodesForInternalMessage(
              correspondingAccNodes,
              'tellCorrespondingNodes',
              true,
              true
            )
            if (filteredNodes.length === 0) {
              /* prettier-ignore */
              if (logFlags.error) this.mainLogger.error("tellCorrespondingNodes: filterValidNodesForInternalMessage no valid nodes left to try");
              return null
            }
            const filteredCorrespondingAccNodes = filteredNodes

            if(this.config.p2p.useBinarySerializedEndpoints){
              const appSerializedAppData = this.stateManager.app.binarySerializeObject(
                AppObjEnum.CachedAppData, 
                message.cachedAppData.appData
              )
              const sendCacheAppDataReq: SendCachedAppDataReq = {
                topic,
                cachedAppData: {
                  dataID: message.cachedAppData.dataID,
                  appData: appSerializedAppData,
                  cycle: message.cachedAppData.cycle
                }
              }
              this.p2p.tellBinary<SendCachedAppDataReq>(
                filteredCorrespondingAccNodes, 
                InternalRouteEnum.send_cachedAppData2, 
                sendCacheAppDataReq, 
                serializeSendCachedAppDataReq,
                {
                  verification_data: verificationDataCombiner(
                    sendCacheAppDataReq.topic,
                    sendCacheAppDataReq.cachedAppData.dataID,
                  ),
                }
              )
              return

            }

            // TODO Perf: need a tellMany enhancement.  that will minimize signing and stringify required!
            this.p2p.tell(filteredCorrespondingAccNodes, 'send_cachedAppData', message)

          }
        }
      }
    }
  }

  async getLocalOrRemoteCachedAppData(topic: string, dataId: string): Promise<CachedAppData | null> {
    let cachedAppData: CachedAppData | null = null

    if (this.stateManager.currentCycleShardData == null) {
      await this.stateManager.waitForShardData()
    }

    if (this.stateManager.currentCycleShardData == null) {
      throw new Error('getLocalOrRemoteCachedAppData: network not ready')
    }
    const address = dataId

    let forceLocalGlobalLookup = false

    if (this.stateManager.accountGlobals.isGlobalAccount(address)) {
      forceLocalGlobalLookup = true
    }
    let accountIsRemote = this.stateManager.transactionQueue.isAccountRemote(address)

    if (
      this.stateManager.currentCycleShardData.nodes.length <=
      this.stateManager.currentCycleShardData.shardGlobals.consensusRadius
    ) {
      accountIsRemote = false
    }
    if (forceLocalGlobalLookup) {
      accountIsRemote = false
    }

    if (accountIsRemote) {
      const randomConsensusNode = this.stateManager.transactionQueue.getRandomConsensusNodeForAccount(address)
      if (randomConsensusNode == null) {
        throw new Error('getLocalOrRemoteAccount: no consensus node found')
      }

      // Node Precheck!
      if (
        this.stateManager.isNodeValidForInternalMessage(
          randomConsensusNode.id,
          'getLocalOrRemoteCachedAppData',
          true,
          true
        ) === false
      ) {
        /* prettier-ignore */
        if (logFlags.verbose) this.stateManager.getAccountFailDump(address, "getLocalOrRemoteCachedAppData: isNodeValidForInternalMessage failed, no retry");
        return null
      }

      const message = { topic, dataId }
      const r: CachedAppData | boolean = await this.p2p.ask(
        randomConsensusNode,
        'get_cached_app_data',
        message
      )
      if (r === false) {
        if (logFlags.error) this.mainLogger.error('ASK FAIL getLocalOrRemoteCachedAppData r === false')
      }

      const result = r as CachedAppData
      if (result != null && result.appData != null) {
        return result
      } else {
        if (logFlags.verbose)
          this.stateManager.getAccountFailDump(address, 'remote request missing data: result == null')
      }
    } else {
      // we are local!
      cachedAppData = this.getCachedItem(topic, dataId)
      if (cachedAppData != null) {

        return cachedAppData
      }
    }
    return null
  }
}

export default CachedAppDataManager
