import * as Shardus from '../shardus/shardus-types'
import { StateManager as StateManagerTypes } from '@shardus/types'
import * as utils from '../utils'

import Profiler, { cUninitializedSize } from '../utils/profiler'
import { P2PModuleContext as P2P } from '../p2p/Context'
import Storage from '../storage'
import Crypto from '../crypto'
import Logger, { logFlags } from '../logger'
import ShardFunctions from './shardFunctions'
import StateManager from '.'
import { robustQuery } from '../p2p/Utils'
import { nestedCountersInstance } from '../utils/nestedCounters'
import * as Context from '../p2p/Context'
import * as Wrapper from '../p2p/Wrapper'
import * as Self from '../p2p/Self'
import {
  AccountStateHashReq,
  AccountStateHashResp,
  GetAccountStateReq,
  GetAccountData3Req,
  GetAccountDataByRangeSmart,
  GlobalAccountReportResp,
  CycleShardData,
} from './state-manager-types'
import { safetyModeVals } from '../snapshot'
import { isDebugModeMiddleware } from '../network/debugMiddleware'
import { errorToStringFull } from '../utils'
import SyncTracker from './SyncTracker'
import { Logger as L4jsLogger } from 'log4js'

type SyncStatment = {
  p2pJoinTime: number
  timeBeforeDataSync: number
  timeBeforeDataSync2: number
  totalSyncTime: number

  cycleStarted: number
  cycleEnded: number
  numCycles: number
  syncComplete: boolean
  numNodesOnStart: number

  syncStartTime: number
  syncEndTime: number
  syncSeconds: number
  syncRanges: number

  failedAccountLoops: number
  failedAccounts: number
  failAndRestart: number
  discardedTXs: number
  nonDiscardedTXs: number

  numSyncedState: number
  numAccounts: number
  numGlobalAccounts: number

  internalFlag: boolean // makes sure we dont write logs until two sections of async code have both been hit
}
class AccountSync {
  stateManager: StateManager
  app: Shardus.App
  crypto: Crypto
  config: Shardus.StrictServerConfiguration
  profiler: Profiler

  logger: Logger
  p2p: P2P
  storage: Storage

  mainLogger: L4jsLogger
  fatalLogger: L4jsLogger
  shardLogger: L4jsLogger
  statsLogger: L4jsLogger

  dataSyncMainPhaseComplete: boolean
  globalAccountsSynced: boolean
  isSyncingAcceptedTxs: boolean
  requiredNodeCount: number

  runtimeSyncTrackerSyncing: boolean

  syncTrackerIndex: number
  initalSyncRemaining: number

  readyforTXs: boolean

  syncTrackers: SyncTracker[]

  lastWinningGlobalReportNodes: Shardus.Node[]

  statemanager_fatal: (key: string, log: string) => void

  syncStatement: SyncStatment
  isSyncStatementCompleted: boolean

  softSync_earlyOut: boolean // exit inital sync early after globals are synced
  softSync_noSyncDelay: boolean // don't delay or TXs let them try to execute
  softSync_checkInitialFlag: boolean // check initalSyncFinished before we give hash reports on sync table data

  initalSyncFinished: boolean // track when we have completed our inital data sync.

  forceSyncComplete: boolean

  /** at the start of a sync operation go ahead and ask for the next data source */
  dataSourceTest: boolean
  /** thow assert in the top level loop that managed sync trackers. Causes reset-sync-ranges.*/
  debugFail1: boolean
  /** thow assert in the top level loop that managed sync trackers. Causes APOP. Auto reverts debugFail2 to false*/
  debugFail2: boolean
  /** throw assert in the sync tracker loop that gets accounts. */
  debugFail3: boolean
  /** if dataSourceTest is true, then keep asking for a new node every one second until things break. */
  debugFail4: boolean

  constructor(
    stateManager: StateManager,

    profiler: Profiler,
    app: Shardus.App,
    logger: Logger,
    storage: Storage,
    p2p: P2P,
    crypto: Crypto,
    config: Shardus.StrictServerConfiguration
  ) {
    this.stateManager = stateManager

    this.crypto = crypto
    this.app = app
    this.logger = logger
    this.config = config
    this.profiler = profiler
    this.p2p = p2p
    this.storage = storage

    this.mainLogger = logger.getLogger('main')
    this.fatalLogger = logger.getLogger('fatal')
    this.shardLogger = logger.getLogger('shardDump')
    this.statsLogger = logger.getLogger('statsDump')

    this.statemanager_fatal = stateManager.statemanager_fatal

    this.dataSyncMainPhaseComplete = false
    this.globalAccountsSynced = false
    this.isSyncingAcceptedTxs = false

    this.syncTrackers = []
    this.runtimeSyncTrackerSyncing = false

    this.readyforTXs = false
    this.syncTrackerIndex = 1 // increments up for each new sync tracker we create gets maped to calls.

    this.clearSyncData()

    this.syncStatement = {
      cycleStarted: -1,
      cycleEnded: -1,
      numCycles: -1,
      syncComplete: false,
      numNodesOnStart: 0,
      p2pJoinTime: Self.p2pJoinTime,

      timeBeforeDataSync: 0,
      timeBeforeDataSync2: 0,
      totalSyncTime: 0,

      syncStartTime: 0,
      syncEndTime: 0,
      syncSeconds: 0,
      syncRanges: 0,

      failedAccountLoops: 0,
      failedAccounts: 0,
      failAndRestart: 0,

      discardedTXs: 0,
      nonDiscardedTXs: 0,

      numSyncedState: 0,
      numAccounts: 0,
      numGlobalAccounts: 0,

      internalFlag: false,
    }
    this.isSyncStatementCompleted = false

    this.softSync_earlyOut = false
    this.softSync_noSyncDelay = true
    this.softSync_checkInitialFlag = false

    this.initalSyncFinished = false
    this.initalSyncRemaining = 0

    this.forceSyncComplete = false

    this.dataSourceTest = false
    this.debugFail1 = false
    this.debugFail2 = false
    this.debugFail3 = false
    this.debugFail4 = false

    this.lastWinningGlobalReportNodes = []

    console.log('this.p2p', this.p2p)
  }
  // ////////////////////////////////////////////////////////////////////
  //   DATASYNC
  // ////////////////////////////////////////////////////////////////////

  // this clears state data related to the current partion we are syncinge
  clearSyncData() {
    //older comments indicate it may be odd to clear fifo locks.
    //this could even be a potential cause of the lock up since just setting fifoLocks to {} does not unstick waiting loops.

    //Will leave this config off for now so we can try and catch the lock up in beta
    if (this.config.stateManager.fifoUnlockFix) {
      //force unlock before we clear because that there is a case
      //where simply wiping the locks leaves a waiting loop stuck forever
      this.stateManager.forceUnlockAllFifoLocks('clearSyncData')
    } else {
      this.stateManager.fifoLocks = {}
      this.mainLogger.debug(`this.stateManager.fifoLocks cleared old way`)
    }
  }

  clearSyncTrackers() {
    //this seems out of place need to review it.
    this.syncTrackers = []
  }

  /***
   *    ##     ##    ###    ##    ## ########  ##       ######## ########   ######
   *    ##     ##   ## ##   ###   ## ##     ## ##       ##       ##     ## ##    ##
   *    ##     ##  ##   ##  ####  ## ##     ## ##       ##       ##     ## ##
   *    ######### ##     ## ## ## ## ##     ## ##       ######   ########   ######
   *    ##     ## ######### ##  #### ##     ## ##       ##       ##   ##         ##
   *    ##     ## ##     ## ##   ### ##     ## ##       ##       ##    ##  ##    ##
   *    ##     ## ##     ## ##    ## ########  ######## ######## ##     ##  ######
   */

