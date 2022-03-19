import Log4js from 'log4js'
import LoadDetection from '../load-detection'
import Logger, {logFlags} from '../logger'
import { ipInfo } from '../network'
import { config, crypto } from '../p2p/Context'
import * as Context from '../p2p/Context'
import { getDesiredCount, lastScalingType, requestedScalingType } from '../p2p/CycleAutoScale'
import * as CycleChain from '../p2p/CycleChain'
import * as Self from '../p2p/Self'
import * as NodeList from '../p2p/NodeList'
import * as Rotation from '../p2p/Rotation'
import StateManager from '../state-manager'
import Statistics from '../statistics'
import Profiler from '../utils/profiler'
import packageJson from '../../package.json'
import { isDebugModeAnd } from '../debug'
import { nestedCountersInstance } from '../utils/nestedCounters'
import { memoryReportingInstance } from '../utils/memoryReporting'

const http = require('../http')
const allZeroes64 = '0'.repeat(64)

// import Shardus = require('../shardus/shardus-types')

/**
 * @typedef {import('../state-manager/index').CycleShardData} CycleShardData
 */

interface StatisticsReport {
  txInjected: number
  txApplied: number
  txRejected: number
  txProcessed: number
  txExpired: number
}

interface Reporter {
  config: any
  mainLogger: Log4js.Logger
  p2p: any
  statistics: Statistics
  stateManager: StateManager
  profiler: Profiler
  loadDetection: LoadDetection
  logger: Logger
  reportTimer: NodeJS.Timeout
  lastTime: number
  doConsoleReport: boolean
  hasRecipient: boolean
  statisticsReport: StatisticsReport
}
class Reporter {
  constructor(
    config,
    logger,
    statistics,
    stateManager,
    profiler,
    loadDetection
  ) {
    this.config = config
    this.mainLogger = logger.getLogger('main')
    this.statistics = statistics
    this.stateManager = stateManager
    this.profiler = profiler
    this.loadDetection = loadDetection
    this.logger = logger

    this.reportTimer = null

    this.lastTime = Date.now()

    this.doConsoleReport = isDebugModeAnd((config) => config.profiler);

    this.hasRecipient = this.config.recipient != null
    this.resetStatisticsReport()
  }

  resetStatisticsReport() {
    this.statisticsReport = {
      txInjected: 0,
      txApplied: 0,
      txRejected: 0,
      txProcessed: 0,
      txExpired: 0,
    }
  }

  collectStatisticToReport() {
    this.statisticsReport.txInjected += this.statistics
      ? this.statistics.getPreviousElement('txInjected')
      : 0
    this.statisticsReport.txApplied += this.statistics
      ? this.statistics.getPreviousElement('txApplied')
      : 0
    this.statisticsReport.txRejected += this.statistics
      ? this.statistics.getPreviousElement('txRejected')
      : 0
    this.statisticsReport.txExpired += this.statistics
      ? this.statistics.getPreviousElement('txExpired')
      : 0
    this.statisticsReport.txProcessed += this.statistics
      ? this.statistics.getPreviousElement('txProcessed')
      : 0
  }

  async reportJoining(publicKey) {
    if (!this.hasRecipient) {
      return
    }
    try {
      const nodeIpInfo = ipInfo
      await http.post(`${this.config.recipient}/joining`, {
        publicKey,
        nodeIpInfo,
      })
    } catch (e) {
      if (logFlags.error) this.mainLogger.error(
        'reportJoining: ' + e.name + ': ' + e.message + ' at ' + e.stack
      )
      console.error(e)
    }
  }

  async reportJoined(nodeId, publicKey) {
    if (!this.hasRecipient) {
      return
    }
    try {
      const nodeIpInfo = ipInfo
      await http.post(`${this.config.recipient}/joined`, {
        publicKey,
        nodeId,
        nodeIpInfo,
      })
    } catch (e) {
      if (logFlags.error) this.mainLogger.error(
        'reportJoined: ' + e.name + ': ' + e.message + ' at ' + e.stack
      )
      console.error(e)
    }
  }

  async reportActive(nodeId) {
    if (!this.hasRecipient) {
      return
    }
    try {
      await http.post(`${this.config.recipient}/active`, { nodeId })
    } catch (e) {
      if (logFlags.error) this.mainLogger.error(
        'reportActive: ' + e.name + ': ' + e.message + ' at ' + e.stack
      )
      console.error(e)
    }
  }

