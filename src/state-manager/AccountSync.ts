import * as Shardus from '../shardus/shardus-types'
import { StateManager as StateManagerTypes } from 'shardus-types'
import * as utils from '../utils'
const stringify = require('fast-stable-stringify')

import Profiler, { profilerInstance } from '../utils/profiler'
import { P2PModuleContext as P2P } from '../p2p/Context'
import Storage from '../storage'
import Crypto from '../crypto'
import Logger, { logFlags } from '../logger'
import ShardFunctions from './shardFunctions.js'
import { time } from 'console'
import StateManager from '.'
import { isNullOrUndefined } from 'util'
import { robustQuery } from '../p2p/Utils'
import { nestedCountersInstance } from '../utils/nestedCounters'
import * as Context from '../p2p/Context'
import * as Wrapper from '../p2p/Wrapper'
import * as Self from '../p2p/Self'
import { potentiallyRemoved } from '../p2p/NodeList'
import { SyncTracker, SimpleRange, AccountStateHashReq, AccountStateHashResp, GetAccountStateReq, GetAccountData3Req, GetAccountDataByRangeSmart, GlobalAccountReportResp, GetAccountData3Resp, CycleShardData } from './state-manager-types'
import { safetyModeVals } from '../snapshot'
import { isDebugModeMiddleware } from '../network/debugMiddleware'
import { errorToStringFull } from '../utils'