  setupHandlers() {
    // /get_account_state_hash (Acc_start, Acc_end, Ts_start, Ts_end)
    // Acc_start - get data for accounts starting with this account id; inclusive
    // Acc_end - get data for accounts up to this account id; inclusive
    // Ts_start - get data newer than this timestamp
    // Ts_end - get data older than this timestamp
    // Returns a single hash of the data from the Account State Table determined by the input parameters; sort by Tx_ts  then Tx_id before taking the hash
    // Updated names:  accountStart , accountEnd, tsStart, tsEnd
    this.p2p.registerInternal(
      'get_account_state_hash',
      async (
        payload: AccountStateHashReq,
        respond: (arg0: AccountStateHashResp) => Promise<number>,
        _sender: unknown,
        _tracker: string,
        msgSize: number
      ) => {
        this.profiler.scopedProfileSectionStart('get_account_state_hash', false, msgSize)
        let responseSize = cUninitializedSize
        try {
          const result = {} as AccountStateHashResp

          if (this.softSync_checkInitialFlag && this.initalSyncFinished === false) {
            //not ready?
            result.ready = false
            result.stateHash = this.stateManager.currentCycleShardData.ourNode.id
            await respond(result)
            return
          }

          // yikes need to potentially hash only N records at a time and return an array of hashes
          const stateHash = await this.stateManager.transactionQueue.getAccountsStateHash(
            payload.accountStart,
            payload.accountEnd,
            payload.tsStart,
            payload.tsEnd
          )
          result.stateHash = stateHash
          result.ready = true
          responseSize = await respond(result)
        } catch (e) {
          this.statemanager_fatal('get_account_state_hash', e)
        } finally {
          this.profiler.scopedProfileSectionEnd('get_account_state_hash', responseSize)
        }
      }
    )

    //    /get_account_state (Acc_start, Acc_end, Ts_start, Ts_end)
    // Acc_start - get data for accounts starting with this account id; inclusive
    // Acc_end - get data for accounts up to this account id; inclusive
    // Ts_start - get data newer than this timestamp
    // Ts_end - get data older than this timestamp
    // Returns data from the Account State Table determined by the input parameters; limits result to 1000 records (as configured)
    // Updated names:  accountStart , accountEnd, tsStart, tsEnd
    this.p2p.registerInternal(
      'get_account_state',
      async (
        payload: GetAccountStateReq,
        respond: (arg0: { accountStates: Shardus.StateTableObject[] }) => Promise<number>,
        _sender: unknown,
        _tracker: string,
        msgSize: number
      ) => {
        if (this.config.stateManager == null) {
          throw new Error('this.config.stateManager == null') //TODO TSConversion  would be nice to eliminate some of these config checks.
        }
        this.profiler.scopedProfileSectionStart('get_account_state', false, msgSize)
        const result = {} as { accountStates: Shardus.StateTableObject[] }

        // max records set artificially low for better test coverage
        // todo m11: make configs for how many records to query
        const accountStates = await this.storage.queryAccountStateTable(
          payload.accountStart,
          payload.accountEnd,
          payload.tsStart,
          payload.tsEnd,
          this.config.stateManager.stateTableBucketSize
        )
        result.accountStates = accountStates
        const responseSize = await respond(result)
        this.profiler.scopedProfileSectionEnd('get_account_state', responseSize)
      }
    )

    this.p2p.registerInternal(
      'get_account_data3',
      async (
        payload: GetAccountData3Req,
        respond: (arg0: { data: GetAccountDataByRangeSmart }) => Promise<number>,
        _sender: unknown,
        _tracker: string,
        msgSize: number
      ) => {
        this.profiler.scopedProfileSectionStart('get_account_data3', false, msgSize)
        const result = {} as { data: GetAccountDataByRangeSmart } //TSConversion  This is complicated !!(due to app wrapping)  as {data: Shardus.AccountData[] | null}
        let accountData: GetAccountDataByRangeSmart | null = null
        let ourLockID = -1
        try {
          ourLockID = await this.stateManager.fifoLock('accountModification')
          // returns { wrappedAccounts, lastUpdateNeeded, wrappedAccounts2, highestTs }
          //GetAccountDataByRangeSmart
          accountData = await this.stateManager.getAccountDataByRangeSmart(
            payload.accountStart,
            payload.accountEnd,
            payload.tsStart,
            payload.maxRecords,
            payload.offset,
            payload.accountOffset
          )
        } finally {
          this.stateManager.fifoUnlock('accountModification', ourLockID)
        }

        //PERF Disiable this in production or performance testing.
        this.stateManager.testAccountDataWrapped(accountData.wrappedAccounts)
        //PERF Disiable this in production or performance testing.
        this.stateManager.testAccountDataWrapped(accountData.wrappedAccounts2)

        result.data = accountData
        const responseSize = await respond(result)
        this.profiler.scopedProfileSectionEnd('get_account_data3', responseSize)
      }
    )

    // /get_account_data_by_list (Acc_ids)
    // Acc_ids - array of accounts to get
    // Returns data from the application Account Table for just the given account ids;
    // For applications with multiple “Account” tables the returned data is grouped by table name.
    // For example: [ {Acc_id, State_after, Acc_data}, { … }, ….. ]
    // Updated names:  accountIds, max records
    this.p2p.registerInternal(
      'get_account_data_by_list',
      async (
        payload: { accountIds: string[] },
        respond: (arg0: { accountData: Shardus.WrappedData[] | null }) => Promise<number>,
        _sender: unknown,
        _tracker: string,
        msgSize: number
      ) => {
        this.profiler.scopedProfileSectionStart('get_account_data_by_list', false, msgSize)
        const result = {} as { accountData: Shardus.WrappedData[] | null }
        let accountData = null
        let ourLockID = -1
        try {
          ourLockID = await this.stateManager.fifoLock('accountModification')
          accountData = await this.app.getAccountDataByList(payload.accountIds)
        } finally {
          this.stateManager.fifoUnlock('accountModification', ourLockID)
        }
        //PERF Disiable this in production or performance testing.
        this.stateManager.testAccountDataWrapped(accountData)
        result.accountData = accountData
        const responseSize = await respond(result)
        this.profiler.scopedProfileSectionEnd('get_account_data_by_list', responseSize)
      }
    )

    Context.network.registerExternalGet('sync-statement', isDebugModeMiddleware, (_req, res) => {
      res.write(`${utils.stringifyReduce(this.syncStatement)}\n`)

      res.end()
    })

    //TODO DEBUG DO NOT USE IN LIVE NETWORK
    Context.network.registerExternalGet('sync-statement-all', isDebugModeMiddleware, async (_req, res) => {
      try {
        //wow, why does Context.p2p not work..
        const activeNodes = Wrapper.p2p.state.getNodes()
        if (activeNodes) {
          for (const node of activeNodes.values()) {
            const getResp = await this.logger._internalHackGetWithResp(
              `${node.externalIp}:${node.externalPort}/sync-statement`
            )
            console.log('getResp active', getResp.body)
            res.write(`${node.externalIp}:${node.externalPort}/sync-statement\n`)
            res.write(getResp.body ? getResp.body : 'no data')
          }
        }
        res.write(`joining nodes...\n`)
        const joiningNodes = Wrapper.p2p.state.getNodesRequestingJoin()
        if (joiningNodes) {
          for (const node of joiningNodes.values()) {
            const getResp = await this.logger._internalHackGetWithResp(
              `${node.externalIp}:${node.externalPort}/sync-statement`
            )
            console.log('getResp syncing', getResp.body)
            res.write(`${node.externalIp}:${node.externalPort}/sync-statement\n`)
            res.write(getResp.body ? getResp.body : 'no data')
          }
        }

        res.write(`sending default logs to all nodes\n`)
      } catch (e) {
        res.write(`${e}\n`)
      }

      res.end()
    })

    Context.network.registerExternalGet('forceFinishSync', isDebugModeMiddleware, (_req, res) => {
      res.write(`sync forcing complete. \n`)
      this.forceSyncComplete = true
      res.end()
    })

    Context.network.registerExternalGet('dataSourceTest', isDebugModeMiddleware, (_req, res) => {
      this.dataSourceTest = !this.dataSourceTest
      res.write(`dataSourceTest = ${this.dataSourceTest} \n`)
      res.end()
    })
    Context.network.registerExternalGet('syncFail1', isDebugModeMiddleware, (_req, res) => {
      this.debugFail1 = !this.debugFail1
      res.write(`debugFail1 = ${this.debugFail1} \n`)
      res.end()
    })
    Context.network.registerExternalGet('syncFail2', isDebugModeMiddleware, (_req, res) => {
      this.debugFail2 = !this.debugFail2
      res.write(`debugFail2 = ${this.debugFail2} \n`)
      res.end()
    })
    Context.network.registerExternalGet('syncFail3', isDebugModeMiddleware, (_req, res) => {
      this.debugFail3 = !this.debugFail3
      res.write(`debugFail3 = ${this.debugFail3} \n`)
      res.end()
    })
    Context.network.registerExternalGet('syncFail4', isDebugModeMiddleware, (_req, res) => {
      this.debugFail4 = !this.debugFail4
      res.write(`debugFail4 = ${this.debugFail4} \n`)
      res.end()
    })
  }