  async reportSyncStatement(nodeId, syncStatement) {
    if (!this.hasRecipient) {
      return
    }
    try {
      await http.post(`${this.config.recipient}/sync-statement`, { nodeId, syncStatement })
    } catch (e) {
      if (logFlags.error) this.mainLogger.error(
        'reportSyncStatement: ' + e.name + ': ' + e.message + ' at ' + e.stack
      )
      console.error(e)
    }
  }

  async reportRemoved(nodeId) {
    if (!this.hasRecipient) {
      return
    }
    try {
      await http.post(`${this.config.recipient}/removed`, { nodeId })
    } catch (e) {
      if (logFlags.error) this.mainLogger.error(
        'reportRemoved: ' + e.name + ': ' + e.message + ' at ' + e.stack
      )
      console.error(e)
    }
    // Omar added this, since, just clearing the timer did not work
    //   it was still sending one more heartbeat after sending a removed
    this.hasRecipient = false
  }

  // Sends a report
  async _sendReport(data) {
    if (!this.hasRecipient) {
      return
    }
    const nodeId = Self.id
    if (!nodeId) throw new Error('No node ID available to the Reporter module.')
    const report = {
      nodeId,
      data,
    }
    try {
      await http.post(`${this.config.recipient}/heartbeat`, report)
    } catch (e) {
      if (logFlags.error) this.mainLogger.error(
        '_sendReport: ' + e.name + ': ' + e.message + ' at ' + e.stack
      )
      console.error(e)
    }
  }

  getReportInterval(): number {
    if (NodeList.activeByIdOrder.length >= 100) {
      return 10 * 1000
    } else {
      return this.config.interval * 1000
    }
  }

  checkIsNodeLost(nodeId) {
    const lostNodeIds = CycleChain.getNewest().lost
    if (lostNodeIds.length === 0) return false
    const foundId = lostNodeIds.find((lostId) => lostId === nodeId)
    if (foundId) return true
    return false
  }

  checkIsNodeRefuted(nodeId) {
    const refutedNodeIds = CycleChain.getNewest().refuted
    if (refutedNodeIds.length === 0) return false
    const foundId = refutedNodeIds.find((refutedId) => refutedId === nodeId)
    if (foundId) return true
    return false
  }