const allZeroes64 = '0'.repeat(64)

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
  config: Shardus.ShardusConfiguration
  profiler: Profiler

  logger: Logger
  p2p: P2P
  storage: Storage

  mainLogger: any
  fatalLogger: any
  shardLogger: any
  statsLogger: any

  dataSyncMainPhaseComplete: boolean
  globalAccountsSynced: boolean
  isSyncingAcceptedTxs: boolean
  requiredNodeCount: number

  runtimeSyncTrackerSyncing: boolean

  syncTrackerIndex: number
  initalSyncRemaining: number

  readyforTXs: boolean

  syncTrackers: SyncTracker[]

  currentRange: SimpleRange
  addressRange: SimpleRange

  dataSourceNode: Shardus.Node
  dataSourceNodeList: Shardus.Node[]
  dataSourceNodeIndex: number

  inMemoryStateTableData: Shardus.StateTableObject[]
  combinedAccountData: Shardus.WrappedData[]
  accountsWithStateConflict: Shardus.WrappedData[] //{address:string}[] //Shardus.WrappedData[];

  stateTableForMissingTXs: { [accountID: string]: Shardus.StateTableObject }

  lastStateSyncEndtime: number

  failedAccounts: string[]
  missingAccountData: string[]

  mapAccountData: { [accountID: string]: Shardus.WrappedData }

  acceptedTXByHash: { [accountID: string]: string } //not sure if this is correct.  TODO where did this impl go!

  statemanager_fatal: (key: string, log: string) => void

  partitionStartTimeStamp: number

  combinedAccountStateData: Shardus.StateTableObject[]

  syncStatement: SyncStatment
  isSyncStatementCompleted: boolean

  softSync_earlyOut: boolean // exit inital sync early after globals are synced
  softSync_noSyncDelay: boolean // don't delay or TXs let them try to execute
  softSync_checkInitialFlag: boolean // check initalSyncFinished before we give hash reports on sync table data

  initalSyncFinished: boolean // track when we have completed our inital data sync.

  forceSyncComplete: boolean

  useStateTable: boolean
  forwardTXToSyncingNeighbors: boolean

  constructor(
    stateManager: StateManager,

    profiler: Profiler,
    app: Shardus.App,
    logger: Logger,
    storage: Storage,
    p2p: P2P,
    crypto: Crypto,
    config: Shardus.ShardusConfiguration
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

    this.acceptedTXByHash = {}

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

    this.useStateTable = false
    this.forwardTXToSyncingNeighbors = false

    console.log('this.p2p', this.p2p)
  }
  // ////////////////////////////////////////////////////////////////////
  //   DATASYNC
  // ////////////////////////////////////////////////////////////////////

  // this clears state data related to the current partion we are syncinge
  clearSyncData() {
    // These are all for the given partition
    this.addressRange = null
    this.dataSourceNode = null
    this.dataSourceNodeList = []
    this.dataSourceNodeIndex = 0

    this.inMemoryStateTableData = [] as Shardus.StateTableObject[]

    this.combinedAccountData = []
    this.lastStateSyncEndtime = 0

    this.accountsWithStateConflict = []
    this.failedAccounts = [] // todo m11: determine how/when we will pull something out of this list!
    this.mapAccountData = {}

    this.stateManager.fifoLocks = {}

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
    this.p2p.registerInternal('get_account_state_hash', async (payload: AccountStateHashReq, respond: (arg0: AccountStateHashResp) => any) => {
      profilerInstance.scopedProfileSectionStart('get_account_state_hash')
      try {
        let result = {} as AccountStateHashResp

        if(this.softSync_checkInitialFlag && this.initalSyncFinished === false){
          //not ready?
          result.ready = false
          result.stateHash = this.stateManager.currentCycleShardData.ourNode.id
          await respond(result)
          return
        }

        // yikes need to potentially hash only N records at a time and return an array of hashes
        let stateHash = await this.stateManager.transactionQueue.getAccountsStateHash(payload.accountStart, payload.accountEnd, payload.tsStart, payload.tsEnd)
        result.stateHash = stateHash
        result.ready = true
        await respond(result)
      } catch (e) {
        this.statemanager_fatal('get_account_state_hash', e)
      } finally {
        profilerInstance.scopedProfileSectionEnd('get_account_state_hash')
      }
    })

    //    /get_account_state (Acc_start, Acc_end, Ts_start, Ts_end)
    // Acc_start - get data for accounts starting with this account id; inclusive
    // Acc_end - get data for accounts up to this account id; inclusive
    // Ts_start - get data newer than this timestamp
    // Ts_end - get data older than this timestamp
    // Returns data from the Account State Table determined by the input parameters; limits result to 1000 records (as configured)
    // Updated names:  accountStart , accountEnd, tsStart, tsEnd
    this.p2p.registerInternal('get_account_state', async (payload: GetAccountStateReq, respond: (arg0: { accountStates: Shardus.StateTableObject[] }) => any) => {
      if (this.config.stateManager == null) {
        throw new Error('this.config.stateManager == null') //TODO TSConversion  would be nice to eliminate some of these config checks.
      }
      profilerInstance.scopedProfileSectionStart('get_account_state')
      let result = {} as { accountStates: Shardus.StateTableObject[] }

      // max records set artificially low for better test coverage
      // todo m11: make configs for how many records to query
      let accountStates = await this.storage.queryAccountStateTable(payload.accountStart, payload.accountEnd, payload.tsStart, payload.tsEnd, this.config.stateManager.stateTableBucketSize)
      result.accountStates = accountStates
      await respond(result)
      profilerInstance.scopedProfileSectionEnd('get_account_state')
    })

    this.p2p.registerInternal('get_account_data3', async (payload: GetAccountData3Req, respond: (arg0: { data: GetAccountDataByRangeSmart }) => any) => {
      profilerInstance.scopedProfileSectionStart('get_account_data3')
      let result = {} as { data: GetAccountDataByRangeSmart } //TSConversion  This is complicated !!(due to app wrapping)  as {data: Shardus.AccountData[] | null}
      let accountData: GetAccountDataByRangeSmart | null = null
      let ourLockID = -1
      try {
        ourLockID = await this.stateManager.fifoLock('accountModification')
        // returns { wrappedAccounts, lastUpdateNeeded, wrappedAccounts2, highestTs }
        //GetAccountDataByRangeSmart
        accountData = await this.stateManager.getAccountDataByRangeSmart(payload.accountStart, payload.accountEnd, payload.tsStart, payload.maxRecords)
      } finally {
        this.stateManager.fifoUnlock('accountModification', ourLockID)
      }

      //PERF Disiable this in production or performance testing.
      this.stateManager.testAccountDataWrapped(accountData.wrappedAccounts)
      //PERF Disiable this in production or performance testing.
      this.stateManager.testAccountDataWrapped(accountData.wrappedAccounts2)

      result.data = accountData
      await respond(result)
      profilerInstance.scopedProfileSectionEnd('get_account_data3')
    })

    // /get_account_data_by_list (Acc_ids)
    // Acc_ids - array of accounts to get
    // Returns data from the application Account Table for just the given account ids;
    // For applications with multiple “Account” tables the returned data is grouped by table name.
    // For example: [ {Acc_id, State_after, Acc_data}, { … }, ….. ]
    // Updated names:  accountIds, max records
    this.p2p.registerInternal('get_account_data_by_list', async (payload: { accountIds: any }, respond: (arg0: { accountData: Shardus.WrappedData[] | null }) => any) => {
      profilerInstance.scopedProfileSectionStart('get_account_data_by_list')
      let result = {} as { accountData: Shardus.WrappedData[] | null }
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
      await respond(result)
      profilerInstance.scopedProfileSectionEnd('get_account_data_by_list')
    })

    Context.network.registerExternalGet('sync-statement', isDebugModeMiddleware, (req, res) => {
      res.write(`${utils.stringifyReduce(this.syncStatement)}\n`)

      res.end()
    })

    //TODO DEBUG DO NOT USE IN LIVE NETWORK
    Context.network.registerExternalGet('sync-statement-all', isDebugModeMiddleware, async (req, res) => {
      try {
        //wow, why does Context.p2p not work..
        let activeNodes = Wrapper.p2p.state.getNodes()
        if (activeNodes) {
          for (let node of activeNodes.values()) {
            let getResp = await this.logger._internalHackGetWithResp(`${node.externalIp}:${node.externalPort}/sync-statement`)
            console.log('getResp active', getResp.body)
            res.write(`${node.externalIp}:${node.externalPort}/sync-statement\n`)
            res.write(getResp.body ? getResp.body : 'no data')
          }
        }
        res.write(`joining nodes...\n`)
        let joiningNodes = Wrapper.p2p.state.getNodesRequestingJoin()
        if (joiningNodes) {
          for (let node of joiningNodes.values()) {
            let getResp = await this.logger._internalHackGetWithResp(`${node.externalIp}:${node.externalPort}/sync-statement`)
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

    Context.network.registerExternalGet('forceFinishSync', isDebugModeMiddleware, (req, res) => {
      res.write(`sync forcing complete. \n`)
      this.forceSyncComplete = true
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

      this.syncStatement.timeBeforeDataSync = (Date.now() - Self.p2pSyncEnd)/1000
      this.syncStatement.timeBeforeDataSync2 = this.syncStatement.timeBeforeDataSync

      nestedCountersInstance.countEvent('sync', `sync comlete numCycles: ${this.syncStatement.numCycles} start:${this.syncStatement.cycleStarted} end:${this.syncStatement.cycleEnded}`)

      if (logFlags.playback) this.logger.playbackLogNote('shrd_sync_syncStatement', ` `, `${utils.stringifyReduce(this.syncStatement)}`)

      this.syncStatmentIsComplete()
      this.statemanager_fatal('shrd_sync_syncStatement-tempdebug', `${utils.stringifyReduce(this.syncStatement)}`)
      return
    }

    this.isSyncingAcceptedTxs = true

    this.syncStatement.timeBeforeDataSync = (Date.now() - Self.p2pSyncEnd)/1000


    await utils.sleep(5000) // Temporary delay to make it easier to attach a debugger
    if (logFlags.console) console.log('syncStateData start')
    // delete and re-create some tables before we sync:
    await this.storage.clearAppRelatedState()
    await this.app.deleteLocalAccountData()

    if (logFlags.debug) this.mainLogger.debug(`DATASYNC: starting syncStateData`)

    this.requiredNodeCount = requiredNodeCount

    let hasValidShardData = this.stateManager.currentCycleShardData != null
    if (this.stateManager.currentCycleShardData != null) {
      hasValidShardData = this.stateManager.currentCycleShardData.hasCompleteData
    }
    while (hasValidShardData === false) {
      this.stateManager.getCurrentCycleShardData()
      await utils.sleep(1000)
      if (this.stateManager.currentCycleShardData == null) {
        if (logFlags.playback) this.logger.playbackLogNote('shrd_sync_waitForShardData', ` `, ` ${utils.stringifyReduce(this.stateManager.currentCycleShardData)} `)
        hasValidShardData = false
      }
      if (this.stateManager.currentCycleShardData != null) {
        if (this.stateManager.currentCycleShardData.hasCompleteData == false) {
          let temp = this.p2p.state.getActiveNodes(null)
          if (logFlags.playback)
            this.logger.playbackLogNote(
              'shrd_sync_waitForShardData',
              ` `,
              `hasCompleteData:${this.stateManager.currentCycleShardData.hasCompleteData} active:${utils.stringifyReduce(temp)} ${utils.stringifyReduce(this.stateManager.currentCycleShardData)} `
            )
        } else {
          hasValidShardData = true
        }
      }
    }

    this.syncStatement.cycleStarted = this.stateManager.currentCycleShardData.cycleNumber
    this.syncStatement.syncStartTime = Date.now()
    this.syncStatement.numNodesOnStart = this.stateManager.currentCycleShardData.activeNodes.length
    this.syncStatement.p2pJoinTime = Self.p2pJoinTime


    // //DO NOT CHECK IN
    // if(this.syncStatement.numNodesOnStart >= 15) {
    //   nestedCountersInstance.countEvent('hack', 'force default logs on')
    //   this.logger.setDefaultFlags()
    // }

    let nodeShardData = this.stateManager.currentCycleShardData.nodeShardData
    if (logFlags.console) console.log('GOT current cycle ' + '   time:' + utils.stringifyReduce(nodeShardData))

    let rangesToSync: StateManagerTypes.shardFunctionTypes.AddressRange[]

    let cycle = this.stateManager.currentCycleShardData.cycleNumber

    let homePartition = nodeShardData.homePartition

    if (logFlags.console) console.log(`homePartition: ${homePartition} storedPartitions: ${utils.stringifyReduce(nodeShardData.storedPartitions)}`)

    // syncRangeGoal helps us calculate how many partitions per range we need to get our data in chunksGuide number of chunks.
    // chunksGuide === 4, would mean that in a network with many nodes most of the time we would have 4 ranges to sync.
    // there could be less ranges if the network is smaller.
    // TODO review that this is up to spec.
    rangesToSync = this.initRangesToSync(nodeShardData, homePartition)
    this.syncStatement.syncRanges = rangesToSync.length

    for (let range of rangesToSync) {
      // let nodes = ShardFunctions.getNodesThatCoverRange(this.stateManager.currentCycleShardData.shardGlobals, range.low, range.high, this.stateManager.currentCycleShardData.ourNode, this.stateManager.currentCycleShardData.activeNodes)
      this.createSyncTrackerByRange(range, cycle, true)
    }

    this.createSyncTrackerByForGlobals(cycle, true)



    this.syncStatement.timeBeforeDataSync2 = (Date.now() - Self.p2pSyncEnd)/1000

    // must get a list of globals before we can listen to any TXs, otherwise the isGlobal function returns bad values
    await this.stateManager.accountGlobals.getGlobalListEarly()
    this.readyforTXs = true

    if(this.useStateTable === true){
      await utils.sleep(8000) // sleep to make sure we are listening to some txs before we sync them
    }

    //This has an inner loop that will process sync trackers one at a time.
    //The outer while loop can be used to recalculate the list of sync trackers and try again
    let breakCount = 0
    let running = true
    while(running){

      try{
        for (let syncTracker of this.syncTrackers) {
          if(this.dataSyncMainPhaseComplete === true){
            // this get set if we force sync to finish
            running = false
            break
          }
          // let partition = syncTracker.partition
          if (logFlags.console) console.log(`syncTracker start. time:${Date.now()} data: ${utils.stringifyReduce(syncTracker)}}`)
          if (logFlags.playback) this.logger.playbackLogNote('shrd_sync_trackerRangeStart', ` `, ` ${utils.stringifyReduce(syncTracker.range)} `)

          syncTracker.syncStarted = true

          if (syncTracker.isGlobalSyncTracker === false) {
            if (this.softSync_earlyOut === true) {
              // do nothing realtime sync will work on this later
            } else {
              await this.syncStateDataForRange(syncTracker.range)
            }
          } else {
            if (logFlags.console) console.log(`syncTracker syncStateDataGlobals start. time:${Date.now()} data: ${utils.stringifyReduce(syncTracker)}}`)
            await this.syncStateDataGlobals(syncTracker)
          }
          syncTracker.syncFinished = true

          if (logFlags.playback) this.logger.playbackLogNote('shrd_sync_trackerRangeEnd', ` `, ` ${utils.stringifyReduce(syncTracker.range)} `)
          this.clearSyncData()
        }
        //if we get here without an exception that we are finished with the outer loop
        running = false

      } catch (error){

        if(error.message.includes('reset-sync-ranges')){

          this.statemanager_fatal(`mainSyncLoop_reset-sync-ranges`, 'DATASYNC: reset-sync-ranges: ' + errorToStringFull(error))

          if(breakCount > 5){
            this.statemanager_fatal(`mainSyncLoop_reset-sync-ranges-givingUP`,'too many tries' )
            running = false
            continue
          }

          breakCount++
          this.clearSyncData()

          let cleared = 0
          let kept = 0
          let newTrackers = 0
          let trackersToKeep = []
          for (let syncTracker of this.syncTrackers){
            //keep unfinished global sync trackers
            if (syncTracker.isGlobalSyncTracker === true && syncTracker.syncFinished === false){
              trackersToKeep.push(syncTracker)
              kept++
            } else {
              cleared++
            }
          }
          this.syncTrackers = trackersToKeep

          //get fresh nodeShardData, homePartition and cycle so that we can re init the sync ranges.
          nodeShardData = this.stateManager.currentCycleShardData.nodeShardData
          console.log('RETRYSYNC: GOT current cycle ' + '   time:' + utils.stringifyReduce(nodeShardData))
          let lastCycle = cycle
          cycle = this.stateManager.currentCycleShardData.cycleNumber
          homePartition = nodeShardData.homePartition
          console.log(`RETRYSYNC: homePartition: ${homePartition} storedPartitions: ${utils.stringifyReduce(nodeShardData.storedPartitions)}`)


          //init new non global trackers
          rangesToSync = this.initRangesToSync(nodeShardData, homePartition)
          this.syncStatement.syncRanges = rangesToSync.length
          for (let range of rangesToSync) {
            this.createSyncTrackerByRange(range, cycle, true)
            newTrackers++
          }
          nestedCountersInstance.countRareEvent('sync', `RETRYSYNC: lastCycle: ${lastCycle} cycle: ${cycle} ${JSON.stringify({cleared, kept, newTrackers})}`)

          continue //resume loop at top!

        } else {
          running = false
        }
      }
    }
    // if (logFlags.playback ) this.logger.playbackLogNote('shrd_sync_queued_and_set_syncing', `${txQueueEntry.acceptedTx.id}`, ` qId: ${txQueueEntry.entryID}`)
    if (logFlags.console) console.log('syncStateData end' + '   time:' + Date.now())
  }

  private initRangesToSync(nodeShardData: StateManagerTypes.shardFunctionTypes.NodeShardData, homePartition: number):StateManagerTypes.shardFunctionTypes.AddressRange[] {
    let chunksGuide = 4
    let syncRangeGoal = Math.max(1, Math.min(chunksGuide, Math.floor(this.stateManager.currentCycleShardData.shardGlobals.numPartitions / chunksGuide)))
    let partitionsCovered = 0
    let partitionsPerRange = 1
    let rangesToSync = [] //, rangesToSync: StateManagerTypes.shardFunctionTypes.AddressRange[]

    if (nodeShardData.storedPartitions.rangeIsSplit === true) {
      partitionsCovered = nodeShardData.storedPartitions.partitionEnd1 - nodeShardData.storedPartitions.partitionStart1
      partitionsCovered += nodeShardData.storedPartitions.partitionEnd2 - nodeShardData.storedPartitions.partitionStart2
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
        let range = ShardFunctions.partitionToAddressRange2(this.stateManager.currentCycleShardData.shardGlobals, currentStart, currentEnd)

        let { address1, address2 } = ShardFunctions.getNextAdjacentAddresses(range.high)
        range.high = address1

        if (nextLowAddress != null) {
          range.low = nextLowAddress
        }
        if (logFlags.console)
          console.log(`range ${i}  s:${currentStart} e:${currentEnd} h: ${homePartition}  a1: ${range.low} a2: ${range.high}`)
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
        let range = ShardFunctions.partitionToAddressRange2(this.stateManager.currentCycleShardData.shardGlobals, currentStart, currentEnd)

        let { address1, address2 } = ShardFunctions.getNextAdjacentAddresses(range.high)
        range.high = address1

        if (nextLowAddress != null) {
          range.low = nextLowAddress
        }
        if (logFlags.console)
          console.log(`range ${i}  s:${currentStart} e:${currentEnd} h: ${homePartition} a1: ${range.low} a2: ${range.high}`)

        nextLowAddress = address2
        currentStart = currentEnd
        i++
        rangesToSync.push(range)
      }
    } else {
      partitionsCovered = nodeShardData.storedPartitions.partitionEnd - nodeShardData.storedPartitions.partitionStart
      partitionsPerRange = Math.max(Math.floor(partitionsCovered / syncRangeGoal), 1)
      if (logFlags.console)
        console.log(
          `syncRangeGoal ${syncRangeGoal}  chunksGuide:${chunksGuide} numPartitions:${this.stateManager.currentCycleShardData.shardGlobals.numPartitions} partitionsPerRange:${partitionsPerRange}`
        )

      let start = nodeShardData.storedPartitions.partitionStart
      let end = nodeShardData.storedPartitions.partitionEnd

      let currentStart = start
      let currentEnd = 0
      let nextLowAddress: string | null = null
      let i = 0
      while (currentEnd < end) {
        currentEnd = Math.min(currentStart + partitionsPerRange, end)
        let range = ShardFunctions.partitionToAddressRange2(this.stateManager.currentCycleShardData.shardGlobals, currentStart, currentEnd)

        let { address1, address2 } = ShardFunctions.getNextAdjacentAddresses(range.high)
        range.high = address1

        if (nextLowAddress != null) {
          range.low = nextLowAddress
        }
        if (logFlags.console)
          console.log(`range ${i}  s:${currentStart} e:${currentEnd} h: ${homePartition}  a1: ${range.low} a2: ${range.high}`)
        nextLowAddress = address2
        currentStart = currentEnd
        i++
        rangesToSync.push(range)
      }
    }

    // if we don't have a range to sync yet manually sync the whole range.
    if (rangesToSync.length === 0) {
      if (logFlags.console)
        console.log(`syncStateData ranges: pushing full range, no ranges found`)
      let range = ShardFunctions.partitionToAddressRange2(this.stateManager.currentCycleShardData.shardGlobals, 0, this.stateManager.currentCycleShardData.shardGlobals.numPartitions - 1)
      rangesToSync.push(range)
    }
    if (logFlags.console)
      console.log(`syncStateData ranges: ${utils.stringifyReduce(rangesToSync)}}`)

    return rangesToSync
  }

  /***
   *     ######  ##    ## ##    ##  ######   ######  ########    ###    ######## ######## ########     ###    ########    ###    ########  #######  ########  ########     ###    ##    ##  ######   ########
   *    ##    ##  ##  ##  ###   ## ##    ## ##    ##    ##      ## ##      ##    ##       ##     ##   ## ##      ##      ## ##   ##       ##     ## ##     ## ##     ##   ## ##   ###   ## ##    ##  ##
   *    ##         ####   ####  ## ##       ##          ##     ##   ##     ##    ##       ##     ##  ##   ##     ##     ##   ##  ##       ##     ## ##     ## ##     ##  ##   ##  ####  ## ##        ##
   *     ######     ##    ## ## ## ##        ######     ##    ##     ##    ##    ######   ##     ## ##     ##    ##    ##     ## ######   ##     ## ########  ########  ##     ## ## ## ## ##   #### ######
   *          ##    ##    ##  #### ##             ##    ##    #########    ##    ##       ##     ## #########    ##    ######### ##       ##     ## ##   ##   ##   ##   ######### ##  #### ##    ##  ##
   *    ##    ##    ##    ##   ### ##    ## ##    ##    ##    ##     ##    ##    ##       ##     ## ##     ##    ##    ##     ## ##       ##     ## ##    ##  ##    ##  ##     ## ##   ### ##    ##  ##
   *     ######     ##    ##    ##  ######   ######     ##    ##     ##    ##    ######## ########  ##     ##    ##    ##     ## ##        #######  ##     ## ##     ## ##     ## ##    ##  ######   ########
   */

  /**
   * syncStateDataForRange
   * syncs accountData with the help of stateTable data for a given address range
   * @param {SimpleRange} range
   */
  async syncStateDataForRange(range: SimpleRange) {
    try {
      let partition = 'notUsed'
      this.currentRange = range
      this.addressRange = range // this.partitionToAddressRange(partition)

      this.partitionStartTimeStamp = Date.now()

      let lowAddress = this.addressRange.low
      let highAddress = this.addressRange.high

      partition = `${utils.stringifyReduce(lowAddress)} - ${utils.stringifyReduce(highAddress)}`

      if (logFlags.debug) this.mainLogger.debug(`DATASYNC: syncStateDataForPartition partition: ${partition} `)

      if(this.useStateTable === true){
        await this.syncStateTableData(lowAddress, highAddress, 0, Date.now() - this.stateManager.syncSettleTime)
      }
      if (logFlags.debug) this.mainLogger.debug(`DATASYNC: partition: ${partition}, syncStateTableData 1st pass done.`)

      nestedCountersInstance.countEvent('sync', `sync partition: ${partition} start: ${this.stateManager.currentCycleShardData.cycleNumber}`)

      this.readyforTXs = true // open the floodgates of queuing stuffs.

      await this.syncAccountData(lowAddress, highAddress)
      if (logFlags.debug) this.mainLogger.debug(`DATASYNC: partition: ${partition}, syncAccountData done.`)

      // potentially do the next 2 blocks periodically in the account data retreval so we can flush data to disk!  generalize the account state table update so it can be called 'n' times

      // Sync the Account State Table Second Pass
      //   Wait at least 10T since the Ts_end time of the First Pass
      //   Same as the procedure for First Pass except:
      //   Ts_start should be the Ts_end value from last time and Ts_end value should be current time minus 10T
      if(this.useStateTable === true){
        await this.syncStateTableData(lowAddress, highAddress, this.lastStateSyncEndtime, Date.now())
      }
      if (logFlags.debug) this.mainLogger.debug(`DATASYNC: partition: ${partition}, syncStateTableData 2nd pass done.`)

      // Process the Account data
      //   For each account in the Account data make sure the entry in the Account State Table has the same State_after value; if not remove the record from the Account data
      //   For each account in the Account State Table make sure the entry in Account data has the same State_after value; if not save the account id to be looked up later
      //   Use the App.set_account_data function with the Account data to save the data to the application Accounts Table; if any failed accounts are returned save the account id to be looked up later
      let accountsSaved = await this.processAccountData()
      if (logFlags.debug) this.mainLogger.debug(`DATASYNC: partition: ${partition}, processAccountData done.`)

      // Sync the failed accounts
      //   Log that some account failed
      //   Use the /get_account_data_by_list API to get the data for the accounts that need to be looked up later from any of the nodes that had a matching hash but different from previously used nodes
      //   Repeat the “Sync the Account State Table Second Pass” step
      //   Repeat the “Process the Account data” step
      await this.syncFailedAcccounts(lowAddress, highAddress)

      if (this.failedAccountsRemain()) {
        if (logFlags.debug)
          this.mainLogger.debug(
            `DATASYNC: failedAccountsRemain,  ${utils.stringifyReduce(lowAddress)} - ${utils.stringifyReduce(highAddress)} accountsWithStateConflict:${
              this.accountsWithStateConflict.length
            } missingAccountData:${this.missingAccountData.length} stateTableForMissingTXs:${Object.keys(this.stateTableForMissingTXs).length}`
          )

        //This section allows to retry for failed accounts but it greatly slows down the sync process, so I think that is not the right answer

        // this.mainLogger.debug(`DATASYNC: failedAccountsRemain, wait ${this.stateManager.syncSettleTime}ms and retry ${lowAddress} - ${highAddress}`)
        // await utils.sleep(this.stateManager.syncSettleTime)

        // await this.syncFailedAcccounts(lowAddress, highAddress)

        // if(this.failedAccountsRemain()){
        //   this.statemanager_fatal(`failedAccountsRemain2`, `failedAccountsRemain2: this.accountsWithStateConflict:${utils.stringifyReduce(this.accountsWithStateConflict)} this.missingAccountData:${utils.stringifyReduce(this.missingAccountData)} `)
        // } else {
        //   this.mainLogger.debug(`DATASYNC: syncFailedAcccounts FIX WORKED`)
        // }
      }

      let keysToRepair = Object.keys(this.stateTableForMissingTXs).length
      if (keysToRepair > 0) {
        // alternate repair.
        this.repairMissingTXs()
      }

      nestedCountersInstance.countEvent('sync', `sync partition: ${partition} end: ${this.stateManager.currentCycleShardData.cycleNumber} accountsSynced:${accountsSaved} missing tx to repair: ${keysToRepair}`)

    } catch (error) {
      if(error.message.includes('reset-sync-ranges')){

        this.statemanager_fatal(`syncStateDataForRange_reset-sync-ranges`, 'DATASYNC: reset-sync-ranges: ' + errorToStringFull(error))
        //buble up:
        throw new Error('reset-sync-ranges')
      } else if (error.message.includes('FailAndRestartPartition')) {
        if (logFlags.debug) this.mainLogger.debug(`DATASYNC: Error Failed at: ${error.stack}`)
        this.statemanager_fatal(`syncStateDataForRange_ex_failandrestart`, 'DATASYNC: FailAndRestartPartition: ' + errorToStringFull(error))
        await this.failandRestart()
      } else {
        this.statemanager_fatal(`syncStateDataForRange_ex`, 'syncStateDataForPartition failed: ' + errorToStringFull(error))
        if (logFlags.debug) this.mainLogger.debug(`DATASYNC: unexpected error. restaring sync:` + errorToStringFull(error))
        await this.failandRestart()
      }
    }
  }

  /***
   *     ######  ##    ## ##    ##  ######   ######  ########    ###    ######## ######## ########     ###    ########    ###     ######   ##        #######  ########     ###    ##        ######
   *    ##    ##  ##  ##  ###   ## ##    ## ##    ##    ##      ## ##      ##    ##       ##     ##   ## ##      ##      ## ##   ##    ##  ##       ##     ## ##     ##   ## ##   ##       ##    ##
   *    ##         ####   ####  ## ##       ##          ##     ##   ##     ##    ##       ##     ##  ##   ##     ##     ##   ##  ##        ##       ##     ## ##     ##  ##   ##  ##       ##
   *     ######     ##    ## ## ## ##        ######     ##    ##     ##    ##    ######   ##     ## ##     ##    ##    ##     ## ##   #### ##       ##     ## ########  ##     ## ##        ######
   *          ##    ##    ##  #### ##             ##    ##    #########    ##    ##       ##     ## #########    ##    ######### ##    ##  ##       ##     ## ##     ## ######### ##             ##
   *    ##    ##    ##    ##   ### ##    ## ##    ##    ##    ##     ##    ##    ##       ##     ## ##     ##    ##    ##     ## ##    ##  ##       ##     ## ##     ## ##     ## ##       ##    ##
   *     ######     ##    ##    ##  ######   ######     ##    ##     ##    ##    ######## ########  ##     ##    ##    ##     ##  ######   ########  #######  ########  ##     ## ########  ######
   */

  /**
   * syncStateDataGlobals
   * @param syncTracker
   */
  async syncStateDataGlobals(syncTracker: SyncTracker) {
    try {
      let partition = 'globals!'
      // this.currentRange = range
      // this.addressRange = range // this.partitionToAddressRange(partition)

      let globalAccounts = []
      let remainingAccountsToSync = []
      this.partitionStartTimeStamp = Date.now()

      // let lowAddress = this.addressRange.low
      // let highAddress = this.addressRange.high

      if (logFlags.debug) this.mainLogger.debug(`DATASYNC: syncStateDataGlobals partition: ${partition} `)

      this.readyforTXs = true // open the floodgates of queuing stuffs.

      //Get globals list and hash.

      let globalReport: GlobalAccountReportResp = await this.getRobustGlobalReport()

      let hasAllGlobalData = false

      if (globalReport.accounts.length === 0) {
        if (logFlags.debug) this.mainLogger.debug(`DATASYNC:  syncStateDataGlobals no global accounts `)
        return // no global accounts
      }
      if (logFlags.debug) this.mainLogger.debug(`DATASYNC:  syncStateDataGlobals globalReport: ${utils.stringifyReduce(globalReport)} `)

      let accountReportsByID: { [id: string]: { id: string; hash: string; timestamp: number } } = {}
      for (let report of globalReport.accounts) {
        remainingAccountsToSync.push(report.id)

        accountReportsByID[report.id] = report
      }
      let accountData: Shardus.WrappedData[] = []
      let accountDataById: { [id: string]: Shardus.WrappedData } = {}
      let globalReport2: GlobalAccountReportResp = { ready: false, combinedHash: '', accounts: [] }
      let maxTries = 10
      while (hasAllGlobalData === false) {
        maxTries--
        if (maxTries <= 0) {
          if (logFlags.error) this.mainLogger.error(`DATASYNC: syncStateDataGlobals max tries excceded `)
          return
        }
        if (logFlags.debug) this.mainLogger.debug(`DATASYNC: syncStateDataGlobals hasAllGlobalData === false `)
        //Get accounts.
        //this.combinedAccountData = []

        // Node Precheck!
        if (this.stateManager.isNodeValidForInternalMessage(this.dataSourceNode.id, 'syncStateDataGlobals', true, true) === false) {
          if (this.tryNextDataSourceNode('syncStateDataGlobals') == false) {
            break
          }
          continue
        }

        let message = { accountIds: remainingAccountsToSync }
        let result = await this.p2p.ask(this.dataSourceNode, 'get_account_data_by_list', message)

        if (result == null) {
          if (logFlags.verbose) if (logFlags.error) this.mainLogger.error('ASK FAIL syncStateTableData result == null')
          if (this.tryNextDataSourceNode('syncStateDataGlobals') == false) {
            break
          }
          continue
        }
        if (result.accountData == null) {
          if (logFlags.verbose) if (logFlags.error) this.mainLogger.error('ASK FAIL syncStateTableData result.accountData == null')
          if (this.tryNextDataSourceNode('syncStateDataGlobals') == false) {
            break
          }
          continue
        }
        //{ accountData: Shardus.WrappedData[] | null }
        //this.combinedAccountData = this.combinedAccountData.concat(result.accountData)
        accountData = accountData.concat(result.accountData)

        //Get globals list and hash (if changes then update said accounts and repeath)
        //diff the list and update remainingAccountsToSync
        // add any new accounts to globalAccounts
        if (logFlags.debug) this.mainLogger.debug(`DATASYNC: syncStateDataGlobals get_account_data_by_list ${utils.stringifyReduce(result)} `)

        globalReport2 = await this.getRobustGlobalReport()
        let accountReportsByID2: { [id: string]: { id: string; hash: string; timestamp: number } } = {}
        for (let report of globalReport2.accounts) {
          accountReportsByID2[report.id] = report
        }

        hasAllGlobalData = true
        remainingAccountsToSync = []
        for (let account of accountData) {
          accountDataById[account.accountId] = account
          //newer copies will overwrite older ones in this map
        }
        //check the full report for any missing data
        for (let report of globalReport2.accounts) {
          if (logFlags.debug) this.mainLogger.debug(`DATASYNC: syncStateDataGlobals loop globalReport2.accounts `)
          let data = accountDataById[report.id]
          if (data == null) {
            //we dont have the data
            hasAllGlobalData = false
            remainingAccountsToSync.push(report.id)
            if (logFlags.debug) this.mainLogger.debug(`DATASYNC: syncStateDataGlobals remainingAccountsToSync data===null ${utils.makeShortHash(report.id)} `)
          } else if (data.stateId !== report.hash) {
            //we have the data but he hash is wrong
            hasAllGlobalData = false
            remainingAccountsToSync.push(report.id)
            if (logFlags.debug) this.mainLogger.debug(`DATASYNC: syncStateDataGlobals remainingAccountsToSync data.stateId !== report.hash ${utils.makeShortHash(report.id)} `)
          }
        }
        //set this report to the last report and continue.
        accountReportsByID = accountReportsByID2
      }

      let dataToSet = []
      let cycleNumber = this.stateManager.currentCycleShardData.cycleNumber // Math.max(1, this.stateManager.currentCycleShardData.cycleNumber-1 ) //kinda hacky?

      let goodAccounts: Shardus.WrappedData[] = []

      //Write the data! and set global memory data!.  set accounts copy data too.
      for (let report of globalReport2.accounts) {
        if (logFlags.debug) this.mainLogger.debug(`DATASYNC: syncStateDataGlobals loop globalReport2.accounts 2`)
        let accountData = accountDataById[report.id]
        if (accountData != null) {
          dataToSet.push(accountData)
          goodAccounts.push(accountData)



        }
      }

      let failedHashes = await this.stateManager.checkAndSetAccountData(dataToSet, 'syncStateDataGlobals', true)

      this.syncStatement.numGlobalAccounts += dataToSet.length

      if (logFlags.console) console.log('DBG goodAccounts', goodAccounts)

      await this.stateManager.writeCombinedAccountDataToBackups(goodAccounts, failedHashes)

      if (failedHashes && failedHashes.length > 0) {
        throw new Error('setting data falied no error handling for this yet')
      }
      if (logFlags.debug) this.mainLogger.debug(`DATASYNC: syncStateDataGlobals complete synced ${dataToSet.length} accounts `)
    } catch (error) {
      if (error.message.includes('FailAndRestartPartition')) {
        if (logFlags.debug) this.mainLogger.debug(`DATASYNC: syncStateDataGlobals Error Failed at: ${error.stack}`)
        this.statemanager_fatal(`syncStateDataGlobals_ex_failandrestart`, 'DATASYNC: syncStateDataGlobals FailAndRestartPartition: ' + errorToStringFull(error))
        await this.failandRestart()
      } else {
        this.statemanager_fatal(`syncStateDataGlobals_ex`, 'syncStateDataGlobals failed: ' + errorToStringFull(error))
        if (logFlags.debug) this.mainLogger.debug(`DATASYNC: unexpected error. restaring sync:` + errorToStringFull(error))
        await this.failandRestart()
      }
    }

    this.globalAccountsSynced = true
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
    // this.p2p.registerInternal('get_globalaccountreport', async (payload:any, respond: (arg0: GlobalAccountReportResp) => any) => {
    //   let result = {combinedHash:"", accounts:[]} as GlobalAccountReportResp

    let equalFn = (a: GlobalAccountReportResp, b: GlobalAccountReportResp) => {
      // these fail cases should not count towards forming an hash consenus
      if (a.combinedHash == null || a.combinedHash === '') {
        return false
      }
      return a.combinedHash === b.combinedHash
    }
    let queryFn = async (node: Shardus.Node) => {
      // Node Precheck!
      if (this.stateManager.isNodeValidForInternalMessage(node.id, 'getRobustGlobalReport', true, true) === false) {
        return { ready: false, msg: `getRobustGlobalReport invalid node to ask: ${utils.stringifyReduce(node.id)}` }
      }

      let result = await this.p2p.ask(node, 'get_globalaccountreport', {})
      if (result === false) {
        if (logFlags.error) this.mainLogger.error(`ASK FAIL getRobustGlobalReport result === false node:${utils.stringifyReduce(node.id)}`)
      }
      if (result === null) {
        if (logFlags.error) this.mainLogger.error(`ASK FAIL getRobustGlobalReport result === null node:${utils.stringifyReduce(node.id)}`)
      }

      // TODO I dont know the best way to handle a non null network error here, below is something I had before but disabled for some reason

      if (result != null && result.accounts == null) {
        //if (logFlags.error) this.mainLogger.error('ASK FAIL getRobustGlobalReport result.stateHash == null')
        result = { ready: false, msg: `invalid data format: ${Math.random()}` }
      }
      if (result != null && result.ready === false) {
        //if (logFlags.error) this.mainLogger.error('ASK FAIL getRobustGlobalReport result.stateHash == null')
        result = { ready: false, msg: `not ready: ${Math.random()}` }
      }
      return result
    }
    //can ask any active nodes for global data.
    let nodes: Shardus.Node[] = this.stateManager.currentCycleShardData.activeNodes
    // let nodes = this.getActiveNodesInRange(lowAddress, highAddress) // this.p2p.state.getActiveNodes(this.p2p.id)
    if (nodes.length === 0) {
      if (logFlags.debug) this.mainLogger.debug(`no nodes available`)
      return // nothing to do
    }
    if (logFlags.debug) this.mainLogger.debug(`DATASYNC: robustQuery getRobustGlobalReport ${utils.stringifyReduce(nodes.map((node) => utils.makeShortHash(node.id) + ':' + node.externalPort))}`)
    let result
    let winners
    try {
      let robustQueryResult = await robustQuery(nodes, queryFn, equalFn, 3, false)
      result = robustQueryResult.topResult
      winners = robustQueryResult.winningNodes

      if (robustQueryResult.isRobustResult == false) {
        if (logFlags.debug) this.mainLogger.debug('getRobustGlobalReport: robustQuery ')
        this.statemanager_fatal(`getRobustGlobalReport_nonRobust`, 'getRobustGlobalReport: robustQuery ')
        throw new Error('FailAndRestartPartition_globalReport_A')
      }

      if (result.ready === false) {
        if (logFlags.debug) this.mainLogger.debug(`DATASYNC: getRobustGlobalReport results not ready wait 10 seconds and try again `)
        if (logFlags.console) console.log(`DATASYNC: getRobustGlobalReport results not ready wait 10 seconds and try again `)
        await utils.sleep(10 * 1000) //wait 10 seconds and try again.
        return await this.getRobustGlobalReport()
      }
    } catch (ex) {
      // NOTE: no longer expecting an exception from robust query in cases where we do not have enough votes or respones!
      //       but for now if isRobustResult == false then we local code wil throw an exception
      if (logFlags.debug) this.mainLogger.debug('getRobustGlobalReport: robustQuery ' + ex.name + ': ' + ex.message + ' at ' + ex.stack)
      this.statemanager_fatal(`getRobustGlobalReport_ex`, 'getRobustGlobalReport: robustQuery ' + ex.name + ': ' + ex.message + ' at ' + ex.stack)
      throw new Error('FailAndRestartPartition_globalReport_B')
    }
    if (!winners || winners.length === 0) {
      if (logFlags.debug) this.mainLogger.debug(`DATASYNC: getRobustGlobalReport no winners, going to throw fail and restart`)
      this.statemanager_fatal(`getRobustGlobalReport_noWin`, `DATASYNC: getRobustGlobalReport no winners, going to throw fail and restart`) // todo: consider if this is just an error
      throw new Error('FailAndRestartPartition_globalReport_noWin')
    }
    if (logFlags.debug) this.mainLogger.debug(`DATASYNC: getRobustGlobalReport found a winner.  results: ${utils.stringifyReduce(result)}`)
    this.dataSourceNodeIndex = 0
    this.dataSourceNode = winners[this.dataSourceNodeIndex] // Todo random index
    this.dataSourceNodeList = winners
    return result as GlobalAccountReportResp
  }

  /***
   *     ######  ##    ## ##    ##  ######   ######  ########    ###    ######## ######## ########    ###    ########  ##       ######## ########     ###    ########    ###
   *    ##    ##  ##  ##  ###   ## ##    ## ##    ##    ##      ## ##      ##    ##          ##      ## ##   ##     ## ##       ##       ##     ##   ## ##      ##      ## ##
   *    ##         ####   ####  ## ##       ##          ##     ##   ##     ##    ##          ##     ##   ##  ##     ## ##       ##       ##     ##  ##   ##     ##     ##   ##
   *     ######     ##    ## ## ## ##        ######     ##    ##     ##    ##    ######      ##    ##     ## ########  ##       ######   ##     ## ##     ##    ##    ##     ##
   *          ##    ##    ##  #### ##             ##    ##    #########    ##    ##          ##    ######### ##     ## ##       ##       ##     ## #########    ##    #########
   *    ##    ##    ##    ##   ### ##    ## ##    ##    ##    ##     ##    ##    ##          ##    ##     ## ##     ## ##       ##       ##     ## ##     ##    ##    ##     ##
   *     ######     ##    ##    ##  ######   ######     ##    ##     ##    ##    ########    ##    ##     ## ########  ######## ######## ########  ##     ##    ##    ##     ##
   */
  /**
   * syncStateTableData
   * @param lowAddress
   * @param highAddress
   * @param startTime
   * @param endTime
   */
  async syncStateTableData(lowAddress: string, highAddress: string, startTime: number, endTime: number) {
    let searchingForGoodData = true

    if (this.stateManager.currentCycleShardData == null) {
      return
    }


    let debugRange = ` ${utils.stringifyReduce(lowAddress)} - ${utils.stringifyReduce(highAddress)}`

    if (logFlags.console) console.log(`syncStateTableData startTime: ${startTime} endTime: ${endTime}` + '   time:' + Date.now())
    if (logFlags.debug) this.mainLogger.debug(`DATASYNC: syncStateTableData startTime: ${startTime} endTime: ${endTime} low: ${lowAddress} high: ${highAddress} `)
    // todo m11: this loop will try three more random nodes, this is slightly different than described how to handle failure in the doc. this should be corrected but will take more code
    // should prossible break this into a state machine in  its own class.
    while (searchingForGoodData) {
      // todo m11: this needs to be replaced
      // Sync the Account State Table First Pass
      //   Use the /get_account_state_hash API to get the hash from 3 or more nodes until there is a match between 3 nodes. Ts_start should be 0, or beginning of time.  The Ts_end value should be current time minus 10T (as configured)
      //   Use the /get_account_state API to get the data from one of the 3 nodes
      //   Take the hash of the data to ensure that it matches the expected hash value
      //   If not try getting the data from another node
      //   If the hash matches then update our Account State Table with the data
      //   Repeat this for each address range or partition
      let currentTs = Date.now()

      let safeTime = currentTs - this.stateManager.syncSettleTime
      if (endTime >= safeTime) {
        // need to idle for bit
        await utils.sleep(endTime - safeTime)
      }
      this.lastStateSyncEndtime = endTime + 1 // Adding +1 so that the next query will not overlap the time bounds. this saves us from a bunch of data tracking and filtering to remove duplicates when this function is called later

      let firstHash
      let queryLow
      let queryHigh

      queryLow = lowAddress
      queryHigh = highAddress
      let message = { accountStart: queryLow, accountEnd: queryHigh, tsStart: startTime, tsEnd: endTime }

      let equalFn = (a: AccountStateHashResp, b: AccountStateHashResp) => {
        if (a.stateHash == null) {
          return false // fail cases will get skipped so that we try more nodes.
        }
        return a.stateHash === b.stateHash
      }
      let queryFn = async (node: Shardus.Node) => {
        // Node Precheck!
        if (this.stateManager.isNodeValidForInternalMessage(node.id, 'get_account_state_hash', true, true) === false) {
          return { ready: false, msg: `get_account_state_hash invalid node to ask: ${utils.stringifyReduce(node.id)}` }
        }
        let result = await this.p2p.ask(node, 'get_account_state_hash', message)
        if (result === false) {
          if (logFlags.error) this.mainLogger.error(`ASK FAIL syncStateTableData result === false node:${utils.stringifyReduce(node.id)}`)
        }
        if (result == null) {
          if (logFlags.error) this.mainLogger.error(`ASK FAIL syncStateTableData result == null node:${utils.stringifyReduce(node.id)}`)
        }

        // TODO I dont know the best way to handle a non null network error here, below is an idea

        // if (result.stateHash == null) {
        //   if (logFlags.error) this.mainLogger.error('ASK FAIL syncStateTableData result.stateHash == null')
        //   result = null //if we get something back that is not the right data type clear it to null
        // }
        if (result != null && result.stateHash == null) {
          result = { ready: false, msg: `invalid data format: ${Math.random()}` }
          //if (logFlags.error) this.mainLogger.error('ASK FAIL syncStateTableData result.stateHash == null')
          result = null //if we get something back that is not the right data type clear it to null
        }

        if (result != null && result.ready === false) {
          result = { ready: false, msg: `nodeNotReady` }
          result = null
        }
        return result
      }

      let centerNode = ShardFunctions.getCenterHomeNode(this.stateManager.currentCycleShardData.shardGlobals, this.stateManager.currentCycleShardData.parititionShardDataMap, lowAddress, highAddress)
      if (centerNode == null) {
        if (logFlags.debug) this.mainLogger.debug(`centerNode not found`)
        return
      }

      let nodes: Shardus.Node[] = ShardFunctions.getNodesByProximity(
        this.stateManager.currentCycleShardData.shardGlobals,
        this.stateManager.currentCycleShardData.activeNodes,
        centerNode.ourNodeIndex,
        this.p2p.id,
        40
      )

      nodes = nodes.filter(this.removePotentiallyRemovedNodes)

      let filteredNodes = []
      for(let node of nodes){

        let nodeShardData = this.stateManager.currentCycleShardData.nodeShardDataMap.get(node.id)
        if(nodeShardData != null){

          if(ShardFunctions.testAddressInRange(queryLow, nodeShardData.consensusPartitions) === false){
            continue
          }
          if(ShardFunctions.testAddressInRange(queryHigh, nodeShardData.consensusPartitions) === false){
            continue
          }
          filteredNodes.push(node)
        }
      }
      nodes = filteredNodes

      if (Array.isArray(nodes) === false) {
        if (logFlags.error) this.mainLogger.error(`syncStateTableData: non array returned ${utils.stringifyReduce(nodes)}`)
        return // nothing to do
      }

      // let nodes = this.getActiveNodesInRange(lowAddress, highAddress) // this.p2p.state.getActiveNodes(this.p2p.id)
      if (nodes.length === 0) {
        if (logFlags.debug) this.mainLogger.debug(`no nodes available`)
        return // nothing to do
      }
      if (logFlags.debug)
        this.mainLogger.debug(`DATASYNC: robustQuery get_account_state_hash from ${utils.stringifyReduce(nodes.map((node) => utils.makeShortHash(node.id) + ':' + node.externalPort))}`)
      let result
      let winners
      try {
        let robustQueryResult = await robustQuery(nodes, queryFn, equalFn, 3, false)
        result = robustQueryResult.topResult
        winners = robustQueryResult.winningNodes

        let tries = 3
        while(result && result.ready === false && tries > 0){
          nestedCountersInstance.countEvent('sync','majority of nodes not ready, wait and retry')
          //too many nodes not ready
          await utils.sleep(30000) //wait 30 seconds and try again
          robustQueryResult = await robustQuery(nodes, queryFn, equalFn, 3, false)
          result = robustQueryResult.topResult
          winners = robustQueryResult.winningNodes
          tries--
        }

        if (robustQueryResult.isRobustResult == false) {
          if (logFlags.debug) this.mainLogger.debug('syncStateTableData: robustQuery ')
          this.statemanager_fatal(`syncStateTableData_nonRobust`, 'syncStateTableData: robustQuery ' + debugRange)
          throw new Error('FailAndRestartPartition_stateTable_A' + debugRange)
        }

      } catch (ex) {
        // NOTE: no longer expecting an exception from robust query in cases where we do not have enough votes or respones!
        //       but for now if isRobustResult == false then we local code wil throw an exception
        if (logFlags.debug) this.mainLogger.debug('syncStateTableData: robustQuery ' + ex.name + ': ' + ex.message + ' at ' + ex.stack)
        this.statemanager_fatal(`syncStateTableData_robustQ`, 'syncStateTableData: robustQuery ' + debugRange + ex.name + ': ' + ex.message + ' at ' + ex.stack)
        throw new Error('FailAndRestartPartition_stateTable_B' + debugRange)
      }

      if (result && result.stateHash) {
        if (logFlags.debug) this.mainLogger.debug(`DATASYNC: robustQuery returned result: ${result.stateHash}`)
        if (!winners || winners.length === 0) {
          if (logFlags.debug) this.mainLogger.debug(`DATASYNC: no winners, going to throw fail and restart`)
          this.statemanager_fatal(`syncStateTableData_noWin`, `DATASYNC: no winners, going to throw fail and restart` + debugRange) // todo: consider if this is just an error
          throw new Error('FailAndRestartPartition_stateTable_C' + debugRange)
        }
        this.dataSourceNode = winners[0] // Todo random index
        if (logFlags.debug)
          this.mainLogger.debug(`DATASYNC: got hash ${result.stateHash} from ${utils.stringifyReduce(winners.map((node: Shardus.Node) => utils.makeShortHash(node.id) + ':' + node.externalPort))}`)
        firstHash = result.stateHash
      } else {
        let resultStr = utils.stringifyReduce(result)
        if (logFlags.debug) this.mainLogger.debug(`DATASYNC: robustQuery get_account_state_hash failed ${result} `  + debugRange)
        throw new Error('FailAndRestartPartition_stateTable_D ' + result + debugRange)
      }

      let moreDataRemaining = true
      this.combinedAccountStateData = []
      let loopCount = 0

      let lowTimeQuery = startTime
      if (logFlags.debug) this.mainLogger.debug(`DATASYNC: hash: getting state table data from: ${utils.makeShortHash(this.dataSourceNode.id) + ':' + this.dataSourceNode.externalPort}`)

      // this loop is required since after the first query we may have to adjust the address range and re-request to get the next N data entries.
      while (moreDataRemaining) {
        // Node Precheck!
        if (this.stateManager.isNodeValidForInternalMessage(this.dataSourceNode.id, 'syncStateTableData', true, true) === false) {
          if (this.tryNextDataSourceNode('syncStateTableData') == false) {
            break
          }
          continue
        }

        let message = { accountStart: queryLow, accountEnd: queryHigh, tsStart: lowTimeQuery, tsEnd: endTime }
        let result = await this.p2p.ask(this.dataSourceNode, 'get_account_state', message)

        if (result == null) {
          if (logFlags.verbose) if (logFlags.error) this.mainLogger.error('ASK FAIL syncStateTableData result == null')
          if (this.tryNextDataSourceNode('syncStateDataGlobals') == false) {
            break
          }
          continue
        }
        if (result.accountStates == null) {
          if (logFlags.verbose) if (logFlags.error) this.mainLogger.error('ASK FAIL syncStateTableData result.accountStates == null')
          if (this.tryNextDataSourceNode('syncStateDataGlobals') == false) {
            break
          }
          continue
        }

        let accountStateData = result.accountStates
        // get the timestamp of the last account state received so we can use it as the low timestamp for our next query
        if (accountStateData.length > 0) {
          let lastAccount = accountStateData[accountStateData.length - 1]
          if (lastAccount.txTimestamp > lowTimeQuery) {
            lowTimeQuery = lastAccount.txTimestamp
          }
        }

        // If this is a repeated query, clear out any dupes from the new list we just got.
        // There could be many rows that use the stame timestamp so we will search and remove them
        let dataDuplicated = true
        if (loopCount > 0) {
          while (accountStateData.length > 0 && dataDuplicated) {
            let stateData = accountStateData[0]
            dataDuplicated = false
            for (let i = this.combinedAccountStateData.length - 1; i >= 0; i--) {
              let existingStateData = this.combinedAccountStateData[i]
              if (existingStateData.txTimestamp === stateData.txTimestamp && existingStateData.accountId === stateData.accountId) {
                dataDuplicated = true
                break
              }
              // once we get to an older timestamp we can stop looking, the outer loop will be done also
              if (existingStateData.txTimestamp < stateData.txTimestamp) {
                break
              }
            }
            if (dataDuplicated) {
              accountStateData.shift()
            }
          }
        }

        if (accountStateData.length === 0) {
          moreDataRemaining = false
        } else {
          if (logFlags.debug)
            this.mainLogger.debug(
              `DATASYNC: syncStateTableData got ${accountStateData.length} more records from ${utils.makeShortHash(this.dataSourceNode.id) + ':' + this.dataSourceNode.externalPort}`
            )
          this.combinedAccountStateData = this.combinedAccountStateData.concat(accountStateData)

          nestedCountersInstance.countEvent('sync', `statetable written`, accountStateData.length)

          loopCount++
        }
      }

      let seenAccounts = new Set()

      //only hash one account state per account. the most recent one!
      let filteredAccountStates = []
      for(let i = this.combinedAccountStateData.length -1; i>=0; i--){
        let accountState:Shardus.StateTableObject = this.combinedAccountStateData[i]

        if(seenAccounts.has(accountState.accountId) === true){
          continue
        }
        seenAccounts.add(accountState.accountId)
        filteredAccountStates.unshift(accountState)
      }



      let recievedStateDataHash = this.crypto.hash(filteredAccountStates)

      if (recievedStateDataHash === firstHash) {
        searchingForGoodData = false
      } else {
        if (logFlags.debug) this.mainLogger.debug(`DATASYNC: syncStateTableData finished downloading the requested data but the hash does not match`)
        // Failed again back through loop! TODO ? record/eval/report blame?
        this.stateManager.recordPotentialBadnode()
        throw new Error('FailAndRestartPartition_stateTable_E' + debugRange)
      }

      if (logFlags.debug) this.mainLogger.debug(`DATASYNC: syncStateTableData saving ${this.combinedAccountStateData.length} records to db`)
      // If the hash matches then update our Account State Table with the data
      await this.storage.addAccountStates(this.combinedAccountStateData) // keep in memory copy for faster processing...
      this.inMemoryStateTableData = this.inMemoryStateTableData.concat(this.combinedAccountStateData)

      this.syncStatement.numSyncedState += this.combinedAccountStateData.length
    }
  }

  /***
   *     ######  ##    ## ##    ##  ######     ###     ######   ######   #######  ##     ## ##    ## ######## ########     ###    ########    ###
   *    ##    ##  ##  ##  ###   ## ##    ##   ## ##   ##    ## ##    ## ##     ## ##     ## ###   ##    ##    ##     ##   ## ##      ##      ## ##
   *    ##         ####   ####  ## ##        ##   ##  ##       ##       ##     ## ##     ## ####  ##    ##    ##     ##  ##   ##     ##     ##   ##
   *     ######     ##    ## ## ## ##       ##     ## ##       ##       ##     ## ##     ## ## ## ##    ##    ##     ## ##     ##    ##    ##     ##
   *          ##    ##    ##  #### ##       ######### ##       ##       ##     ## ##     ## ##  ####    ##    ##     ## #########    ##    #########
   *    ##    ##    ##    ##   ### ##    ## ##     ## ##    ## ##    ## ##     ## ##     ## ##   ###    ##    ##     ## ##     ##    ##    ##     ##
   *     ######     ##    ##    ##  ######  ##     ##  ######   ######   #######   #######  ##    ##    ##    ########  ##     ##    ##    ##     ##
   */
  /**
   * syncAccountData
   * @param lowAddress
   * @param highAddress
   */
  async syncAccountData(lowAddress: string, highAddress: string) {
    // Sync the Account data
    //   Use the /get_account_data API to get the data from the Account Table using any of the nodes that had a matching hash
    if (logFlags.console) console.log(`syncAccountData3` + '   time:' + Date.now())

    if (this.config.stateManager == null) {
      throw new Error('this.config.stateManager == null')
    }

    let queryLow = lowAddress
    let queryHigh = highAddress

    let moreDataRemaining = true

    this.combinedAccountData = []
    let loopCount = 0

    let startTime = 0
    let lowTimeQuery = startTime

    if(this.useStateTable === false){
      this.getDataSourceNode(lowAddress, highAddress)
    }


    if(this.dataSourceNode === null){
      //if we see this then getDataSourceNode failed.
      // this is most likely because the ranges selected when we started sync are now invalid and too wide to be filled.

      //throwing this specific error text will bubble us up to the main sync loop and cause re-init of all the non global sync ranges/trackers
      throw new Error('reset-sync-ranges')
    }

    // this loop is required since after the first query we may have to adjust the address range and re-request to get the next N data entries.
    while (moreDataRemaining) {
      // Node Precheck!
      if (this.stateManager.isNodeValidForInternalMessage(this.dataSourceNode.id, 'syncAccountData', true, true) === false) {
        if (this.tryNextDataSourceNode('syncAccountData') == false) {
          break
        }
        continue
      }

      // max records artificially low to make testing coverage better.  todo refactor: make it a config or calculate based on data size
      let message = { accountStart: queryLow, accountEnd: queryHigh, tsStart: startTime, maxRecords: this.config.stateManager.accountBucketSize }
      let r: GetAccountData3Resp | boolean = await this.p2p.ask(this.dataSourceNode, 'get_account_data3', message) // need the repeatable form... possibly one that calls apply to allow for datasets larger than memory

      // TSConversion need to consider better error handling here!
      let result: GetAccountData3Resp = r as GetAccountData3Resp

      if (result == null) {
        if (logFlags.verbose) if (logFlags.error) this.mainLogger.error(`ASK FAIL syncAccountData result == null node:${this.dataSourceNode.id}`)
        if (this.tryNextDataSourceNode('syncAccountData') == false) {
          break
        }
        continue
      }
      if (result.data == null) {
        if (logFlags.verbose) if (logFlags.error) this.mainLogger.error(`ASK FAIL syncAccountData result.data == null node:${this.dataSourceNode.id}`)
        if (this.tryNextDataSourceNode('syncAccountData') == false) {
          break
        }
        continue
      }
      // accountData is in the form [{accountId, stateId, data}] for n accounts.
      let accountData = result.data.wrappedAccounts

      let lastUpdateNeeded = result.data.lastUpdateNeeded

      // get the timestamp of the last account data received so we can use it as the low timestamp for our next query
      if (accountData.length > 0) {
        let lastAccount = accountData[accountData.length - 1]
        if (lastAccount.timestamp > lowTimeQuery) {
          lowTimeQuery = lastAccount.timestamp
          startTime = lowTimeQuery
        }
      }

      // If this is a repeated query, clear out any dupes from the new list we just got.
      // There could be many rows that use the stame timestamp so we will search and remove them
      let dataDuplicated = true
      if (loopCount > 0) {
        while (accountData.length > 0 && dataDuplicated) {
          let stateData = accountData[0]
          dataDuplicated = false
          for (let i = this.combinedAccountData.length - 1; i >= 0; i--) {
            let existingStateData = this.combinedAccountData[i]
            if (existingStateData.timestamp === stateData.timestamp && existingStateData.accountId === stateData.accountId) {
              dataDuplicated = true
              break
            }
            // once we get to an older timestamp we can stop looking, the outer loop will be done also
            if (existingStateData.timestamp < stateData.timestamp) {
              break
            }
          }
          if (dataDuplicated) {
            accountData.shift()
          }
        }
      }

      // if we have any accounts in wrappedAccounts2
      let accountData2 = result.data.wrappedAccounts2
      if (accountData2.length > 0) {
        while (accountData.length > 0 && dataDuplicated) {
          let stateData = accountData2[0]
          dataDuplicated = false
          for (let i = this.combinedAccountData.length - 1; i >= 0; i--) {
            let existingStateData = this.combinedAccountData[i]
            if (existingStateData.timestamp === stateData.timestamp && existingStateData.accountId === stateData.accountId) {
              dataDuplicated = true
              break
            }
            // once we get to an older timestamp we can stop looking, the outer loop will be done also
            if (existingStateData.timestamp < stateData.timestamp) {
              break
            }
          }
          if (dataDuplicated) {
            accountData2.shift()
          }
        }
      }

      if (lastUpdateNeeded || (accountData2.length === 0 && accountData.length === 0)) {
        moreDataRemaining = false
        if (logFlags.debug)
          this.mainLogger.debug(
            `DATASYNC: syncAccountData3 got ${accountData.length} more records.  last update: ${lastUpdateNeeded} extra records: ${result.data.wrappedAccounts2.length} tsStart: ${lowTimeQuery} highestTS1: ${result.data.highestTs} delta:${result.data.delta}`
          )
        if (accountData.length > 0) {
          this.combinedAccountData = this.combinedAccountData.concat(accountData)
        }
        if (accountData2.length > 0) {
          this.combinedAccountData = this.combinedAccountData.concat(accountData2)
        }
      } else {
        if (logFlags.debug)
          this.mainLogger.debug(
            `DATASYNC: syncAccountData3b got ${accountData.length} more records.  last update: ${lastUpdateNeeded} extra records: ${result.data.wrappedAccounts2.length} tsStart: ${lowTimeQuery} highestTS1: ${result.data.highestTs} delta:${result.data.delta}`
          )
        this.combinedAccountData = this.combinedAccountData.concat(accountData)
        loopCount++
        // await utils.sleep(500)
      }
      await utils.sleep(200)
    }
  }

  /***
   *    ########  ########   #######   ######  ########  ######   ######     ###     ######   ######   #######  ##     ## ##    ## ######## ########     ###    ########    ###
   *    ##     ## ##     ## ##     ## ##    ## ##       ##    ## ##    ##   ## ##   ##    ## ##    ## ##     ## ##     ## ###   ##    ##    ##     ##   ## ##      ##      ## ##
   *    ##     ## ##     ## ##     ## ##       ##       ##       ##        ##   ##  ##       ##       ##     ## ##     ## ####  ##    ##    ##     ##  ##   ##     ##     ##   ##
   *    ########  ########  ##     ## ##       ######    ######   ######  ##     ## ##       ##       ##     ## ##     ## ## ## ##    ##    ##     ## ##     ##    ##    ##     ##
   *    ##        ##   ##   ##     ## ##       ##             ##       ## ######### ##       ##       ##     ## ##     ## ##  ####    ##    ##     ## #########    ##    #########
   *    ##        ##    ##  ##     ## ##    ## ##       ##    ## ##    ## ##     ## ##    ## ##    ## ##     ## ##     ## ##   ###    ##    ##     ## ##     ##    ##    ##     ##
   *    ##        ##     ##  #######   ######  ########  ######   ######  ##     ##  ######   ######   #######   #######  ##    ##    ##    ########  ##     ##    ##    ##     ##
   */

  /**
   * processAccountData
   *   // Process the Account data
   * //   For each account in the Account data make sure the entry in the Account State Table has the same State_after value; if not remove the record from the Account data
   * //   For each account in the Account State Table make sure the entry in Account data has the same State_after value; if not save the account id to be looked up later
   * //   Use the App.set_account_data function with the Account data to save the data to the application Accounts Table; if any failed accounts are returned save the account id to be looked up later
   * // State data = {accountId, txId, txTimestamp, stateBefore, stateAfter}
   * // accountData is in the form [{accountId, stateId, data}] for n accounts.
   */
  async processAccountData() : Promise<number> {

    if(this.useStateTable === false){
      return await this.processAccountDataNoStateTable()

    }

    this.missingAccountData = []
    this.mapAccountData = {}
    this.stateTableForMissingTXs = {}
    // create a fast lookup map for the accounts we have.  Perf.  will need to review if this fits into memory.  May need a novel structure.
    let account
    for (let i = 0; i < this.combinedAccountData.length; i++) {
      account = this.combinedAccountData[i]
      this.mapAccountData[account.accountId] = account
    }

    let accountKeys = Object.keys(this.mapAccountData)
    let uniqueAccounts = accountKeys.length
    let initialCombinedAccountLength = this.combinedAccountData.length
    if (uniqueAccounts < initialCombinedAccountLength) {
      // keep only the newest copies of each account:
      // we need this if using a time based datasync
      this.combinedAccountData = []
      for (let accountID of accountKeys) {
        this.combinedAccountData.push(this.mapAccountData[accountID])
      }
    }

    let missingButOkAccounts = 0
    let missingTXs = 0
    let handledButOk = 0
    let otherMissingCase = 0
    let futureStateTableEntry = 0
    let missingButOkAccountIDs: { [id: string]: boolean } = {}

    let missingAccountIDs: { [id: string]: boolean } = {}

    if (logFlags.debug)
      this.mainLogger.debug(
        `DATASYNC: processAccountData stateTableCount: ${this.inMemoryStateTableData.length} unique accounts: ${uniqueAccounts}  initial combined len: ${initialCombinedAccountLength}`
      )
    // For each account in the Account data make sure the entry in the Account State Table has the same State_after value; if not remove the record from the Account data

    for (let stateData of this.inMemoryStateTableData) {
      account = this.mapAccountData[stateData.accountId]
      // does the state data table have a node and we don't have data for it?
      if (account == null) {
        // make sure we have a transaction that matches this in our queue
        // the state table data we are working with is sufficiently old, so that we should have seen a transaction in our queue by the time we could get here

        // if the account is seend in state table data but this was state table data that was from after time lastStateSyncEndtime
        // then we wont care about missing this account.  receipt repair should take care of it.
        // alternatively this could be fixed with more advance logic on the receipt repair side of things.
        let time = Number(stateData.txTimestamp)
        if (time > this.lastStateSyncEndtime) {
          futureStateTableEntry++
          continue
        }

        //acceptedTXByHash seems to always be empty so this forces missingTXs
        // let txRef = this.acceptedTXByHash[stateData.txId]
        // if (txRef == null) {
        //   missingTXs++
        //   if (stateData.accountId != null) {
        //     this.missingAccountData.push(stateData.accountId)
        //     missingAccountIDs[stateData.accountId] = true
        //   }
        // } else
        if (stateData.stateBefore === allZeroes64) {
          // this means we are at the start of a valid state table chain that starts with creating an account
          missingButOkAccountIDs[stateData.accountId] = true
          missingButOkAccounts++
        } else if (missingButOkAccountIDs[stateData.accountId] === true) {
          // no action. we dont have account, but we know a different transaction will create it.
          handledButOk++
        } else {
          // unhandled case. not expected.  this would happen if the state table chain does not start with this account being created
          // this could be caused by a node trying to withold account data when syncing
          if (stateData.accountId != null) {
            this.missingAccountData.push(stateData.accountId)
            missingAccountIDs[stateData.accountId] = true
          }
          otherMissingCase++
        }
        // should we check timestamp for the state table data?
        continue
      }

      if (!account.syncData) {
        account.syncData = { timestamp: 0 }
      }

      if (account.stateId === stateData.stateAfter) {
        // mark it good.
        account.syncData.uptodate = true
        account.syncData.anyMatch = true
        if (stateData.txTimestamp > account.syncData.timestamp) {
          account.syncData.missingTX = false // finding a good match can clear the old error. this relys on things being in order!
          account.syncData.timestamp = stateData.txTimestamp

          //clear the missing reference if we have one
          delete this.stateTableForMissingTXs[stateData.accountId]
        }
      } else {
        // this state table data does not match up with what we have for the account

        // if the state table TS is newer than our sync data that means the account has changed
        // and the data we have for it is not up to date.
        if (stateData.txTimestamp > account.syncData.timestamp) {
          account.syncData.uptodate = false
          // account.syncData.stateData = stateData
          // chceck if we are missing a tx to handle this.
          let txRef = this.acceptedTXByHash[stateData.txId]
          if (txRef == null) {
            // account.syncData.missingTX = true
            // if (stateData.txTimestamp > account.syncData.timestamp) {
            account.syncData.missingTX = true
            // account.syncData.timestamp = stateData.txTimestamp
            // }
            // should we try to un foul the missingTX flag here??
          }

          account.syncData.timestamp = stateData.txTimestamp

          // record this because we may want to repair to it.
          this.stateTableForMissingTXs[stateData.accountId] = stateData
        }
      }
    }

    if (missingButOkAccounts > 0) {
      // it is valid / normal flow to get to this point:
      if (logFlags.debug)
        this.mainLogger.debug(
          `DATASYNC: processAccountData accouts missing from accountData, but are ok, because we have transactions for them: missingButOKList: ${missingButOkAccounts}, handledbutOK: ${handledButOk}`
        )
    }
    if (this.missingAccountData.length > 0) {
      // getting this indicates a non-typical problem that needs correcting
      if (logFlags.debug)
        this.mainLogger.debug(
          `DATASYNC: processAccountData accounts missing from accountData, but in the state table.  This is an unexpected error and we will need to handle them as failed accounts: missingList: ${
            this.missingAccountData.length
          }, missingTX count: ${missingTXs} missingUnique: ${Object.keys(missingAccountIDs).length}`
        )
    }

    //   For each account in the Account State Table make sure the entry in Account data has the same State_after value; if not save the account id to be looked up later
    this.accountsWithStateConflict = []
    let goodAccounts: Shardus.WrappedData[] = []
    let noSyncData = 0
    let noMatches = 0
    let outOfDateNoTxs = 0
    let unhandledCase = 0
    let fix1Worked = 0
    for (let account of this.combinedAccountData) {
      if (!account.syncData) {
        // this account was not found in state data
        this.accountsWithStateConflict.push(account)
        noSyncData++
        //turning this case back off.
      } else if (account.syncData.anyMatch === true) {
        if (account.syncData.missingTX) {
          fix1Worked++
          if (logFlags.debug) this.mainLogger.debug(`DATASYNC: processAccountData FIX WORKED. ${utils.stringifyReduce(account)}  `)
        }
        //this is the positive case. We have a match so we can use this account
        delete account.syncData
        goodAccounts.push(account)
      } else if (!account.syncData.anyMatch) {
        // this account was in state data but none of the state table stateAfter matched our state
        this.accountsWithStateConflict.push(account)
        noMatches++
      } else if (account.syncData.missingTX) {
        //
        this.accountsWithStateConflict.push(account)
        outOfDateNoTxs++
      } else {
        // could be good but need to check if we got stamped with some older datas.
        // if (account.syncData.uptodate === false) {
        //   // check for a missing transaction.
        //   // need to check above so that a right cant clear a wrong.
        //   let txRef = this.acceptedTXByHash[account.syncData.stateData.txId]
        //   if (txRef == null) {
        //     this.mainLogger.debug(`DATASYNC: processAccountData account not up to date ${utils.stringifyReduce(account)}`)
        //     this.accountsWithStateConflict.push(account)
        //     outOfDateNoTxs++
        //     continue
        //   }
        // }
        unhandledCase++

        // delete account.syncData
        // goodAccounts.push(account)
      }
    }

    if (logFlags.debug)
      this.mainLogger.debug(
        `DATASYNC: processAccountData saving ${goodAccounts.length} of ${this.combinedAccountData.length} records to db.  noSyncData: ${noSyncData} noMatches: ${noMatches} missingTXs: ${missingTXs} handledButOk: ${handledButOk} otherMissingCase: ${otherMissingCase} outOfDateNoTxs: ${outOfDateNoTxs} futureStateTableEntry:${futureStateTableEntry} unhandledCase:${unhandledCase} fix1Worked:${fix1Worked}`
      )
    // failedHashes is a list of accounts that failed to match the hash reported by the server
    let failedHashes = await this.stateManager.checkAndSetAccountData(goodAccounts, 'syncNonGlobals:processAccountData', true) // repeatable form may need to call this in batches


    this.syncStatement.numAccounts += goodAccounts.length

    if (failedHashes.length > 1000) {
      if (logFlags.debug) this.mainLogger.debug(`DATASYNC: processAccountData failed hashes over 1000:  ${failedHashes.length} restarting sync process`)
      // state -> try another node. TODO record/eval/report blame?
      this.stateManager.recordPotentialBadnode()
      throw new Error('FailAndRestartPartition_processAccountData_A')
    }
    if (failedHashes.length > 0) {
      if (logFlags.debug) this.mainLogger.debug(`DATASYNC: processAccountData failed hashes:  ${failedHashes.length} will have to download them again`)
      // TODO ? record/eval/report blame?
      this.stateManager.recordPotentialBadnode()
      this.failedAccounts = this.failedAccounts.concat(failedHashes)
      for (let accountId of failedHashes) {
        account = this.mapAccountData[accountId]

        if (logFlags.verbose) this.mainLogger.debug(`DATASYNC: processAccountData ${accountId}  data: ${utils.stringifyReduce(account)}`)

        if (account != null) {
          if (logFlags.verbose) this.mainLogger.debug(`DATASYNC: processAccountData adding account to list`)
          this.accountsWithStateConflict.push(account)
        } else {
          if (logFlags.verbose) this.mainLogger.debug(`DATASYNC: processAccountData cant find data: ${accountId}`)
          if (accountId) {
            //this.accountsWithStateConflict.push({ address: accountId,  }) //NOTE: fixed with refactor
            this.accountsWithStateConflict.push({ accountId: accountId, data: null, stateId: null, timestamp: 0 })
          }
        }
      }
    }

    let accountsSaved = await this.stateManager.writeCombinedAccountDataToBackups(goodAccounts, failedHashes)

    nestedCountersInstance.countEvent('sync', `accounts written`, accountsSaved)

    this.combinedAccountData = [] // we can clear this now.

    return accountsSaved
  }


  async processAccountDataNoStateTable() : Promise<number> {
    this.missingAccountData = []
    this.mapAccountData = {}
    this.stateTableForMissingTXs = {}
    // create a fast lookup map for the accounts we have.  Perf.  will need to review if this fits into memory.  May need a novel structure.
    let account
    for (let i = 0; i < this.combinedAccountData.length; i++) {
      account = this.combinedAccountData[i]
      this.mapAccountData[account.accountId] = account
    }

    let accountKeys = Object.keys(this.mapAccountData)
    let uniqueAccounts = accountKeys.length
    let initialCombinedAccountLength = this.combinedAccountData.length
    if (uniqueAccounts < initialCombinedAccountLength) {
      // keep only the newest copies of each account:
      // we need this if using a time based datasync
      this.combinedAccountData = []
      for (let accountID of accountKeys) {
        this.combinedAccountData.push(this.mapAccountData[accountID])
      }
    }

    let missingButOkAccounts = 0
    let missingTXs = 0
    let handledButOk = 0
    let otherMissingCase = 0
    let futureStateTableEntry = 0
    let missingButOkAccountIDs: { [id: string]: boolean } = {}

    let missingAccountIDs: { [id: string]: boolean } = {}

    if (logFlags.debug)
      this.mainLogger.debug(
        `DATASYNC: processAccountData stateTableCount: ${this.inMemoryStateTableData.length} unique accounts: ${uniqueAccounts}  initial combined len: ${initialCombinedAccountLength}`
      )
    // For each account in the Account data make sure the entry in the Account State Table has the same State_after value; if not remove the record from the Account data


    //   For each account in the Account State Table make sure the entry in Account data has the same State_after value; if not save the account id to be looked up later
    this.accountsWithStateConflict = []
    let goodAccounts: Shardus.WrappedData[] = []
    let noSyncData = 0
    let noMatches = 0
    let outOfDateNoTxs = 0
    let unhandledCase = 0
    let fix1Worked = 0
    for (let account of this.combinedAccountData) {
      goodAccounts.push(account)
    }

    if (logFlags.debug)
      this.mainLogger.debug(
        `DATASYNC: processAccountData saving ${goodAccounts.length} of ${this.combinedAccountData.length} records to db.  noSyncData: ${noSyncData} noMatches: ${noMatches} missingTXs: ${missingTXs} handledButOk: ${handledButOk} otherMissingCase: ${otherMissingCase} outOfDateNoTxs: ${outOfDateNoTxs} futureStateTableEntry:${futureStateTableEntry} unhandledCase:${unhandledCase} fix1Worked:${fix1Worked}`
      )
    // failedHashes is a list of accounts that failed to match the hash reported by the server
    let failedHashes = await this.stateManager.checkAndSetAccountData(goodAccounts, 'syncNonGlobals:processAccountDataNoStateTable', true) // repeatable form may need to call this in batches

    this.syncStatement.numAccounts += goodAccounts.length

    if (failedHashes.length > 1000) {
      if (logFlags.debug) this.mainLogger.debug(`DATASYNC: processAccountData failed hashes over 1000:  ${failedHashes.length} restarting sync process`)
      // state -> try another node. TODO record/eval/report blame?
      this.stateManager.recordPotentialBadnode()
      throw new Error('FailAndRestartPartition_processAccountData_A')
    }
    if (failedHashes.length > 0) {
      if (logFlags.debug) this.mainLogger.debug(`DATASYNC: processAccountData failed hashes:  ${failedHashes.length} will have to download them again`)
      // TODO ? record/eval/report blame?
      this.stateManager.recordPotentialBadnode()
      this.failedAccounts = this.failedAccounts.concat(failedHashes)
      for (let accountId of failedHashes) {
        account = this.mapAccountData[accountId]

        if (logFlags.verbose) this.mainLogger.debug(`DATASYNC: processAccountData ${accountId}  data: ${utils.stringifyReduce(account)}`)

        if (account != null) {
          if (logFlags.verbose) this.mainLogger.debug(`DATASYNC: processAccountData adding account to list`)
          this.accountsWithStateConflict.push(account)
        } else {
          if (logFlags.verbose) this.mainLogger.debug(`DATASYNC: processAccountData cant find data: ${accountId}`)
          if (accountId) {
            //this.accountsWithStateConflict.push({ address: accountId,  }) //NOTE: fixed with refactor
            this.accountsWithStateConflict.push({ accountId: accountId, data: null, stateId: null, timestamp: 0 })
          }
        }
      }
    }

    let accountsSaved = await this.stateManager.writeCombinedAccountDataToBackups(goodAccounts, failedHashes)

    nestedCountersInstance.countEvent('sync', `accounts written`, accountsSaved)

    this.combinedAccountData = [] // we can clear this now.

    return accountsSaved
  }




  getDataSourceNode(lowAddress: string, highAddress: string) {

    if (this.stateManager.currentCycleShardData == null) {
      return
    }

    let queryLow
    let queryHigh

    queryLow = lowAddress
    queryHigh = highAddress

    let centerNode = ShardFunctions.getCenterHomeNode(this.stateManager.currentCycleShardData.shardGlobals, this.stateManager.currentCycleShardData.parititionShardDataMap, lowAddress, highAddress)
    if (centerNode == null) {
      if (logFlags.debug) this.mainLogger.debug(`centerNode not found`)
      return
    }

    let nodes: Shardus.Node[] = ShardFunctions.getNodesByProximity(
      this.stateManager.currentCycleShardData.shardGlobals,
      this.stateManager.currentCycleShardData.activeNodes,
      centerNode.ourNodeIndex,
      this.p2p.id,
      40
    )

    nodes = nodes.filter(this.removePotentiallyRemovedNodes)

    let filteredNodes = []
    for(let node of nodes){

      let nodeShardData = this.stateManager.currentCycleShardData.nodeShardDataMap.get(node.id)
      if(nodeShardData != null){

        if(ShardFunctions.testAddressInRange(queryLow, nodeShardData.consensusPartitions) === false){
          continue
        }
        if(ShardFunctions.testAddressInRange(queryHigh, nodeShardData.consensusPartitions) === false){
          continue
        }
        filteredNodes.push(node)
      }
    }
    nodes = filteredNodes
    if(nodes.length > 0){
      this.dataSourceNode = nodes[Math.floor(Math.random() * nodes.length)]
    }
  }

  /**
   * failedAccountsRemain
   */
  failedAccountsRemain(): boolean {
    // clean out account conflicts based on what TXs we we have in the queue that we can repair.
    // also mark tx for scheduled repair..

    // failed counts went way down after fixing liberdus end of things so putting this optimization on hold.

    if (this.accountsWithStateConflict.length === 0 && this.missingAccountData.length === 0) {
      return false
    }
    return true
  }

  /***
   *     ######  ##    ## ##    ##  ######  ########    ###    #### ##       ######## ########     ###     ######   ######   ######   #######  ##     ## ##    ## ########  ######
   *    ##    ##  ##  ##  ###   ## ##    ## ##         ## ##    ##  ##       ##       ##     ##   ## ##   ##    ## ##    ## ##    ## ##     ## ##     ## ###   ##    ##    ##    ##
   *    ##         ####   ####  ## ##       ##        ##   ##   ##  ##       ##       ##     ##  ##   ##  ##       ##       ##       ##     ## ##     ## ####  ##    ##    ##
   *     ######     ##    ## ## ## ##       ######   ##     ##  ##  ##       ######   ##     ## ##     ## ##       ##       ##       ##     ## ##     ## ## ## ##    ##     ######
   *          ##    ##    ##  #### ##       ##       #########  ##  ##       ##       ##     ## ######### ##       ##       ##       ##     ## ##     ## ##  ####    ##          ##
   *    ##    ##    ##    ##   ### ##    ## ##       ##     ##  ##  ##       ##       ##     ## ##     ## ##    ## ##    ## ##    ## ##     ## ##     ## ##   ###    ##    ##    ##
   *     ######     ##    ##    ##  ######  ##       ##     ## #### ######## ######## ########  ##     ##  ######   ######   ######   #######   #######  ##    ##    ##     ######
   */
  /**
   * syncFailedAcccounts
   *   // Sync the failed accounts
   * //   Log that some account failed
   * //   Use the /get_account_data_by_list API to get the data for the accounts that need to be looked up later from any of the nodes that had a matching hash but different from previously used nodes
   * //   Repeat the “Sync the Account State Table Second Pass” step
   * //   Repeat the “Process the Account data” step
   *
   * @param lowAddress
   * @param highAddress
   */
  async syncFailedAcccounts(lowAddress: string, highAddress: string) {
    if (this.accountsWithStateConflict.length === 0 && this.missingAccountData.length === 0) {
      if (logFlags.debug) this.mainLogger.debug(`DATASYNC: syncFailedAcccounts no failed hashes to sync`)
      return
    }

    nestedCountersInstance.countEvent('sync', 'syncFailedAcccounts')
    this.syncStatement.failedAccountLoops++

    if (logFlags.verbose) this.mainLogger.debug(`DATASYNC: syncFailedAcccounts start`)
    let addressList: string[] = []
    for (let accountEntry of this.accountsWithStateConflict) {
      // //NOTE: fixed with refactor
      // if (accountEntry.data && accountEntry.data.address) {
      //     addressList.push(accountEntry.data.address)
      if (accountEntry.accountId) {
        addressList.push(accountEntry.accountId)
      } else {
        if (logFlags.verbose) this.mainLogger.debug(`DATASYNC: syncFailedAcccounts failed to add account ${accountEntry}`)
      }
    }
    // add the addresses of accounts that we got state table data for but not data for
    addressList = addressList.concat(this.missingAccountData)
    this.missingAccountData = []

    // TODO m11:  should we pick different nodes to ask? (at the very least need to change the data source node!!!!!!)
    if (logFlags.debug) this.mainLogger.debug(`DATASYNC: syncFailedAcccounts requesting data for failed hashes ${utils.stringifyReduce(addressList)}`)

    // Node Precheck!
    if (this.stateManager.isNodeValidForInternalMessage(this.dataSourceNode.id, 'syncStateDataGlobals', true, true) === false) {
      if (this.tryNextDataSourceNode('syncStateDataGlobals') == false) {
        return
      }
      //we picked a new node to ask so relaunch
      await this.syncFailedAcccounts(lowAddress, highAddress)
      return
    }

    let message = { accountIds: addressList }
    let result = await this.p2p.ask(this.dataSourceNode, 'get_account_data_by_list', message)

    nestedCountersInstance.countEvent('sync', 'syncFailedAcccounts accountsFailed', addressList.length)
    this.syncStatement.failedAccounts += addressList.length

    if (result == null) {
      if (logFlags.verbose) if (logFlags.error) this.mainLogger.error('ASK FAIL syncFailedAcccounts result == null')
      if (this.tryNextDataSourceNode('syncStateDataGlobals') == false) {
        return
      }
      //we picked a new node to ask so relaunch
      await this.syncFailedAcccounts(lowAddress, highAddress)
      return
    }
    if (result.accountData == null) {
      if (logFlags.verbose) if (logFlags.error) this.mainLogger.error('ASK FAIL syncFailedAcccounts result.accountData == null')
      if (this.tryNextDataSourceNode('syncStateDataGlobals') == false) {
        return
      }
      //we picked a new node to ask so relaunch
      await this.syncFailedAcccounts(lowAddress, highAddress)
      return
    }

    this.combinedAccountData = this.combinedAccountData.concat(result.accountData)

    if (logFlags.debug) this.mainLogger.debug(`DATASYNC: syncFailedAcccounts combinedAccountData: ${this.combinedAccountData.length} accountData: ${result.accountData.length}`)
    if(this.useStateTable === true){
      await this.syncStateTableData(lowAddress, highAddress, this.lastStateSyncEndtime, Date.now())
    }
    // process the new accounts.
    await this.processAccountData()
  }

  /***
   *    ########  ######## ########     ###    #### ########  ##     ## ####  ######   ######  #### ##    ##  ######   ######## ##     ##  ######
   *    ##     ## ##       ##     ##   ## ##    ##  ##     ## ###   ###  ##  ##    ## ##    ##  ##  ###   ## ##    ##     ##     ##   ##  ##    ##
   *    ##     ## ##       ##     ##  ##   ##   ##  ##     ## #### ####  ##  ##       ##        ##  ####  ## ##           ##      ## ##   ##
   *    ########  ######   ########  ##     ##  ##  ########  ## ### ##  ##   ######   ######   ##  ## ## ## ##   ####    ##       ###     ######
   *    ##   ##   ##       ##        #########  ##  ##   ##   ##     ##  ##        ##       ##  ##  ##  #### ##    ##     ##      ## ##         ##
   *    ##    ##  ##       ##        ##     ##  ##  ##    ##  ##     ##  ##  ##    ## ##    ##  ##  ##   ### ##    ##     ##     ##   ##  ##    ##
   *    ##     ## ######## ##        ##     ## #### ##     ## ##     ## ####  ######   ######  #### ##    ##  ######      ##    ##     ##  ######
   */
  /**
   * repairMissingTXs
   *
   */
  async repairMissingTXs() {
    nestedCountersInstance.countEvent('sync', 'repairMissingTXs')

    let keys = Object.keys(this.stateTableForMissingTXs)

    if (logFlags.debug) this.mainLogger.debug(`DATASYNC: repairMissingTXs begin: ${keys.length} ${utils.stringifyReduce(keys)}`)
    for (let key of keys) {
      try {
        this.profiler.profileSectionStart('repairMissingTX')
        let stateTableData = this.stateTableForMissingTXs[key]

        if (stateTableData == null) {
          nestedCountersInstance.countEvent('sync', 'repairMissingTXs stateTableData == null')
          continue
        }
        if (stateTableData.txId == null) {
          nestedCountersInstance.countEvent('sync', 'repairMissingTXs stateTableData.txId == null')
          continue
        }

        if (logFlags.debug) this.mainLogger.debug(`DATASYNC: repairMissingTXs start: ${utils.stringifyReduce(stateTableData)}`)
        //get receipt for txID
        let result = await this.stateManager.transactionRepair.requestMissingReceipt(stateTableData.txId, Number(stateTableData.txTimestamp), stateTableData.accountId)
        if (result != null && result.success === true) {
          let repairOk = await this.stateManager.transactionRepair.repairToMatchReceiptWithoutQueueEntry(result.receipt, stateTableData.accountId)
          if (logFlags.debug) this.mainLogger.debug(`DATASYNC: repairMissingTXs finished: ok:${repairOk} ${utils.stringifyReduce(stateTableData)}`)
        } else {
          if (logFlags.debug) this.mainLogger.debug(`DATASYNC: repairMissingTXs cant get receipt: ${utils.stringifyReduce(stateTableData)}`)
          this.statemanager_fatal(`repairMissingTXs_fail`, `repairMissingTXs_fail ${utils.stringifyReduce(stateTableData)} result:${utils.stringifyReduce(result)}`)
        }
      } catch (error) {
        this.statemanager_fatal(`repairMissingTXs_ex`, 'repairMissingTXs ex: ' + errorToStringFull(error))
      } finally {
        this.profiler.profileSectionEnd('repairMissingTX')
      }
    }
  }

  /**
   * failandRestart
   */
  async failandRestart() {
    this.mainLogger.info(`DATASYNC: failandRestart`)
    this.logger.playbackLogState('datasyncFail', '', '')
    this.clearSyncData()

    // using set timeout before we resume to prevent infinite stack depth.
    // setTimeout(async () => {
    //   await this.syncStateDataForPartition(this.currentPartition)
    // }, 1000)
    await utils.sleep(1000)


    if(this.forceSyncComplete){
      nestedCountersInstance.countEvent('sync', 'forceSyncComplete')
      this.syncStatmentIsComplete()
      this.clearSyncData()
      this.skipSync()

      //make sync trackers clean up
      for (let syncTracker of this.syncTrackers) {
        syncTracker.syncFinished = true
      }
      return
    }


    nestedCountersInstance.countEvent('sync', 'fail and restart')
    this.syncStatement.failAndRestart++

    //TODO proper restart not useing global var
    await this.syncStateDataForRange(this.currentRange)
  }

  /**
   * failAndDontRestartSync
   */
  failAndDontRestartSync() {
    this.mainLogger.info(`DATASYNC: failAndDontRestartSync`)
    // need to clear more?
    this.clearSyncData()
    this.syncTrackers = []
  }

  /**
   * tryNextDataSourceNode
   * @param debugString
   */
  tryNextDataSourceNode(debugString): boolean {
    this.dataSourceNodeIndex++
    if (logFlags.error) this.mainLogger.error(`tryNextDataSourceNode ${debugString} try next node: ${this.dataSourceNodeIndex}`)
    if (this.dataSourceNodeIndex >= this.dataSourceNodeList.length) {
      if (logFlags.error) this.mainLogger.error(`tryNextDataSourceNode ${debugString} ran out of nodes ask for data`)
      this.dataSourceNodeIndex = 0
      return false
    }
    // pick new data source node
    this.dataSourceNode = this.dataSourceNodeList[this.dataSourceNodeIndex]
    return true
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
        let syncTracker = this.syncTrackers[i]

        if(syncTracker.isPartOfInitialSync){
          initalSyncRemaining++
        }

        if (syncTracker.syncFinished === true) {
          if (logFlags.playback) this.logger.playbackLogNote('shrd_sync_trackerRangeClear', ` `, ` ${utils.stringifyReduce(syncTracker.range)} `)

          // allow syncing queue entries to resume!
          for (let queueEntry of syncTracker.queueEntries) {

            //need to decrement this per key
            for(let key of queueEntry.uniqueKeys){
              if(syncTracker.keys[key] === true){
                queueEntry.syncCounter--
              }
            }
            //queueEntry.syncCounter--

            if (queueEntry.syncCounter <= 0) {
              // dont adjust a
              let found = this.stateManager.transactionQueue.getQueueEntry(queueEntry.acceptedTx.id)
              if (!found) {
                this.logger.playbackLogNote(
                  'shrd_sync_wakeupTX_skip1',
                  `${queueEntry.acceptedTx.id}`,
                  `not in active queue qId: ${queueEntry.entryID} ts: ${queueEntry.txKeys.timestamp} acc: ${utils.stringifyReduce(queueEntry.txKeys.allKeys)}`
                )
                continue
              }
              // todo other stats to not mess with?
              if (queueEntry.state != 'syncing') {
                this.logger.playbackLogNote(
                  'shrd_sync_wakeupTX_skip2',
                  `${queueEntry.acceptedTx.id}`,
                  `state!=syncing ${queueEntry.state} qId: ${queueEntry.entryID} ts: ${queueEntry.txKeys.timestamp} acc: ${utils.stringifyReduce(queueEntry.txKeys.allKeys)}`
                )
                continue
              }

              let before = queueEntry.ourNodeInTransactionGroup
              if (queueEntry.ourNodeInTransactionGroup === false) {
                let old = queueEntry.transactionGroup
                queueEntry.transactionGroup = null
                this.stateManager.transactionQueue.queueEntryGetTransactionGroup(queueEntry)
                //@ts-ignore ourNodeInTransactionGroup is updated by queueEntryGetTransactionGroup
                // if(queueEntry.ourNodeInTransactionGroup === true){
                //   queueEntry.conensusGroup = null
                //   this.stateManager.transactionQueue.queueEntryGetConsensusGroup(queueEntry)
                // }

                //Restore the TX group, because we only want to know what nodes were in the group at the time of the TX
                queueEntry.transactionGroup = old
                if (logFlags.playback)
                  this.logger.playbackLogNote(
                    'shrd_sync_wakeupTX_txGroupUpdate',
                    `${queueEntry.acceptedTx.id}`,
                    `new value: ${queueEntry.ourNodeInTransactionGroup}   qId: ${queueEntry.entryID} ts: ${queueEntry.txKeys.timestamp} acc: ${utils.stringifyReduce(queueEntry.txKeys.allKeys)}`
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
                  `${queueEntry.acceptedTx.id}`,
                  `before: ${before} inTXGrp: ${queueEntry.ourNodeInTransactionGroup} qId: ${queueEntry.entryID} ts: ${queueEntry.txKeys.timestamp} acc: ${utils.stringifyReduce(
                    queueEntry.txKeys.allKeys
                  )}`
                )
              // } else {
              //   if (logFlags.playback ) this.logger.playbackLogNote('shrd_sync_wakeupTXcancel', `${queueEntry.acceptedTx.id}`, ` qId: ${queueEntry.entryID} ts: ${queueEntry.txKeys.timestamp} acc: ${utils.stringifyReduce(queueEntry.txKeys.allKeys)}`)
              //   queueEntry.state = 'canceled'
              //   queueEntry.didWakeup = true
              // }
            }
          }
          syncTracker.queueEntries = []
          this.syncTrackers.splice(i, 1)
        }
      }
      if (logFlags.playback) this.logger.playbackLogNote('shrd_sync_trackerRangeClearFinished', ` `, `num trackers left: ${this.syncTrackers.length} `)

      if(this.initalSyncRemaining > 0 && initalSyncRemaining === 0){
        this.initalSyncFinished = true
        this.initalSyncRemaining = 0
        if (logFlags.debug) this.mainLogger.debug(`DATASYNC: initalSyncFinished.`)
        nestedCountersInstance.countEvent('sync',`initialSyncFinished ${this.stateManager.currentCycleShardData.cycleNumber}`)
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
    // await utils.sleep(8000) // sleep to make sure we are listening to some txs before we sync them // I think we can skip this.

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
        let arrayCopy = this.syncTrackers.slice(0)
        for (let syncTracker of arrayCopy) {
          if (syncTracker.syncStarted === false) {
            // let partition = syncTracker.partition
            if (logFlags.console) console.log(`rtsyncTracker start. time:${Date.now()} data: ${utils.stringifyReduce(syncTracker)}}`)
            if (logFlags.playback) this.logger.playbackLogNote('rt_shrd_sync_trackerRangeStart', ` `, ` ${utils.stringifyReduce(syncTracker.range)} `)

            syncTracker.syncStarted = true
            startedCount++
            await this.syncStateDataForRange(syncTracker.range)
            syncTracker.syncFinished = true

            if (logFlags.playback) this.logger.playbackLogNote('rt_shrd_sync_trackerRangeEnd', ` `, ` ${utils.stringifyReduce(syncTracker.range)} `)
            this.clearSyncData()
          }
        }
      } while (startedCount > 0)
    } catch (ex) {
      if (logFlags.debug) this.mainLogger.debug('syncRuntimeTrackers: ' + ex.name + ': ' + ex.message + ' at ' + ex.stack)
      this.statemanager_fatal(`syncRuntimeTrackers_ex`, 'syncRuntimeTrackers: ' + ex.name + ': ' + ex.message + ' at ' + ex.stack)

      //clear out sync trackers and let repair handle it if needed.
      let cleared = this.syncTrackers.length
      let kept = 0
      let newTrackers = 0

      let cycle = this.stateManager.currentCycleShardData.cycleNumber
      let lastCycle = cycle - 1

      nestedCountersInstance.countRareEvent('sync', `RETRYSYNC: runtime. lastCycle: ${lastCycle} cycle: ${cycle} ${JSON.stringify({cleared, kept, newTrackers})}`)

      // clear all sync trackers.
      this.syncTrackers = []
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
  createSyncTrackerByRange(range: StateManagerTypes.shardFunctionTypes.BasicAddressRange, cycle: number, initalSync: boolean = false): SyncTracker {
    // let partition = -1
    let index = this.syncTrackerIndex++
    let syncTracker = { range, queueEntries: [], cycle, index, syncStarted: false, syncFinished: false, isGlobalSyncTracker: false, globalAddressMap: {}, isPartOfInitialSync:initalSync, keys:{}  } as SyncTracker // partition,
    syncTracker.syncStarted = false
    syncTracker.syncFinished = false

    this.syncTrackers.push(syncTracker) // we should maintain this order.

    if(initalSync){
      this.initalSyncRemaining++
    }

    return syncTracker
  }

  createSyncTrackerByForGlobals(cycle: number, initalSync: boolean = false): SyncTracker {
    // let partition = -1
    let index = this.syncTrackerIndex++
    let syncTracker = { range: {}, queueEntries: [], cycle, index, syncStarted: false, syncFinished: false, isGlobalSyncTracker: true, globalAddressMap: {}, isPartOfInitialSync:initalSync, keys:{} } as SyncTracker // partition,
    syncTracker.syncStarted = false
    syncTracker.syncFinished = false

    this.syncTrackers.push(syncTracker) // we should maintain this order.

    if(initalSync){
      this.initalSyncRemaining++
    }

    return syncTracker
  }

  getSyncTracker(address: string): SyncTracker | null {
    // return the sync tracker.
    for (let i = 0; i < this.syncTrackers.length; i++) {
      let syncTracker = this.syncTrackers[i]

      // need to see if address is in range. if so return the tracker.
      // if (ShardFunctions.testAddressInRange(address, syncTracker.range)) {
      //if(syncTracker.isGlobalSyncTracker){
      if (syncTracker.range.low <= address && address <= syncTracker.range.high) {
        return syncTracker
      }
      //}else{
      if (syncTracker.isGlobalSyncTracker === true && syncTracker.globalAddressMap[address] === true) {
        return syncTracker
      }
      //}
    }
    return null
  }

  // Check the entire range for a partition to see if any of it is covered by a sync tracker.
  getSyncTrackerForParition(partitionID: number, cycleShardData: CycleShardData): SyncTracker | null {
    if (cycleShardData == null) {
      return null
    }
    let partitionShardData: StateManagerTypes.shardFunctionTypes.ShardInfo = cycleShardData.parititionShardDataMap.get(partitionID)

    let addressLow = partitionShardData.homeRange.low
    let addressHigh = partitionShardData.homeRange.high
    // return the sync tracker.
    for (let i = 0; i < this.syncTrackers.length; i++) {
      let syncTracker = this.syncTrackers[i]
      // if (syncTracker.isGlobalSyncTracker === true && syncTracker.globalAddressMap[address] === true) {
      //   return syncTracker
      // }
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

  removePotentiallyRemovedNodes(node){
    return potentiallyRemoved.has(node.id) != true
  }

  // onlyConsensusNodes(node){
  //   return potentiallyRemoved.has(node.id) != true
  // }

}

export default AccountSync