  /***
   *    #### ##    ## #### ######## ####    ###    ##        ######  ##    ## ##    ##  ######  ##     ##    ###    #### ##    ##
   *     ##  ###   ##  ##     ##     ##    ## ##   ##       ##    ##  ##  ##  ###   ## ##    ## ###   ###   ## ##    ##  ###   ##
   *     ##  ####  ##  ##     ##     ##   ##   ##  ##       ##         ####   ####  ## ##       #### ####  ##   ##   ##  ####  ##
   *     ##  ## ## ##  ##     ##     ##  ##     ## ##        ######     ##    ## ## ## ##       ## ### ## ##     ##  ##  ## ## ##
   *     ##  ##  ####  ##     ##     ##  ######### ##             ##    ##    ##  #### ##       ##     ## #########  ##  ##  ####
   *     ##  ##   ###  ##     ##     ##  ##     ## ##       ##    ##    ##    ##   ### ##    ## ##     ## ##     ##  ##  ##   ###
   *    #### ##    ## ####    ##    #### ##     ## ########  ######     ##    ##    ##  ######  ##     ## ##     ## #### ##    ##
   */

  /**
   * initialSyncMain
   * syncs state table data and account data
   * this is only called when a node is first syncing into the network
   *   later on syncing will be from runtime syncTracker ranges
   * @param requiredNodeCount
   */
  async initialSyncMain(requiredNodeCount: number) {
    const safetyMode = safetyModeVals.safetyMode

    //not great, but this currently triggers the storage init in the dapp
    //todo: replace with a specific   initDappStorage() function
    this.app.deleteLocalAccountData()

    // Dont sync if first node
    if (this.p2p.isFirstSeed || safetyMode) {
      this.dataSyncMainPhaseComplete = true
      this.syncStatement.syncComplete = true
      this.initalSyncFinished = true

      this.globalAccountsSynced = true
      this.stateManager.accountGlobals.hasknownGlobals = true
      this.readyforTXs = true
      if (logFlags.debug) {
        if (this.p2p.isFirstSeed) this.mainLogger.debug(`DATASYNC: isFirstSeed = true. skipping sync`)
        if (safetyMode) this.mainLogger.debug(`DATASYNC: safetyMode = true. skipping sync`)
      }

      // various sync statement stats are zeroed out because we are the first node and dont sync
      this.syncStatement.cycleStarted = 0
      this.syncStatement.cycleEnded = 0
      this.syncStatement.numCycles = 1

      this.syncStatement.syncSeconds = 0
      this.syncStatement.syncStartTime = Date.now()
      this.syncStatement.syncEndTime = this.syncStatement.syncStartTime
      this.syncStatement.numNodesOnStart = 0

      this.syncStatement.p2pJoinTime = Self.p2pJoinTime

      this.syncStatement.timeBeforeDataSync = (Date.now() - Self.p2pSyncEnd) / 1000
      this.syncStatement.timeBeforeDataSync2 = this.syncStatement.timeBeforeDataSync

      /* prettier-ignore */ nestedCountersInstance.countEvent('sync', `sync comlete numCycles: ${this.syncStatement.numCycles} start:${this.syncStatement.cycleStarted} end:${this.syncStatement.cycleEnded}`)

      /* prettier-ignore */ if (logFlags.playback) this.logger.playbackLogNote('shrd_sync_syncStatement', ` `, `${utils.stringifyReduce(this.syncStatement)}`)

      this.syncStatmentIsComplete()
      this.statemanager_fatal(
        'shrd_sync_syncStatement-tempdebug',
        `${utils.stringifyReduce(this.syncStatement)}`
      )
      return
    }

    this.isSyncingAcceptedTxs = true

    this.syncStatement.timeBeforeDataSync = (Date.now() - Self.p2pSyncEnd) / 1000

    await utils.sleep(5000) // Temporary delay to make it easier to attach a debugger
    if (logFlags.console) console.log('syncStateData start')
    // delete and re-create some tables before we sync:
    await this.storage.clearAppRelatedState()
    this.app.deleteLocalAccountData()

    if (logFlags.debug) this.mainLogger.debug(`DATASYNC: starting syncStateData`)

    this.requiredNodeCount = requiredNodeCount

    let hasValidShardData = this.stateManager.currentCycleShardData != null
    if (this.stateManager.currentCycleShardData != null) {
      hasValidShardData = this.stateManager.currentCycleShardData.hasCompleteData
    }

    //wait untill we have valid shard data
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    hasValidShardData = await this.waitForValidShardData(hasValidShardData)

    this.syncStatement.cycleStarted = this.stateManager.currentCycleShardData.cycleNumber
    this.syncStatement.syncStartTime = Date.now()
    this.syncStatement.numNodesOnStart = this.stateManager.currentCycleShardData.activeNodes.length
    this.syncStatement.p2pJoinTime = Self.p2pJoinTime

    let nodeShardData = this.stateManager.currentCycleShardData.nodeShardData
    /* prettier-ignore */ if (logFlags.console) console.log('GOT current cycle ' + '   time:' + utils.stringifyReduce(nodeShardData))

    let rangesToSync: StateManagerTypes.shardFunctionTypes.AddressRange[]

    let cycle = this.stateManager.currentCycleShardData.cycleNumber

    let homePartition = nodeShardData.homePartition

    /* prettier-ignore */ if (logFlags.console) console.log(`homePartition: ${homePartition} storedPartitions: ${utils.stringifyReduce(nodeShardData.storedPartitions)}`)

    // syncRangeGoal helps us calculate how many partitions per range we need to get our data in chunksGuide number of chunks.
    // chunksGuide === 4, would mean that in a network with many nodes most of the time we would have 4 ranges to sync.
    // there could be less ranges if the network is smaller.
    // TODO review that this is up to spec.
    rangesToSync = this.initRangesToSync(nodeShardData, homePartition)
    this.syncStatement.syncRanges = rangesToSync.length

    for (const range of rangesToSync) {
      this.createSyncTrackerByRange(range, cycle, true)
    }

    const useGlobalAccounts = true // this should stay true now.

    if (useGlobalAccounts === true) {
      this.createSyncTrackerByForGlobals(cycle, true)
    }

    this.syncStatement.timeBeforeDataSync2 = (Date.now() - Self.p2pSyncEnd) / 1000
    if (useGlobalAccounts === true) {
      // must get a list of globals before we can listen to any TXs, otherwise the isGlobal function returns bad values
      await this.stateManager.accountGlobals.getGlobalListEarly()
      this.readyforTXs = true
    } else {
      //hack force this to true
      this.stateManager.accountGlobals.hasknownGlobals = true
    }

    //This has an inner loop that will process sync trackers one at a time.
    //The outer while loop can be used to recalculate the list of sync trackers and try again
    let breakCount = 0
    let running = true
    while (running) {
      try {
        for (const syncTracker of this.syncTrackers) {
          if (this.dataSyncMainPhaseComplete === true) {
            // this get set if we force sync to finish
            running = false
            break
          }

          if (this.debugFail1) {
            nestedCountersInstance.countEvent('sync', `syncStateDataGlobals: debugFail1 reset-sync-ranges`)
            await utils.sleep(3000)
            //will cause a sync reset of all trackers
            throw new Error('reset-sync-ranges debugFail1')
          }
          if (this.debugFail2) {
            nestedCountersInstance.countEvent('sync', `syncStateDataGlobals: debugFail2 cause apop`)
            await utils.sleep(3000)
            this.debugFail2 = false
            //should cause apop
            throw new Error('debugFail2 causes apop')
          }

          // let partition = syncTracker.partition
          /* prettier-ignore */ if (logFlags.console) console.log(`syncTracker start. time:${Date.now()} data: ${utils.stringifyReduceLimit(syncTracker)}}`)
          /* prettier-ignore */ if (logFlags.playback) this.logger.playbackLogNote('shrd_sync_trackerRangeStart', ` `, ` ${utils.stringifyReduceLimit(syncTracker.range)} `)

          syncTracker.syncStarted = true

          if (syncTracker.isGlobalSyncTracker === false) {
            if (this.softSync_earlyOut === true) {
              // do nothing realtime sync will work on this later
            } else {
              //await this.syncStateDataForRange(syncTracker.range)
              await syncTracker.syncStateDataForRange2() //syncTracker.range)
            }
          } else {
            /* prettier-ignore */ if (logFlags.console) console.log(`syncTracker syncStateDataGlobals start. time:${Date.now()} data: ${utils.stringifyReduceLimit(syncTracker)}}`)
            await syncTracker.syncStateDataGlobals() //syncTracker)
          }
          syncTracker.syncFinished = true

          /* prettier-ignore */ if (logFlags.playback) this.logger.playbackLogNote('shrd_sync_trackerRangeEnd', ` `, ` ${utils.stringifyReduceLimit(syncTracker.range)} `)
          this.clearSyncData()
        }
        //if we get here without an exception that we are finished with the outer loop
        running = false
      } catch (error) {
        if (error.message.includes('reset-sync-ranges')) {
          this.statemanager_fatal(
            `mainSyncLoop_reset-sync-ranges`,
            'DATASYNC: reset-sync-ranges: ' + errorToStringFull(error)
          )

          if (breakCount > this.config.stateManager.maxDataSyncRestarts) {
            this.statemanager_fatal(`mainSyncLoop_reset-sync-ranges-givingUP`, 'too many tries')
            running = false
            this.clearSyncTrackers()

            /* prettier-ignore */ nestedCountersInstance.countRareEvent('sync', `RETRYSYNC: too many exceptions in accound data sync.  Init apop`)
            this.stateManager.initApoptosisAndQuitSyncing('too many exceptions in accound data sync')

            return
          }

          breakCount++
          this.clearSyncData()

          let cleared = 0
          let kept = 0
          let newTrackers = 0
          const trackersToKeep = []
          let keptGlobal = false
          for (const syncTracker of this.syncTrackers) {
            //keep unfinished global sync trackers
            if (syncTracker.isGlobalSyncTracker === true && syncTracker.syncFinished === false) {
              trackersToKeep.push(syncTracker)
              kept++
              keptGlobal = true
            } else {
              cleared++
            }
          }
          this.syncTrackers = trackersToKeep

          //get fresh nodeShardData, homePartition and cycle so that we can re init the sync ranges.
          nodeShardData = this.stateManager.currentCycleShardData.nodeShardData
          console.log('RETRYSYNC: GOT current cycle ' + '   time:' + utils.stringifyReduce(nodeShardData))
          const lastCycle = cycle
          cycle = this.stateManager.currentCycleShardData.cycleNumber
          homePartition = nodeShardData.homePartition
          console.log(
            `RETRYSYNC: homePartition: ${homePartition} storedPartitions: ${utils.stringifyReduce(
              nodeShardData.storedPartitions
            )}`
          )

          //init global if we did not complete syncing them before
          if (keptGlobal === false && this.globalAccountsSynced === false && useGlobalAccounts === true) {
            this.createSyncTrackerByForGlobals(cycle, true)
          }

          //init new non global trackers
          rangesToSync = this.initRangesToSync(nodeShardData, homePartition, 4, 4)
          this.syncStatement.syncRanges = rangesToSync.length
          for (const range of rangesToSync) {
            this.createSyncTrackerByRange(range, cycle, true)
            newTrackers++
          }

          /* prettier-ignore */ nestedCountersInstance.countRareEvent('sync', `RETRYSYNC: lastCycle: ${lastCycle} cycle: ${cycle} ${JSON.stringify({ cleared, kept, newTrackers })}`)

          continue //resume loop at top!
        } else {
          this.statemanager_fatal(
            `initialSyncMain unhandledEX`,
            'initialSyncMain unhandledEX:' + errorToStringFull(error)
          )
          running = false

          nestedCountersInstance.countRareEvent('sync', `initialSyncMain unhandledEX.  Init apop`)
          this.stateManager.initApoptosisAndQuitSyncing('initialSyncMain unhandledEX')
        }
      }
    }
    if (logFlags.console) console.log('syncStateData end' + '   time:' + Date.now())
  }