  async report() {
    /*
    Stop calling getAccountsStateHash() since this is not of use in a sharded network, also expensive to compute.
      let appState = this.stateManager
        ? await this.stateManager.transactionQueue.getAccountsStateHash()
        : allZeroes64
    */
    let appState = allZeroes64 // monititor server will set color based on partition report
    const cycleMarker = CycleChain.newest.previous || '' // [TODO] Replace with cycle creator
    const cycleCounter = CycleChain.newest.counter
    const nodelistHash = crypto.hash(NodeList.byJoinOrder)
    const desiredNodes = getDesiredCount()
    const lastScalingTypeRequested = requestedScalingType
    const lastScalingTypeWinner = lastScalingType
    const txInjected = this.statisticsReport.txInjected
    const txApplied = this.statisticsReport.txApplied
    const txRejected = this.statisticsReport.txRejected
    const txExpired = this.statisticsReport.txExpired
    const txProcessed = this.statisticsReport.txProcessed
    const reportInterval = this.getReportInterval()
    const nodeIpInfo = ipInfo

    let repairsStarted = 0
    let repairsFinished = 0
    // report only if we are active in te networks.
    // only knowingly report deltas.
    let partitionReport = null
    let globalSync = null
    if (this.stateManager != null) {

      //todo need to get rid of / no-op partition report.  It can't scale with # of accounts. (at least not without some advanements in how handle hashing)
      //A report using trie hashes would be smarter / more usefull as a replacement.
      // partitionReport = this.stateManager.partitionObjects.getPartitionReport(
      //   true,
      //   true
      // )
      globalSync = this.stateManager.isStateGood()

      repairsStarted = this.stateManager.dataRepairsStarted
      repairsFinished = this.stateManager.dataRepairsCompleted
      // Hack to code a green or red color for app state:
      appState = globalSync ? '00ff00ff' : 'ff0000ff'
    }

    let partitions = 0
    let partitionsCovered = 0
    if (this.stateManager != null) {
      /** @type {CycleShardData} */
      const shardData = this.stateManager.currentCycleShardData //   getShardDataForCycle(cycleCounter)
      if (shardData != null) {
        partitions = shardData.shardGlobals.numPartitions
        partitionsCovered =
          shardData.nodeShardData.storedPartitions.partitionsCovered
      }
    }

    // Server load
    const currentNetworkLoad = this.loadDetection.getCurrentLoad()
    const currentNodeLoad = this.loadDetection.getCurrentNodeLoad()
    const queueLength = this.statistics.getPreviousElement('queueLength')
    const txTimeInQueue =
      this.statistics.getPreviousElement('txTimeInQueue') / 1000 // ms to sec
    const isNodeLost = this.checkIsNodeLost(Self.id)
    const isNodeRefuted = this.checkIsNodeRefuted(Self.id)
    const isDataSynced = !this.stateManager.accountPatcher.failedLastTrieSync
    let rareCounters = {}
    // convert nested Map to nested Object
    for (const [key, value] of nestedCountersInstance.rareEventCounters) {
      rareCounters[key] = { ...value }
      rareCounters[key].subCounters = {}
      for (const [subKey, subValue] of value.subCounters) {
        rareCounters[key].subCounters[subKey] = subValue
      }
    }

    try {
      await this._sendReport({
        repairsStarted,
        repairsFinished,
        isDataSynced,
        appState,
        cycleMarker,
        cycleCounter,
        nodelistHash,
        desiredNodes,
        lastScalingTypeWinner, // "up" "down" or null.  last scaling action decided by this node
        lastScalingTypeRequested, // "up" "down" or null.  last scaling action decided by this node
        txInjected,
        txApplied,
        txRejected,
        txExpired,
        txProcessed,
        reportInterval,
        nodeIpInfo,
        partitionReport,
        globalSync,
        partitions,
        partitionsCovered,
        'currentLoad': {
          'networkLoad': currentNetworkLoad,
          'nodeLoad': currentNodeLoad
        },
        queueLength,
        txTimeInQueue,
        rareCounters,
        'isLost': isNodeLost,
        'isRefuted': isNodeRefuted,
        'shardusVersion': packageJson.version,
      })
    } catch (e) {
      if (logFlags.error) this.mainLogger.error(
        'startReporting: ' + e.name + ': ' + e.message + ' at ' + e.stack
      )
      console.error(e)
    }

    this.resetStatisticsReport()
    //this.consoleReport()

    this.reportTimer = setTimeout(() => {
      this.report()
    }, this.getReportInterval())
  }

  startReporting() {
    const self = this
    setInterval(() => {
      self.collectStatisticToReport()

      //temp mem debugging:
      this.mainLogger.info(memoryReportingInstance.getMemoryStringBasic() )

    }, 1000)
    // Creates and sends a report every `interval` seconds
    this.reportTimer = setTimeout(() => {
      this.report()
    }, this.getReportInterval())
  }

  consoleReport() {
    const time = Date.now()
    let delta = time - this.lastTime
    delta = delta * 0.001
    const txInjected = this.statistics
      ? this.statistics.getPreviousElement('txInjected')
      : 0
    const txApplied = this.statistics
      ? this.statistics.getPreviousElement('txApplied')
      : 0
    const report = `Perf inteval ${delta}    ${txInjected} Injected @${
      txInjected / delta
    } per second.    ${txApplied} Applied @${txApplied / delta} per second`
    this.lastTime = time

    if (logFlags.console) console.log(report)

    if (this.profiler) {
      //Note: turning this log on will make the perf endpoint math get reset
      //  one option would be to have a flag that gets set if anyone hits the perf endpoint
      //  if so, then just stop this logging.  for now i will leave this off.
//      if (logFlags.console) console.log(this.profiler.printAndClearReport(delta))
      if (logFlags.console) console.log(
        'Current load',
        'counter',
        CycleChain.newest.counter,
        this.loadDetection.getCurrentLoad()
      )
    }
  }

  stopReporting() {
    this.mainLogger.info('Stopping statistics reporting...')
    clearTimeout(this.reportTimer)
  }
}

export default Reporter