  private async waitForValidShardData(hasValidShardData: boolean) {
    while (hasValidShardData === false) {
      this.stateManager.getCurrentCycleShardData()
      await utils.sleep(1000)
      if (this.stateManager.currentCycleShardData == null) {
        /* prettier-ignore */ if (logFlags.playback) this.logger.playbackLogNote('shrd_sync_waitForShardData', ` `, ` ${utils.stringifyReduce(this.stateManager.currentCycleShardData)} `)
        hasValidShardData = false
      }
      if (this.stateManager.currentCycleShardData != null) {
        if (this.stateManager.currentCycleShardData.hasCompleteData == false) {
          const temp = this.p2p.state.getActiveNodes(null)
          if (logFlags.playback)
            this.logger.playbackLogNote(
              'shrd_sync_waitForShardData',
              ` `,
              `hasCompleteData:${
                this.stateManager.currentCycleShardData.hasCompleteData
              } active:${utils.stringifyReduce(temp)} ${utils.stringifyReduce(
                this.stateManager.currentCycleShardData
              )} `
            )
        } else {
          hasValidShardData = true
        }
      }
    }
    return hasValidShardData
  }

  private initRangesToSync(
    nodeShardData: StateManagerTypes.shardFunctionTypes.NodeShardData,
    homePartition: number,
    chunksGuide = 4,
    minSyncRangeGuide = 1
  ): StateManagerTypes.shardFunctionTypes.AddressRange[] {
    // todo consider making minSyncRangeGuide = 3 or 4..
    const syncRangeGoal = Math.max(
      minSyncRangeGuide,
      Math.min(
        chunksGuide,
        Math.floor(this.stateManager.currentCycleShardData.shardGlobals.numPartitions / chunksGuide)
      )
    )
    let partitionsCovered = 0
    let partitionsPerRange = 1
    const rangesToSync = [] //, rangesToSync: StateManagerTypes.shardFunctionTypes.AddressRange[]

    if (nodeShardData.storedPartitions.rangeIsSplit === true) {
      partitionsCovered =
        nodeShardData.storedPartitions.partitionEnd1 - nodeShardData.storedPartitions.partitionStart1
      partitionsCovered +=
        nodeShardData.storedPartitions.partitionEnd2 - nodeShardData.storedPartitions.partitionStart2
      partitionsPerRange = Math.max(Math.floor(partitionsCovered / syncRangeGoal), 1)
      if (logFlags.console)
        console.log(
          `syncRangeGoal ${syncRangeGoal}  chunksGuide:${chunksGuide} numPartitions:${this.stateManager.currentCycleShardData.shardGlobals.numPartitions} partitionsPerRange:${partitionsPerRange}`
        )

      let start = nodeShardData.storedPartitions.partitionStart1
      let end = nodeShardData.storedPartitions.partitionEnd1
      let currentStart = start
      let currentEnd = 0
      let nextLowAddress: string | null = null
      let i = 0
      while (currentEnd < end) {
        currentEnd = Math.min(currentStart + partitionsPerRange, end)
        const range = ShardFunctions.partitionToAddressRange2(
          this.stateManager.currentCycleShardData.shardGlobals,
          currentStart,
          currentEnd
        )

        const { address1, address2 } = ShardFunctions.getNextAdjacentAddresses(range.high)
        range.high = address1

        if (nextLowAddress != null) {
          range.low = nextLowAddress
        }
        /* prettier-ignore */ if (logFlags.console) console.log(`range ${i}  s:${currentStart} e:${currentEnd} h: ${homePartition}  a1: ${range.low} a2: ${range.high}`)
        nextLowAddress = address2
        currentStart = currentEnd
        i++
        rangesToSync.push(range)
      }

      start = nodeShardData.storedPartitions.partitionStart2
      end = nodeShardData.storedPartitions.partitionEnd2
      currentStart = start
      currentEnd = 0
      nextLowAddress = null

      while (currentEnd < end) {
        currentEnd = Math.min(currentStart + partitionsPerRange, end)
        const range = ShardFunctions.partitionToAddressRange2(
          this.stateManager.currentCycleShardData.shardGlobals,
          currentStart,
          currentEnd
        )

        const { address1, address2 } = ShardFunctions.getNextAdjacentAddresses(range.high)
        range.high = address1

        if (nextLowAddress != null) {
          range.low = nextLowAddress
        }
        /* prettier-ignore */ if (logFlags.console) console.log(`range ${i}  s:${currentStart} e:${currentEnd} h: ${homePartition} a1: ${range.low} a2: ${range.high}`)

        nextLowAddress = address2
        currentStart = currentEnd
        i++
        rangesToSync.push(range)
      }
    } else {
      partitionsCovered =
        nodeShardData.storedPartitions.partitionEnd - nodeShardData.storedPartitions.partitionStart
      partitionsPerRange = Math.max(Math.floor(partitionsCovered / syncRangeGoal), 1)
      if (logFlags.console)
        console.log(
          `syncRangeGoal ${syncRangeGoal}  chunksGuide:${chunksGuide} numPartitions:${this.stateManager.currentCycleShardData.shardGlobals.numPartitions} partitionsPerRange:${partitionsPerRange}`
        )

      const start = nodeShardData.storedPartitions.partitionStart
      const end = nodeShardData.storedPartitions.partitionEnd

      let currentStart = start
      let currentEnd = 0
      let nextLowAddress: string | null = null
      let i = 0
      while (currentEnd < end) {
        currentEnd = Math.min(currentStart + partitionsPerRange, end)
        const range = ShardFunctions.partitionToAddressRange2(
          this.stateManager.currentCycleShardData.shardGlobals,
          currentStart,
          currentEnd
        )

        const { address1, address2 } = ShardFunctions.getNextAdjacentAddresses(range.high)
        range.high = address1

        if (nextLowAddress != null) {
          range.low = nextLowAddress
        }
        /* prettier-ignore */ if (logFlags.console) console.log(`range ${i}  s:${currentStart} e:${currentEnd} h: ${homePartition}  a1: ${range.low} a2: ${range.high}`)
        nextLowAddress = address2
        currentStart = currentEnd
        i++
        rangesToSync.push(range)
      }
    }

    // if we don't have a range to sync yet manually sync the whole range.
    if (rangesToSync.length === 0) {
      if (logFlags.console) console.log(`syncStateData ranges: pushing full range, no ranges found`)
      const range = ShardFunctions.partitionToAddressRange2(
        this.stateManager.currentCycleShardData.shardGlobals,
        0,
        this.stateManager.currentCycleShardData.shardGlobals.numPartitions - 1
      )
      rangesToSync.push(range)
    }
    if (logFlags.console) console.log(`syncStateData ranges: ${utils.stringifyReduce(rangesToSync)}}`)

    return rangesToSync
  }

  /***
   *     ######   ######## ######## ########   #######  ########  ##     ##  ######  ########  ######   ##        #######  ########     ###    ##       ########  ######## ########   #######  ########  ########
   *    ##    ##  ##          ##    ##     ## ##     ## ##     ## ##     ## ##    ##    ##    ##    ##  ##       ##     ## ##     ##   ## ##   ##       ##     ## ##       ##     ## ##     ## ##     ##    ##
   *    ##        ##          ##    ##     ## ##     ## ##     ## ##     ## ##          ##    ##        ##       ##     ## ##     ##  ##   ##  ##       ##     ## ##       ##     ## ##     ## ##     ##    ##
   *    ##   #### ######      ##    ########  ##     ## ########  ##     ##  ######     ##    ##   #### ##       ##     ## ########  ##     ## ##       ########  ######   ########  ##     ## ########     ##
   *    ##    ##  ##          ##    ##   ##   ##     ## ##     ## ##     ##       ##    ##    ##    ##  ##       ##     ## ##     ## ######### ##       ##   ##   ##       ##        ##     ## ##   ##      ##
   *    ##    ##  ##          ##    ##    ##  ##     ## ##     ## ##     ## ##    ##    ##    ##    ##  ##       ##     ## ##     ## ##     ## ##       ##    ##  ##       ##        ##     ## ##    ##     ##
   *     ######   ########    ##    ##     ##  #######  ########   #######   ######     ##     ######   ########  #######  ########  ##     ## ######## ##     ## ######## ##         #######  ##     ##    ##
   */
  /**
   * getRobustGlobalReport
   *
   */
  async getRobustGlobalReport(): Promise<GlobalAccountReportResp> {
    this.lastWinningGlobalReportNodes = []

    const equalFn = (a: GlobalAccountReportResp, b: GlobalAccountReportResp) => {
      // these fail cases should not count towards forming an hash consenus
      if (a.combinedHash == null || a.combinedHash === '') {
        return false
      }
      return a.combinedHash === b.combinedHash
    }
    const queryFn = async (node: Shardus.Node) => {
      // Node Precheck!
      if (
        this.stateManager.isNodeValidForInternalMessage(node.id, 'getRobustGlobalReport', true, true) ===
        false
      ) {
        return {
          ready: false,
          msg: `getRobustGlobalReport invalid node to ask: ${utils.stringifyReduce(node.id)}`,
        }
      }

      let result = await this.p2p.ask(node, 'get_globalaccountreport', {})
      if (result === false) {
        /* prettier-ignore */ if (logFlags.error) this.mainLogger.error(`ASK FAIL getRobustGlobalReport result === false node:${utils.stringifyReduce(node.id)}`)
      }
      if (result === null) {
        /* prettier-ignore */ if (logFlags.error) this.mainLogger.error(`ASK FAIL getRobustGlobalReport result === null node:${utils.stringifyReduce(node.id)}`)
      }

      // TODO I dont know the best way to handle a non null network error here, below is something I had before but disabled for some reason
      if (result != null && result.accounts == null) {
        if (logFlags.error) this.mainLogger.error('ASK FAIL getRobustGlobalReport result.stateHash == null')
        result = { ready: false, msg: `invalid data format: ${Math.random()}` }
      }
      if (result != null && result.ready === false) {
        if (logFlags.error) this.mainLogger.error('ASK FAIL getRobustGlobalReport result.ready === false')
        result = { ready: false, msg: `not ready: ${Math.random()}` }
      }
      return result
    }
    //can ask any active nodes for global data.
    const nodes: Shardus.Node[] = this.stateManager.currentCycleShardData.activeNodes
    // let nodes = this.getActiveNodesInRange(lowAddress, highAddress) // this.p2p.state.getActiveNodes(this.p2p.id)
    if (nodes.length === 0) {
      if (logFlags.debug) this.mainLogger.debug(`no nodes available`)
      return // nothing to do
    }
    /* prettier-ignore */ if (logFlags.debug) this.mainLogger.debug(`DATASYNC: robustQuery getRobustGlobalReport ${utils.stringifyReduce(nodes.map((node) => utils.makeShortHash(node.id) + ':' + node.externalPort))}`)
    let result: {
      ready: unknown
      combinedHash?: string
      accounts?: { id: string; hash: string; timestamp: number }[]
    }
    let winners: string | unknown[]
    try {
      const robustQueryResult = await robustQuery(nodes, queryFn, equalFn, 3, false)

      // if we did not get a result at all wait, log and retry
      if (robustQueryResult === null) {
        /* prettier-ignore */ if (logFlags.debug) this.mainLogger.debug(`DATASYNC: getRobustGlobalReport results === null wait 10 seconds and try again. nodes:${nodes.length} `)
        /* prettier-ignore */ if (logFlags.console) console.log(`DATASYNC: getRobustGlobalReport results === null wait 10 seconds and try again. nodes:${nodes.length}  `)
        nestedCountersInstance.countEvent('sync', 'DATASYNC: getRobustGlobalReport results === null')
        await utils.sleep(10 * 1000) //wait 10 seconds and try again.
        return await this.getRobustGlobalReport()
      }

      result = robustQueryResult.topResult
      winners = robustQueryResult.winningNodes

      // if the result is not robust wait, throw an execption
      if (robustQueryResult.isRobustResult == false) {
        /* prettier-ignore */ if (logFlags.debug) this.mainLogger.debug('getRobustGlobalReport: robustQuery isRobustResult == false')
        this.statemanager_fatal(
          `getRobustGlobalReport_nonRobust`,
          'getRobustGlobalReport: robustQuery isRobustResult == false'
        )
        /* prettier-ignore */ nestedCountersInstance.countEvent('sync', 'DATASYNC: getRobustGlobalReport: robustQuery isRobustResult == false')
        throw new Error('FailAndRestartPartition_globalReport_A')
      }

      // if the reports are not ready then wait, log an retry
      if (result.ready === false) {
        /* prettier-ignore */ if (logFlags.debug) this.mainLogger.debug(`DATASYNC: getRobustGlobalReport results not ready wait 10 seconds and try again `)
        /* prettier-ignore */ if (logFlags.console) console.log(`DATASYNC: getRobustGlobalReport results not ready wait 10 seconds and try again `)
        /* prettier-ignore */ nestedCountersInstance.countEvent('sync', 'DATASYNC: getRobustGlobalReport results not ready wait 10 seconds and try again')
        await utils.sleep(10 * 1000) //wait 10 seconds and try again.
        return await this.getRobustGlobalReport()
      }
    } catch (ex) {
      // NOTE: no longer expecting an exception from robust query in cases where we do not have enough votes or respones!
      //       but for now if isRobustResult == false then we local code wil throw an exception
      /* prettier-ignore */ if (logFlags.debug) this.mainLogger.debug('getRobustGlobalReport: robustQuery ' + ex.name + ': ' + ex.message + ' at ' + ex.stack)
      this.statemanager_fatal(
        `getRobustGlobalReport_ex`,
        'getRobustGlobalReport: robustQuery ' + ex.name + ': ' + ex.message + ' at ' + ex.stack
      )
      throw new Error('FailAndRestartPartition_globalReport_B')
    }
    if (!winners || winners.length === 0) {
      /* prettier-ignore */ if (logFlags.debug) this.mainLogger.debug(`DATASYNC: getRobustGlobalReport no winners, going to throw fail and restart`)
      this.statemanager_fatal(
        `getRobustGlobalReport_noWin`,
        `DATASYNC: getRobustGlobalReport no winners, going to throw fail and restart`
      ) // todo: consider if this is just an error
      throw new Error('FailAndRestartPartition_globalReport_noWin')
    }
    /* prettier-ignore */ if (logFlags.debug) this.mainLogger.debug(`DATASYNC: getRobustGlobalReport found a winner.  results: ${utils.stringifyReduce(result)}`)

    this.lastWinningGlobalReportNodes = winners as Shardus.Node[]

    return result as GlobalAccountReportResp
  }

  /**
   * failandRestart
   *     this is going away
   */
  async failandRestart_depricated() {
    this.mainLogger.info(`DATASYNC: failandRestart`)
    this.logger.playbackLogState('datasyncFail', '', '')
    this.clearSyncData()

    // using set timeout before we resume to prevent infinite stack depth.
    await utils.sleep(1000)

    let anyNonGlobalSyncTrackersLeft = false
    for (const syncTracker of this.syncTrackers) {
      if (syncTracker.isGlobalSyncTracker === false && syncTracker.syncFinished === false) {
        anyNonGlobalSyncTrackersLeft = true
      }
    }

    if (this.forceSyncComplete) {
      nestedCountersInstance.countEvent('sync', 'forceSyncComplete')
      this.syncStatmentIsComplete()
      this.clearSyncData()
      this.skipSync()

      //make sync trackers clean up
      for (const syncTracker of this.syncTrackers) {
        syncTracker.syncFinished = true
      }
      return
    }

    /* prettier-ignore */ nestedCountersInstance.countEvent('sync', `fail and restart non globals left:${anyNonGlobalSyncTrackersLeft}`)
    this.syncStatement.failAndRestart++

    //TODO proper restart not useing global var
  }

  /**
   * failAndDontRestartSync
   */
  failAndDontRestartSync() {
    this.mainLogger.info(`DATASYNC: failAndDontRestartSync`)
    // need to clear more?
    this.clearSyncData()
    this.clearSyncTrackers()
  }

  /***
   *    ########  ##     ## ##    ## ######## #### ##     ## ########     ######  ##    ## ##    ##  ######  ##     ##    ###    ##    ## ########  ##       ######## ########   ######
   *    ##     ## ##     ## ###   ##    ##     ##  ###   ### ##          ##    ##  ##  ##  ###   ## ##    ## ##     ##   ## ##   ###   ## ##     ## ##       ##       ##     ## ##    ##
   *    ##     ## ##     ## ####  ##    ##     ##  #### #### ##          ##         ####   ####  ## ##       ##     ##  ##   ##  ####  ## ##     ## ##       ##       ##     ## ##
   *    ########  ##     ## ## ## ##    ##     ##  ## ### ## ######       ######     ##    ## ## ## ##       ######### ##     ## ## ## ## ##     ## ##       ######   ########   ######
   *    ##   ##   ##     ## ##  ####    ##     ##  ##     ## ##                ##    ##    ##  #### ##       ##     ## ######### ##  #### ##     ## ##       ##       ##   ##         ##
   *    ##    ##  ##     ## ##   ###    ##     ##  ##     ## ##          ##    ##    ##    ##   ### ##    ## ##     ## ##     ## ##   ### ##     ## ##       ##       ##    ##  ##    ##
   *    ##     ##  #######  ##    ##    ##    #### ##     ## ########     ######     ##    ##    ##  ######  ##     ## ##     ## ##    ## ########  ######## ######## ##     ##  ######
   */

  /**
   * updateRuntimeSyncTrackers
   *
   * called in update shard values to handle sync trackers that have finished and need to restar TXs
   */
  updateRuntimeSyncTrackers() {
    let initalSyncRemaining = 0
    if (this.syncTrackers != null) {
      for (let i = this.syncTrackers.length - 1; i >= 0; i--) {
        // eslint-disable-next-line security/detect-object-injection
        const syncTracker = this.syncTrackers[i]

        if (syncTracker.isPartOfInitialSync) {
          initalSyncRemaining++
        }

        if (syncTracker.syncFinished === true) {
          /* prettier-ignore */ if (logFlags.playback) this.logger.playbackLogNote('shrd_sync_trackerRangeClear', ` `, ` ${utils.stringifyReduce(syncTracker.range)} `)

          // allow syncing queue entries to resume!
          for (const queueEntry of syncTracker.queueEntries) {
            //need to decrement this per key
            for (const key of queueEntry.uniqueKeys) {
              // eslint-disable-next-line security/detect-object-injection
              if (syncTracker.keys[key] === true) {
                queueEntry.syncCounter--
              }
            }

            if (queueEntry.syncCounter <= 0) {
              // dont adjust a
              const found = this.stateManager.transactionQueue.getQueueEntry(queueEntry.acceptedTx.txId)
              if (!found) {
                this.logger.playbackLogNote(
                  'shrd_sync_wakeupTX_skip1',
                  `${queueEntry.acceptedTx.txId}`,
                  `not in active queue qId: ${queueEntry.entryID} ts: ${
                    queueEntry.txKeys.timestamp
                  } acc: ${utils.stringifyReduce(queueEntry.txKeys.allKeys)}`
                )
                continue
              }
              // todo other stats to not mess with?
              if (queueEntry.state != 'syncing') {
                this.logger.playbackLogNote(
                  'shrd_sync_wakeupTX_skip2',
                  `${queueEntry.acceptedTx.txId}`,
                  `state!=syncing ${queueEntry.state} qId: ${queueEntry.entryID} ts: ${
                    queueEntry.txKeys.timestamp
                  } acc: ${utils.stringifyReduce(queueEntry.txKeys.allKeys)}`
                )
                continue
              }

              const before = queueEntry.ourNodeInTransactionGroup
              if (queueEntry.ourNodeInTransactionGroup === false) {
                const old = queueEntry.transactionGroup
                queueEntry.transactionGroup = null
                this.stateManager.transactionQueue.queueEntryGetTransactionGroup(queueEntry)

                //Restore the TX group, because we only want to know what nodes were in the group at the time of the TX
                queueEntry.transactionGroup = old
                if (logFlags.playback)
                  this.logger.playbackLogNote(
                    'shrd_sync_wakeupTX_txGroupUpdate',
                    `${queueEntry.acceptedTx.txId}`,
                    `new value: ${queueEntry.ourNodeInTransactionGroup}   qId: ${queueEntry.entryID} ts: ${
                      queueEntry.txKeys.timestamp
                    } acc: ${utils.stringifyReduce(queueEntry.txKeys.allKeys)}`
                  )
              }

              queueEntry.txGroupDebug = `${before} -> ${queueEntry.ourNodeInTransactionGroup}`

              //if(queueEntry.ourNodeInTransactionGroup === true){
              queueEntry.state = 'aging'
              queueEntry.didWakeup = true
              this.stateManager.transactionQueue.updateHomeInformation(queueEntry)
              if (logFlags.playback)
                this.logger.playbackLogNote(
                  'shrd_sync_wakeupTX',
                  `${queueEntry.acceptedTx.txId}`,
                  `before: ${before} inTXGrp: ${queueEntry.ourNodeInTransactionGroup} qId: ${
                    queueEntry.entryID
                  } ts: ${queueEntry.txKeys.timestamp} acc: ${utils.stringifyReduce(
                    queueEntry.txKeys.allKeys
                  )}`
                )
            }
          }
          syncTracker.queueEntries = []
          this.syncTrackers.splice(i, 1)
        }
      }
      /* prettier-ignore */ if (logFlags.playback) this.logger.playbackLogNote('shrd_sync_trackerRangeClearFinished', ` `, `num trackers left: ${this.syncTrackers.length} `)

      if (this.initalSyncRemaining > 0 && initalSyncRemaining === 0) {
        this.initalSyncFinished = true
        this.initalSyncRemaining = 0
        if (logFlags.debug) this.mainLogger.debug(`DATASYNC: initalSyncFinished.`)
        /* prettier-ignore */ nestedCountersInstance.countEvent('sync', `initialSyncFinished ${this.stateManager.currentCycleShardData.cycleNumber}`)
      }
    }
  }

  /***
   *     ######  ##    ## ##    ##  ######  ########  ##     ## ##    ## ######## #### ##     ## ######## ######## ########     ###     ######  ##    ## ######## ########   ######
   *    ##    ##  ##  ##  ###   ## ##    ## ##     ## ##     ## ###   ##    ##     ##  ###   ### ##          ##    ##     ##   ## ##   ##    ## ##   ##  ##       ##     ## ##    ##
   *    ##         ####   ####  ## ##       ##     ## ##     ## ####  ##    ##     ##  #### #### ##          ##    ##     ##  ##   ##  ##       ##  ##   ##       ##     ## ##
   *     ######     ##    ## ## ## ##       ########  ##     ## ## ## ##    ##     ##  ## ### ## ######      ##    ########  ##     ## ##       #####    ######   ########   ######
   *          ##    ##    ##  #### ##       ##   ##   ##     ## ##  ####    ##     ##  ##     ## ##          ##    ##   ##   ######### ##       ##  ##   ##       ##   ##         ##
   *    ##    ##    ##    ##   ### ##    ## ##    ##  ##     ## ##   ###    ##     ##  ##     ## ##          ##    ##    ##  ##     ## ##    ## ##   ##  ##       ##    ##  ##    ##
   *     ######     ##    ##    ##  ######  ##     ##  #######  ##    ##    ##    #### ##     ## ########    ##    ##     ## ##     ##  ######  ##    ## ######## ##     ##  ######
   */

  /**
   * syncRuntimeTrackers
   */
  async syncRuntimeTrackers(): Promise<void> {
    if (this.runtimeSyncTrackerSyncing === true) {
      return
    }

    try {
      this.runtimeSyncTrackerSyncing = true

      let startedCount = 0
      do {
        // async collection safety:
        //   we work on a copy of the list
        //   we start the loop over again if any work was done.  this allows us to pick up changes that got added in later
        startedCount = 0
        const arrayCopy = this.syncTrackers.slice(0)
        for (const syncTracker of arrayCopy) {
          if (syncTracker.syncStarted === false) {
            /* prettier-ignore */ if (logFlags.console) console.log(`rtsyncTracker start. time:${Date.now()} data: ${utils.stringifyReduceLimit(syncTracker)}}`)
            /* prettier-ignore */ if (logFlags.playback) this.logger.playbackLogNote('rt_shrd_sync_trackerRangeStart', ` `, ` ${utils.stringifyReduce(syncTracker.range)} `)

            syncTracker.syncStarted = true
            startedCount++
            await syncTracker.syncStateDataForRange2() //syncTracker.range)
            syncTracker.syncFinished = true

            /* prettier-ignore */ if (logFlags.playback) this.logger.playbackLogNote('rt_shrd_sync_trackerRangeEnd', ` `, ` ${utils.stringifyReduce(syncTracker.range)} `)
            if (this.config.stateManager.fifoUnlockFix2 === false) {
              //this may be a source of runtime problems based on axing fifo locks is that even needed?
              this.clearSyncData()
            }
          }
        }
      } while (startedCount > 0)
    } catch (ex) {
      /* prettier-ignore */ if (logFlags.debug) this.mainLogger.debug('syncRuntimeTrackers: ' + ex.name + ': ' + ex.message + ' at ' + ex.stack)
      this.statemanager_fatal(
        `syncRuntimeTrackers_ex`,
        'syncRuntimeTrackers: ' + ex.name + ': ' + ex.message + ' at ' + ex.stack
      )

      //clear out sync trackers and let repair handle it if needed.
      const cleared = this.syncTrackers.length
      const kept = 0
      const newTrackers = 0

      const cycle = this.stateManager.currentCycleShardData.cycleNumber
      const lastCycle = cycle - 1

      /* prettier-ignore */ nestedCountersInstance.countRareEvent('sync', `RETRYSYNC: runtime. lastCycle: ${lastCycle} cycle: ${cycle} ${JSON.stringify({ cleared, kept, newTrackers })}`)

      // clear all sync trackers.
      this.clearSyncTrackers()
      // may need to think more about this.. what if multiple nodes fail sync and then cast bad votes in subsequent updates?
    } finally {
      this.runtimeSyncTrackerSyncing = false
    }
  }

  /***
   *     ######  ##    ## ##    ##  ######  ######## ########     ###     ######  ##    ## ######## ########     ##     ## ######## ##       ########  ######## ########   ######
   *    ##    ##  ##  ##  ###   ## ##    ##    ##    ##     ##   ## ##   ##    ## ##   ##  ##       ##     ##    ##     ## ##       ##       ##     ## ##       ##     ## ##    ##
   *    ##         ####   ####  ## ##          ##    ##     ##  ##   ##  ##       ##  ##   ##       ##     ##    ##     ## ##       ##       ##     ## ##       ##     ## ##
   *     ######     ##    ## ## ## ##          ##    ########  ##     ## ##       #####    ######   ########     ######### ######   ##       ########  ######   ########   ######
   *          ##    ##    ##  #### ##          ##    ##   ##   ######### ##       ##  ##   ##       ##   ##      ##     ## ##       ##       ##        ##       ##   ##         ##
   *    ##    ##    ##    ##   ### ##    ##    ##    ##    ##  ##     ## ##    ## ##   ##  ##       ##    ##     ##     ## ##       ##       ##        ##       ##    ##  ##    ##
   *     ######     ##    ##    ##  ######     ##    ##     ## ##     ##  ######  ##    ## ######## ##     ##    ##     ## ######## ######## ##        ######## ##     ##  ######
   */

  /**
   * createSyncTrackerByRange
   * @param {StateManagerTypes.shardFunctionTypes.BasicAddressRange} range
   * @param {number} cycle
   * @return {SyncTracker}
   */
  createSyncTrackerByRange(
    range: StateManagerTypes.shardFunctionTypes.BasicAddressRange,
    cycle: number,
    initalSync = false
  ): SyncTracker {
    const index = this.syncTrackerIndex++

    const syncTracker = new SyncTracker()
    syncTracker.initByRange(this, this.p2p, index, range, cycle, initalSync)

    this.syncTrackers.push(syncTracker) // we should maintain this order.

    if (initalSync) {
      this.initalSyncRemaining++
    }

    return syncTracker
  }

  createSyncTrackerByForGlobals(cycle: number, initalSync = false): SyncTracker {
    const index = this.syncTrackerIndex++

    const syncTracker = new SyncTracker()
    syncTracker.initGlobal(this, this.p2p, index, cycle, initalSync)

    this.syncTrackers.push(syncTracker) // we should maintain this order.

    if (initalSync) {
      this.initalSyncRemaining++
    }

    return syncTracker
  }

  /**
   * not used, consider removal
   * @param address
   * @returns
   */
  getSyncTracker(address: string): SyncTracker | null {
    // return the sync tracker.
    for (let i = 0; i < this.syncTrackers.length; i++) {
      // eslint-disable-next-line security/detect-object-injection
      const syncTracker = this.syncTrackers[i]

      // test global first, because it wont have a range
      // eslint-disable-next-line security/detect-object-injection
      if (syncTracker.isGlobalSyncTracker === true && syncTracker.globalAddressMap[address] === true) {
        return syncTracker
      }

      // need to see if address is in range. if so return the tracker.
      if (syncTracker.range.low <= address && address <= syncTracker.range.high) {
        return syncTracker
      }
    }
    return null
  }

  // Check the entire range for a partition to see if any of it is covered by a sync tracker.
  getSyncTrackerForParition(partitionID: number, cycleShardData: CycleShardData): SyncTracker | null {
    if (cycleShardData == null) {
      return null
    }
    const partitionShardData: StateManagerTypes.shardFunctionTypes.ShardInfo =
      cycleShardData.parititionShardDataMap.get(partitionID)

    const addressLow = partitionShardData.homeRange.low
    const addressHigh = partitionShardData.homeRange.high
    // return the sync tracker.
    for (let i = 0; i < this.syncTrackers.length; i++) {
      // eslint-disable-next-line security/detect-object-injection
      const syncTracker = this.syncTrackers[i]

      // need to see if address is in range. if so return the tracker.
      if (syncTracker.range.low <= addressLow && addressHigh <= syncTracker.range.high) {
        return syncTracker
      }
    }
    return null
  }

  /***
   *    ##     ## ####  ######   ######
   *    ###   ###  ##  ##    ## ##    ##
   *    #### ####  ##  ##       ##
   *    ## ### ##  ##   ######  ##
   *    ##     ##  ##        ## ##
   *    ##     ##  ##  ##    ## ##    ##
   *    ##     ## ####  ######   ######
   */

  /**
   * syncStatmentIsComplete
   *
   */
  syncStatmentIsComplete() {
    this.syncStatement.totalSyncTime = (Date.now() - Self.p2pSyncStart) / 1000

    this.readyforTXs = true
    this.clearSyncTrackers()

    // place to hook in and read or send the sync statement
    this.isSyncStatementCompleted = true
    Context.reporter.reportSyncStatement(Self.id, this.syncStatement)
  }

  /**
   * Skips app data sync and sets flags to enable external tx processing.
   * Called by snapshot module after data recovery is complete.
   */
  skipSync() {
    this.dataSyncMainPhaseComplete = true
    this.syncStatement.syncComplete = true

    this.readyforTXs = true
    if (logFlags.debug) this.mainLogger.debug(`DATASYNC: isFirstSeed = true. skipping sync`)

    return
  }

  setGlobalSyncFinished() {
    this.globalAccountsSynced = true
  }
}

export default AccountSync
