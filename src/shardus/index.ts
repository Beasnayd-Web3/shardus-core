import { NodeStatus } from '@shardus/types/build/src/p2p/P2PTypes'
import { RemoveCertificate } from '@shardus/types/build/src/p2p/LostTypes'
import { EventEmitter } from 'events'
import { Handler } from 'express'
import Log4js from 'log4js'
import path from 'path'
import { inspect } from 'util'
import SHARDUS_CONFIG from '../config'
import Crypto from '../crypto'
import Debug, {
  getDevPublicKeys,
  getDevPublicKey,
  getDevPublicKeyMaxLevel,
  ensureKeySecurity,
} from '../debug'
import ExitHandler from '../exit-handler'
import LoadDetection from '../load-detection'
import Logger, { logFlags, LogFlags } from '../logger'
import * as Network from '../network'
import {
  isDebugModeMiddleware,
  isDebugModeMiddlewareHigh,
  isDebugModeMiddlewareLow,
  isDebugModeMiddlewareMedium,
} from '../network/debugMiddleware'
import { apoptosizeSelf, isApopMarkedNode } from '../p2p/Apoptosis'
import * as Archivers from '../p2p/Archivers'
import * as Context from '../p2p/Context'
import { config } from '../p2p/Context'
import * as AutoScaling from '../p2p/CycleAutoScale'
import * as CycleChain from '../p2p/CycleChain'
import * as CycleCreator from '../p2p/CycleCreator'
import { netConfig } from '../p2p/CycleCreator'
import * as GlobalAccounts from '../p2p/GlobalAccounts'
import { scheduleLostReport, removeNodeWithCertificiate } from '../p2p/Lost'
import { activeByIdOrder } from '../p2p/NodeList'
import * as Self from '../p2p/Self'
import * as Wrapper from '../p2p/Wrapper'
import RateLimiting from '../rate-limiting'
import Reporter from '../reporter'
import * as ShardusTypes from '../shardus/shardus-types'
import { WrappedData, DevSecurityLevel, AppObjEnum } from '../shardus/shardus-types'
import * as Snapshot from '../snapshot'
import StateManager from '../state-manager'
import { CachedAppData, QueueCountsResult } from '../state-manager/state-manager-types'
import { DebugComplete } from '../state-manager/TransactionQueue'
import Statistics from '../statistics'
import Storage from '../storage'
import { initAjvSchemas } from '../types/ajv/Helpers'
import * as utils from '../utils'
import { groupResolvePromises, inRangeOfCurrentTime, isValidShardusAddress, logNode } from '../utils'
import { getSocketReport } from '../utils/debugUtils'
import MemoryReporting from '../utils/memoryReporting'
import NestedCounters, { nestedCountersInstance } from '../utils/nestedCounters'
import Profiler, { profilerInstance } from '../utils/profiler'
import { startSaving } from './saveConsoleOutput'
import { isDebugMode, isServiceMode } from '../debug'
import * as JoinV2 from '../p2p/Join/v2'
import { getNetworkTimeOffset, shardusGetTime } from '../network'
import { JoinRequest } from '@shardus/types/build/src/p2p/JoinTypes'
import { networkMode, isInternalTxAllowed } from '../p2p/Modes'
import { lostArchiversMap } from '../p2p/LostArchivers/state'
import getCallstack from '../utils/getCallstack'
import * as crypto from '@shardus/crypto-utils'

// the following can be removed now since we are not using the old p2p code
//const P2P = require('../p2p')
const allZeroes64 = '0'.repeat(64)

const defaultConfigs: ShardusTypes.StrictShardusConfiguration = SHARDUS_CONFIG

Context.setDefaultConfigs(defaultConfigs)

type RouteHandlerRegister = (route: string, authHandler: Handler, responseHandler?: Handler) => void

//todo make this a config parameter set by the dapp
const changeListGlobalAccount = defaultConfigs.server.globalAccount

interface Shardus {
  io: SocketIO.Server
  profiler: Profiler
  nestedCounters: NestedCounters
  memoryReporting: MemoryReporting
  config: ShardusTypes.StrictServerConfiguration

  logger: Logger
  mainLogger: Log4js.Logger
  fatalLogger: Log4js.Logger
  appLogger: Log4js.Logger
  exitHandler: any
  storage: Storage
  crypto: Crypto
  network: Network.NetworkClass
  p2p: Wrapper.P2P
  debug: Debug
  appProvided: boolean
  app: ShardusTypes.App
  reporter: Reporter
  stateManager: StateManager
  statistics: Statistics
  loadDetection: LoadDetection
  rateLimiting: RateLimiting
  heartbeatInterval: number
  heartbeatTimer: NodeJS.Timeout
  registerExternalGet: RouteHandlerRegister
  registerExternalPost: RouteHandlerRegister
  registerExternalPut: RouteHandlerRegister
  registerExternalDelete: RouteHandlerRegister
  registerExternalPatch: RouteHandlerRegister
  _listeners: any
  appliedConfigChanges: Set<string>

  debugForeverLoopCounter: number
  debugForeverLoopsEnabled: boolean
}

/**
 * The main module that is used by the app developer to interact with the shardus api
 */
class Shardus extends EventEmitter {
  constructor(
    { server: config, logs: logsConfig, storage: storageConfig }: ShardusTypes.StrictShardusConfiguration,
    opts?: { customStringifier?: (val: any) => string }
  ) {
    super()
    this.debugForeverLoopsEnabled = true
    this.debugForeverLoopCounter = 0
    this.nestedCounters = nestedCountersInstance
    this.memoryReporting = new MemoryReporting(this)
    this.profiler = new Profiler()
    this.config = config
    Context.setConfig(this.config)
    logFlags.verbose = false

    let startInFatalsLogMode = config && config.debug && config.debug.startInFatalsLogMode ? true : false
    let startInErrorsLogMode = config && config.debug && config.debug.startInErrorLogMode ? true : false

    let dynamicLogMode = ''
    if (startInFatalsLogMode === true) {
      dynamicLogMode = 'fatal'
    } else if (startInErrorsLogMode === true) {
      dynamicLogMode = 'error'
    }

    initAjvSchemas()
    this.logger = new Logger(config.baseDir, logsConfig, dynamicLogMode)
    Context.setLoggerContext(this.logger)
    Snapshot.initLogger()

    const logDir = path.join(config.baseDir, logsConfig.dir)
    if (logsConfig.saveConsoleOutput) {
      startSaving(logDir)
    }

    this.mainLogger = this.logger.getLogger('main')
    this.fatalLogger = this.logger.getLogger('fatal')
    this.appLogger = this.logger.getLogger('app')
    this.exitHandler = new ExitHandler(logDir, this.memoryReporting, this.nestedCounters)
    this.storage = new Storage(config.baseDir, storageConfig, config, this.logger, this.profiler)
    Context.setStorageContext(this.storage)
    this.crypto = new Crypto(config.baseDir, this.config, this.logger, this.storage)
    Context.setCryptoContext(this.crypto)
    this.network = new Network.NetworkClass(config, this.logger, opts?.customStringifier)
    Context.setNetworkContext(this.network)

    // Set the old P2P to a Wrapper into the new P2P
    // [TODO] Remove this once everything calls p2p/* modules directly
    this.p2p = Wrapper.p2p
    Context.setP2pContext(this.p2p)

    this.debug = null
    this.appProvided = null
    this.app = null
    this.reporter = null
    this.stateManager = null
    this.statistics = null
    this.loadDetection = null
    this.rateLimiting = null

    this.appliedConfigChanges = new Set()

    if (logFlags.info) {
      this.mainLogger.info(`Server started with pid: ${process.pid}`)
      this.mainLogger.info('===== Server config: =====')
      this.mainLogger.info(JSON.stringify(config, null, 2))
    }

    // error log and console log on unacceptable minNodesToAllowTxs value
    // if (this.config.p2p.minNodesToAllowTxs < 20) {
    //   const minNodesToAllowTxs = this.config.p2p.minNodesToAllowTxs
    //   // debug mode and detected non-ideal value
    //   console.log(
    //     '[X] Minimum node required to allow transaction is set to a number less than 20 which is not ideal and secure for production'
    //   )
    //   if (this.config.mode === 'debug' && logFlags.error) {
    //     this.mainLogger.error(
    //       `Unacceptable \`minNodesToAllowTxs\` value detected: ${minNodesToAllowTxs} (< 20)`
    //     )
    //   }
    //   // production mode and detected non-ideal value
    //   else if (this.config.mode !== 'debug' && logFlags.error) {
    //     this.mainLogger.error(
    //       `Unacceptable \`minNodesToAllowTxs\` value detected: ${minNodesToAllowTxs} (< 20)`
    //     )
    //   }
    //   // for now they'd have the same error log
    //   // this is not as error per technical definition rather logical error
    // }

    this._listeners = {}

    this.heartbeatInterval = config.heartbeatInterval
    this.heartbeatTimer = null

    // alias the network register calls so that an app can get to them
    this.registerExternalGet = (route, authHandler, handler) =>
      this.network.registerExternalGet(route, authHandler, handler)
    this.registerExternalPost = (route, authHandler, handler) =>
      this.network.registerExternalPost(route, authHandler, handler)
    this.registerExternalPut = (route, authHandler, handler) =>
      this.network.registerExternalPut(route, authHandler, handler)
    this.registerExternalDelete = (route, authHandler, handler) =>
      this.network.registerExternalDelete(route, authHandler, handler)
    this.registerExternalPatch = (route, authHandler, handler) =>
      this.network.registerExternalPatch(route, authHandler, handler)

    this.exitHandler.addSigListeners()
    this.exitHandler.registerSync('reporter', () => {
      if (this.reporter) {
        this.mainLogger.info('Stopping reporter...')
        this.reporter.stopReporting()
      }
    })
    this.exitHandler.registerAsync('application', async () => {
      if (this.app && this.app.close) {
        this.mainLogger.info('Shutting down the application...')
        await this.app.close() // this needs to be awaited since it is async
      }
    })
    this.exitHandler.registerSync('crypto', () => {
      this.mainLogger.info('Stopping POW generators...')
      this.crypto.stopAllGenerators()
    })
    this.exitHandler.registerSync('cycleCreator', () => {
      // [TODO] - need to make an exitHandler for P2P; otherwise CycleCreator is continuing even after rest of the system cleans up and is ready to exit
      this.mainLogger.info('Shutting down p2p...')
      this.p2p.shutdown()
    })
    this.exitHandler.registerAsync('network', async () => {
      this.mainLogger.info('Shutting down networking...')
      await this.network.shutdown() // this is taking a long time
    })
    this.exitHandler.registerAsync('storage', async () => {
      this.mainLogger.info('Closing Database connections...')
      await this.storage.close()
    })
    this.exitHandler.registerAsync('unjoin', async () => {
      if (networkMode !== 'shutdown') {
        this.mainLogger.info('Submitting unjoin request...')
        await JoinV2.shutdown()
      }
    })
    /* moved stopping the application to earlier
    this.exitHandler.registerAsync('application', async () => {
      if (this.app && this.app.close) {
        this.mainLogger.info('Shutting down the application...')
        await this.app.close()  // this needs to be awaited since it is async
      }
    })
    */
    this.exitHandler.registerAsync('logger', async () => {
      this.mainLogger.info('Shutting down logs...')
      await this.logger.shutdown()
    })

    this.profiler.registerEndpoints()
    this.nestedCounters.registerEndpoints()
    this.memoryReporting.registerEndpoints()
    this.logger.registerEndpoints(Context)

    this.logger.playbackLogState('constructed', '', '')
  }

  /**
   * This function is what the app developer uses to setup all the SDK functions used by shardus
   * @typedef {import('./index').App} App
   */
  setup(app: ShardusTypes.App) {
    if (app === null) {
      this.appProvided = false
    } else if (app === Object(app)) {
      this.app = this._getApplicationInterface(app)
      this.appProvided = true
      this.logger.playbackLogState('appProvided', '', '')
    } else {
      throw new Error('Please provide an App object or null to Shardus.setup.')
    }
    return this
  }

  /**
   * Calling this function will start the network
   * @param {*} exitProcOnFail Exit the process if an error occurs
   */
  // async start_OLD (exitProcOnFail = true) {
  //   if (this.appProvided === null) throw new Error('Please call Shardus.setup with an App object or null before calling Shardus.start.')
  //   await this.storage.init()
  //   this._setupHeartbeat()
  //   this.crypto = new Crypto(this.config, this.logger, this.storage)
  //   Context.setCryptoContext(this.crypto)
  //   await this.crypto.init()

  //   const ipInfo = this.config.ip
  //   const p2pConf = Object.assign({ ipInfo }, this.config.p2p)
  //   this.p2p = new P2P(p2pConf, this.logger, this.storage, this.crypto)
  //   Context.setP2pContext(this.p2p)
  //   await this.p2p.init(this.network)
  //   this.debug = new Debug(this.config.baseDir, this.network)
  //   this.debug.addToArchive(this.logger.logDir, './logs')
  //   this.debug.addToArchive(path.parse(this.storage.storage.storageConfig.options.storage).dir, './db')

  //   this.statistics = new Statistics(this.config.baseDir, this.config.statistics, {
  //     counters: ['txInjected', 'txApplied', 'txRejected', 'txExpired', 'txProcessed'],
  //     watchers: {
  //       queueLength: () => this.stateManager ? this.stateManager.transactionQueue.newAcceptedTxQueue.length : 0,
  //       serverLoad: () => this.loadDetection ? this.loadDetection.getCurrentLoad() : 0
  //     },
  //     timers: ['txTimeInQueue']
  //   }, this)
  //   this.debug.addToArchive('./statistics.tsv', './statistics.tsv')

  //   this.loadDetection = new LoadDetection(this.config.loadDetection, this.statistics)
  //   this.statistics.on('snapshot', () => this.loadDetection.updateLoad())
  //   this.loadDetection.on('highLoad', async () => {
  //     await this.p2p.requestNetworkUpsize()
  //   })
  //   this.loadDetection.on('lowLoad', async () => {
  //     await this.p2p.requestNetworkDownsize()
  //   })

  //   this.rateLimiting = new RateLimiting(this.config.rateLimiting, this.loadDetection)

  //   this.consensus = new Consensus(this.app, this.config, this.logger, this.crypto, this.p2p, this.storage, this.profiler)

  //   if (this.app) {
  //     this._createAndLinkStateManager()
  //     this._attemptCreateAppliedListener()
  //   }

  //   this.reporter = this.config.reporting.report ? new Reporter(this.config.reporting, this.logger, this.p2p, this.statistics, this.stateManager, this.profiler, this.loadDetection) : null

  //   this._registerRoutes()

  //   this.p2p.on('joining', (publicKey) => {
  //     this.logger.playbackLogState('joining', '', publicKey)
  //     if (this.reporter) this.reporter.reportJoining(publicKey)
  //   })
  //   this.p2p.on('joined', (nodeId, publicKey) => {
  //     this.logger.playbackLogState('joined', nodeId, publicKey)
  //     this.logger.setPlaybackID(nodeId)
  //     if (this.reporter) this.reporter.reportJoined(nodeId, publicKey)
  //   })
  //   this.p2p.on('initialized', async () => {
  //     await this.syncAppData()
  //     this.p2p.goActive()
  //   })
  //   this.p2p.on('active', (nodeId) => {
  //     this.logger.playbackLogState('active', nodeId, '')
  //     if (this.reporter) {
  //       this.reporter.reportActive(nodeId)
  //       this.reporter.startReporting()
  //     }
  //     if (this.statistics) this.statistics.startSnapshots()
  //     this.emit('active', nodeId)
  //   })
  //   this.p2p.on('failed', () => {
  //     this.shutdown(exitProcOnFail)
  //   })
  //   this.p2p.on('error', (e) => {
  //     console.log(e.message + ' at ' + e.stack)
  //     this.mainLogger.debug('shardus.start() ' + e.message + ' at ' + e.stack)
  //     this.fatalLogger.fatal('shardus.start() ' + e.message + ' at ' + e.stack)
  //     throw new Error(e)
  //   })
  //   this.p2p.on('removed', async () => {
  //     if (this.statistics) {
  //       this.statistics.stopSnapshots()
  //       this.statistics.initialize()
  //     }
  //     if (this.reporter) {
  //       this.reporter.stopReporting()
  //       await this.reporter.reportRemoved(this.p2p.id)
  //     }
  //     if (this.app) {
  //       await this.app.deleteLocalAccountData()
  //       this._attemptRemoveAppliedListener()
  //       this._unlinkStateManager()
  //       await this.stateManager.cleanup()
  //       // Dont start a new state manager. pm2 will do a full restart if needed.
  //       // this._createAndLinkStateManager()
  //       // this._attemptCreateAppliedListener()
  //     }
  //     await this.p2p.restart()
  //   })

  //   Context.setShardusContext(this)

  //   await Self.init(this.config)
  //   await Self.startup()
  // }

  async start() {
    // Check network up & time synced
    await Network.init()

    const isInTimeLimit = await Network.checkAndUpdateTimeSyncedOffset(this.config.p2p.timeServers)

    if (isInTimeLimit === false) {
      this.mainLogger.error(`Time is not synced with the network`)
      //this is TBD
      // throw new Error(`Time is not synced with the network`)
    }

    if (!isServiceMode()) {
      // Setup storage
      await this.storage.init()
    }

    // Setup crypto
    await this.crypto.init()

    try {
      const sk: string = this.crypto.keypair.secretKey
      this.io = (await this.network.setup(Network.ipInfo, sk)) as SocketIO.Server
      Context.setIOContext(this.io)
      this.io.on('connection', (socket: any) => {
        if (!Self || !Self.isActive) {
          if (!Self.allowConnectionToFirstNode) {
            socket.disconnect()
            console.log(`This node is not active yet and kill the socket connection!`)
          }
        }
        if (this.config.features.archiverDataSubscriptionsUpdate) {
          console.log(`Archive server has subscribed to this node with socket id ${socket.id}!`)
          socket.on('ARCHIVER_PUBLIC_KEY', function (ARCHIVER_PUBLIC_KEY) {
            console.log('Archiver has registered its public key', ARCHIVER_PUBLIC_KEY)
            // Check if the archiver module is initialized; this is unlikely to happen because of the above Self.isActive check
            if (!Archivers.recipients || !Archivers.connectedSockets) {
              socket.disconnect()
              console.log(`Seems archiver module isn't initialized yet and kill the socket connection!`)
              return
            }
            if (Archivers.recipients.get(ARCHIVER_PUBLIC_KEY)) {
              if (Archivers.connectedSockets[ARCHIVER_PUBLIC_KEY]) {
                Archivers.removeArchiverConnection(ARCHIVER_PUBLIC_KEY)
              }
              Archivers.addArchiverConnection(ARCHIVER_PUBLIC_KEY, socket.id)
            } else {
              socket.disconnect()
              console.log(
                'Archiver is not found in the recipients list and kill the socket connection',
                ARCHIVER_PUBLIC_KEY
              )
            }
          })
          socket.on('UNSUBSCRIBE', function (ARCHIVER_PUBLIC_KEY) {
            console.log(`Archive server has with public key ${ARCHIVER_PUBLIC_KEY} request to unsubscribe`)
            Archivers.removeArchiverConnection(ARCHIVER_PUBLIC_KEY)
          })
        } else {
          console.log(`Archive server has subscribed to this node with socket id ${socket.id}!`)
          socket.on('ARCHIVER_PUBLIC_KEY', function (ARCHIVER_PUBLIC_KEY) {
            console.log('Archiver has registered its public key', ARCHIVER_PUBLIC_KEY)
            // Check if the archiver module is initialized; this is unlikely to happen because of the above Self.isActive check
            if (!Archivers.recipients || !Archivers.connectedSockets) {
              socket.disconnect()
              console.log(`Seems archiver module isn't initialized yet and kill the socket connection!`)
              return
            }
            for (const [key, value] of Object.entries(Archivers.connectedSockets)) {
              if (key === ARCHIVER_PUBLIC_KEY) {
                Archivers.removeArchiverConnection(ARCHIVER_PUBLIC_KEY)
              }
            }

            if (
              Object.keys(Archivers.connectedSockets).length >= config.p2p.maxArchiversSubscriptionPerNode
            ) {
              /* prettier-ignore */ console.log( `There are already ${config.p2p.maxArchiversSubscriptionPerNode} archivers connected for data transfer!` )
              socket.disconnect()
              return
            }
            Archivers.addArchiverConnection(ARCHIVER_PUBLIC_KEY, socket.id)
          })
          socket.on('UNSUBSCRIBE', function (ARCHIVER_PUBLIC_KEY) {
            console.log(`Archive server has with public key ${ARCHIVER_PUBLIC_KEY} request to unsubscribe`)
            Archivers.removeDataRecipient(ARCHIVER_PUBLIC_KEY)
            Archivers.removeArchiverConnection(ARCHIVER_PUBLIC_KEY)
          })
        }
      })
    } catch (e) {
      this.mainLogger.error('Socket connection break', e)
    }
    this.network.on('timeout', (node, requestId: string, context: string, route: string) => {
      const ipPort = `${node.internalIp}:${node.internalPort}`
      //this console log is probably redundant but are disabled most of the time anyhow.
      //They may help slighly in the case of adding some context to the out.log file when full debugging is on.
      /* prettier-ignore */ if (logFlags.p2pNonFatal) console.log(`In Shardus got network timeout-${context} for request ID - ${requestId} from node: ${utils.logNode(node)} ${ipPort}` )
      const result = isApopMarkedNode(node.id)
      if (result) {
        /* prettier-ignore */ nestedCountersInstance.countEvent('lostNodes', `timeout-apop-${context}-${route}`)
        return
      }
      if (!config.debug.disableLostNodeReports) scheduleLostReport(node, 'timeout', requestId)
      /** [TODO] Report lost */
      /* prettier-ignore */ if (logFlags.p2pNonFatal) nestedCountersInstance.countEvent('lostNodes', `timeout-${context}`)
      // context has been added to provide info on the type of timeout and where it happened
      /* prettier-ignore */ if (logFlags.p2pNonFatal) nestedCountersInstance.countRareEvent( 'lostNodes', `timeout-${context}  ${ipPort}` )
      if (this.network.statisticsInstance) this.network.statisticsInstance.incrementCounter('lostNodeTimeout')
    })
    this.network.on(
      'error',
      (node, requestId: string, context: string, errorGroup: string, route: string) => {
        const ipPort = `${node.internalIp}:${node.internalPort}`
        //this console log is probably redundant but are disabled most of the time anyhow.
        //They may help slighly in the case of adding some context to the out.log file when full debugging is on.
        /* prettier-ignore */ if (logFlags.p2pNonFatal) console.log(`In Shardus got network error-${context} for request ID ${requestId} from node: ${utils.logNode(node)} ${ipPort} error:${errorGroup}` )
        if (!config.debug.disableLostNodeReports) scheduleLostReport(node, 'error', requestId)
        /** [TODO] Report lost */
        /* prettier-ignore */ nestedCountersInstance.countEvent('lostNodes', `error-${context}-${route}`)
        /* prettier-ignore */ nestedCountersInstance.countRareEvent( 'lostNodes', `error-${context}  ${ipPort}` )
      }
    )

    // Setup other modules
    this.debug = new Debug(this.config.baseDir, this.network)
    this.debug.addToArchive(this.logger.logDir, './logs')
    this.debug.addToArchive(path.parse(this.storage.storage.storageConfig.options.storage).dir, './db')

    if (!isServiceMode()) {
      this.statistics = new Statistics(
        this.config.baseDir,
        this.config.statistics,
        {
          counters: [
            'txInjected',
            'txApplied',
            'txRejected',
            'txExpired',
            'txProcessed',
            'networkTimeout',
            'lostNodeTimeout',
          ],
          watchers: {
            queueLength: () =>
              this.stateManager ? this.stateManager.transactionQueue._transactionQueue.length : 0,
            executeQueueLength: () =>
              this.stateManager ? this.stateManager.transactionQueue.getExecuteQueueLength() : 0,
            serverLoad: () => (this.loadDetection ? this.loadDetection.getCurrentLoad() : 0),
          },
          timers: ['txTimeInQueue'],
          manualStats: ['netInternalDuty', 'netExternalDuty'],
          fifoStats: ['cpuPercent'],
          ringOverrides: {},
          fifoOverrides: { cpuPercent: 240 },
        },
        this
      )
    }
    this.debug.addToArchive('./statistics.tsv', './statistics.tsv')

    this.profiler.setStatisticsInstance(this.statistics)
    this.network.setStatisticsInstance(this.statistics)

    this.statistics

    this.loadDetection = new LoadDetection(this.config.loadDetection, this.statistics)
    this.loadDetection.on('highLoad', () => {
      // console.log(`High load detected Cycle ${currentCycle}, Quarter: ${currentQuarter}`)
      nestedCountersInstance.countEvent('loadRelated', 'highLoad')
      AutoScaling.requestNetworkUpsize()
    })
    this.loadDetection.on('lowLoad', () => {
      // console.log(`Low load detected Cycle ${currentCycle}, Quarter: ${currentQuarter}`)
      nestedCountersInstance.countEvent('loadRelated', 'lowLoad')
      AutoScaling.requestNetworkDownsize()
    })

    if (!isServiceMode()) this.statistics.on('snapshot', () => this.loadDetection.updateLoad())

    this.rateLimiting = new RateLimiting(this.config.rateLimiting, this.loadDetection)

    if (this.app) {
      this._createAndLinkStateManager()
      this._attemptCreateAppliedListener()

      let disableSnapshots = !!(
        this.config &&
        this.config.debug &&
        this.config.debug.disableSnapshots === true
      )
      if (disableSnapshots != true) {
        // Start state snapshotting once you go active with an app
        this.once('active', Snapshot.startSnapshotting)
      }
    }

    this.reporter =
      this.config.reporting.report && !isServiceMode()
        ? new Reporter(
            this.config.reporting,
            this.logger,
            this.statistics,
            this.stateManager,
            this.profiler,
            this.loadDetection
          )
        : null
    Context.setReporterContext(this.reporter)

    this._registerRoutes()

    // this.io.on('disconnect')

    // Register listeners for P2P events
    Self.emitter.on('witnessing', async (publicKey) => {
      this.logger.playbackLogState('witnessing', '', publicKey)
      await Snapshot.startWitnessMode()
    })
    Self.emitter.on('joining', (publicKey) => {
      // this.io.emit('DATA', `NODE JOINING ${publicKey}`)
      this.logger.playbackLogState('joining', '', publicKey)
      if (this.reporter) this.reporter.reportJoining(publicKey)
    })
    Self.emitter.on('joined', (nodeId, publicKey) => {
      // this.io.emit('DATA', `NODE JOINED ${nodeId}`)
      this.logger.playbackLogState('joined', nodeId, publicKey)
      this.logger.setPlaybackID(nodeId)
      if (this.reporter) this.reporter.reportJoined(nodeId, publicKey)
    })
    Self.emitter.on('initialized', async () => {
      // If network is in safety mode
      const newest = CycleChain.getNewest()
      if (newest && newest.safetyMode === true) {
        // Use snapshot to put old app data into state-manager then go active
        await Snapshot.safetySync()
      } else if (newest && (newest.mode === 'restart' || newest.mode === 'recovery')) {
        // Stay in syncing mode and let other nodes join
        Self.setp2pIgnoreJoinRequests(false)
        console.log('p2pIgnoreJoinRequests = false')
      } else {
        // not doing a safety sync
        // todo hook this up later cant deal with it now.
        // await this.storage.deleteOldDBPath()

        await this.syncAppData()
      }
    })
    Self.emitter.on('restore', async (cycleNumber: number) => {
      console.log('restore mode triggered on cycle', cycleNumber)
      this.logger.playbackLogState('restore', '', `Restore mode triggered on cycle ${cycleNumber}`)
      await this.stateManager.waitForShardCalcs()
      // Start restoring state data
      try {
        this.stateManager.renewState()
        await this.stateManager.accountSync.initialSyncMain(3)
        console.log('syncAppData - initialSyncMain finished')
      } catch (err) {
        console.log(utils.formatErrorMessage(err))
        apoptosizeSelf(`initialSyncMain-failed: ${err?.message}`)
        return
      }
      // After restoring state data, set syncing flags to true and go active
      await this.stateManager.startCatchUpQueue()
      console.log('syncAppData - startCatchUpQueue')
      await this.p2p.goActive()
      console.log('syncAppData - goActive')
      this.stateManager.appFinishedSyncing = true
      this.stateManager.startProcessingCycleSummaries()
    })
    Self.emitter.on('active', (nodeId) => {
      // this.io.emit('DATA', `NODE ACTIVE ${nodeId}`)
      this.logger.playbackLogState('active', nodeId, '')
      if (this.reporter) {
        this.reporter.reportActive(nodeId)
        this.reporter.startReporting()
      }
      if (this.statistics) this.statistics.startSnapshots()
      this.emit('active', nodeId)
    })
    Self.emitter.on('failed', () => {
      this.mainLogger.info('shutdown: on failed event')
      this.shutdown(true)
    })
    Self.emitter.on('error', (e) => {
      console.log(e.message + ' at ' + e.stack)
      if (logFlags.debug) this.mainLogger.debug('shardus.start() ' + e.message + ' at ' + e.stack)
      // normally fatal error keys should not be variable ut this seems like an ok exception for now
      this.shardus_fatal(
        `onError_ex` + e.message + ' at ' + e.stack,
        'shardus.start() ' + e.message + ' at ' + e.stack
      )
      throw new Error(e)
    })
    Self.emitter.on('removed', async () => {
      // Omar - Why are we trying to call the functions in modules directly before exiting.
      //        The modules have already registered shutdown functions with the exitHandler.
      //        We should let exitHandler handle the shutdown process.
      /*
      if (this.statistics) {
        this.statistics.stopSnapshots()
        this.statistics.initialize()
      }
      if (this.reporter) {
        this.reporter.stopReporting()
        await this.reporter.reportRemoved(Self.id)
      }
      if (this.app) {
        this.app.deleteLocalAccountData()
        this._attemptRemoveAppliedListener()
        this._unlinkStateManager()
        await this.stateManager.cleanup()
      }

      // Shutdown cleanly
      process.exit()
*/
      this.mainLogger.info(`exitCleanly: removed`)
      if (this.reporter) {
        this.reporter.stopReporting()
        await this.reporter.reportRemoved(Self.id)
      }
      this.exitHandler.exitCleanly(`removed`, `removed from network in normal conditions`) // exits with status 0 so that PM2 can restart the process
    })
    Self.emitter.on('app-removed', async () => {
      this.mainLogger.info(`exitCleanly: app removed`)
      if (this.reporter) {
        this.reporter.stopReporting()
        await this.reporter.reportRemoved(Self.id)
      }
      this.exitHandler.exitCleanly(`removed`, `removed from network requested by app`) // exits with status 0 so that
    })
    Self.emitter.on(
      'invoke-exit',
      async (tag: string, callstack: string, message: string, restart: boolean) => {
        // Omar - Why are we trying to call the functions in modules directly before exiting.
        //        The modules have already registered shutdown functions with the exitHandler.
        //        We should let exitHandler handle the shutdown process.
        /*
      this.fatalLogger.fatal('Shardus: caught apoptosized event; cleaning up')
      if (this.statistics) {
        this.statistics.stopSnapshots()
        this.statistics.initialize()
      }
      if (this.reporter) {
        this.reporter.stopReporting()
        await this.reporter.reportRemoved(Self.id)
      }
      if (this.app) {
        this.app.deleteLocalAccountData()
        this._attemptRemoveAppliedListener()
        this._unlinkStateManager()
        await this.stateManager.cleanup()
      }
      this.fatalLogger.fatal(
        'Shardus: caught apoptosized event; finished clean up'
      )
*/
        const exitType = restart ? 'exitCleanly' : 'exitUncleanly'
        nestedCountersInstance.countRareEvent('fatal', `invoke-exit: ${tag} ${exitType}`)
        this.mainLogger.error(`invoke-exit: ${tag} ${exitType}`)
        this.mainLogger.error(message)
        this.mainLogger.error(callstack)
        if (this.reporter) {
          this.reporter.stopReporting()
          await this.reporter.reportRemoved(Self.id)
        }
        if (restart)
          this.exitHandler.exitCleanly(
            `invoke-exit: ${tag}`,
            `invoke-exit: ${tag}. but exiting cleanly for a restart`
          )
        // exits with status 0 so that PM2 can restart the process
        else this.exitHandler.exitUncleanly(`invoke-exit: ${tag}`, `invoke-exit: ${tag} ${exitType}`) // exits with status 1 so that PM2 CANNOT restart the process
      }
    )
    Self.emitter.on('node-activated', ({ ...params }) => {
      try {
        this.app.eventNotify?.({ type: 'node-activated', ...params })
      } catch (e) {
        this.mainLogger.error(`Error: while processing node-activated event stack: ${e.stack}`)
      }
    })
    Self.emitter.on('node-deactivated', ({ ...params }) => {
      try {
        this.app.eventNotify?.({ type: 'node-deactivated', ...params })
      } catch (e) {
        this.mainLogger.error(`Error: while processing node-deactivated event stack: ${e.stack}`)
      }
    })
    Self.emitter.on('node-refuted', ({ ...params }) => {
      try {
        if (!this.stateManager.currentCycleShardData) throw new Error('No current cycle data')
        if (params.publicKey == null) throw new Error('No node publicKey provided for node-refuted event')
        const consensusNodes = this.getConsenusGroupForAccount(params.publicKey)
        for (let node of consensusNodes) {
          if (node.id === Self.id) {
            this.app.eventNotify?.({ type: 'node-refuted', ...params })
          }
        }
      } catch (e) {
        this.mainLogger.error(`Error: while processing node-refuted event stack: ${e.stack}`)
      }
    })
    Self.emitter.on('node-left-early', ({ ...params }) => {
      try {
        if (!this.stateManager.currentCycleShardData) throw new Error('No current cycle data')
        if (params.publicKey == null) throw new Error('No node publicKey provided for node-left-early event')
        const consensusNodes = this.getConsenusGroupForAccount(params.publicKey)
        for (let node of consensusNodes) {
          if (node.id === Self.id) {
            this.app.eventNotify?.({ type: 'node-left-early', ...params })
          }
        }
      } catch (e) {
        this.mainLogger.error(`Error: while processing node-left-early event stack: ${e.stack}`)
      }
    })
    Self.emitter.on('node-sync-timeout', ({ ...params }) => {
      try {
        if (!this.stateManager.currentCycleShardData) throw new Error('No current cycle data')
        if (params.publicKey == null)
          throw new Error('No node publicKey provided for node-sync-timeout event')
        const consensusNodes = this.getConsenusGroupForAccount(params.publicKey)
        for (let node of consensusNodes) {
          if (node.id === Self.id) {
            this.app.eventNotify?.({ type: 'node-sync-timeout', ...params })
            break
          }
        }
      } catch (e) {
        this.mainLogger.error(`Error: while processing node-sync-timeout event stack: ${e.stack}`)
      }
    })

    Context.setShardusContext(this)

    // Init new P2P
    Self.init()

    // Start P2P
    await Self.startupV2()

    // handle config queue changes and debug logic updates
    this._registerListener(this.p2p.state, 'cycle_q1_start', async () => {
      let lastCycle = CycleChain.getNewest()

      // need to make sure sync is finish or we may not have the global account
      // even worse, the dapp may not have initialized storage yet
      if (this.stateManager.appFinishedSyncing === true) {
        //query network account from the app for changes
        const account = await this.app.getNetworkAccount()

        this.updateConfigChangeQueue(account, lastCycle)
      }

      this.updateDebug(lastCycle)
    })

    //setup debug endpoints
    this.setupDebugEndpoints()
  }

  /**
   * Function used to register event listeners
   * @param {*} emitter Socket emitter to be called
   * @param {*} event Event name to be registered
   * @param {*} callback Callback function to be executed on event
   */
  _registerListener(emitter, event, callback) {
    if (this._listeners[event]) {
      this.shardus_fatal(
        `_registerListener_dupe`,
        'Shardus can only register one listener per event! EVENT: ',
        event
      )
      return
    }
    emitter.on(event, callback)
    this._listeners[event] = [emitter, callback]
  }

  /**
   * Function used to register event listeners
   * @param {*} event Name of the event to be unregistered
   */
  _unregisterListener(event) {
    if (!this._listeners[event]) {
      this.mainLogger.warn(`This event listener doesn't exist! Event: \`${event}\` in Shardus`)
      return
    }
    const entry = this._listeners[event]
    const [emitter, callback] = entry
    emitter.removeListener(event, callback)
    delete this._listeners[event]
  }

  /**
   * Function to unregister all event listeners
   */
  _cleanupListeners() {
    for (const event of Object.keys(this._listeners)) {
      this._unregisterListener(event)
    }
  }

  /**
   * Function used to register listeners for transaction related events
   */
  _attemptCreateAppliedListener() {
    if (!this.statistics || !this.stateManager) return
    this._registerListener(this.stateManager.eventEmitter, 'txQueued', (txId) =>
      this.statistics.startTimer('txTimeInQueue', txId)
    )
    this._registerListener(this.stateManager.eventEmitter, 'txPopped', (txId) =>
      this.statistics.stopTimer('txTimeInQueue', txId)
    )
    this._registerListener(this.stateManager.eventEmitter, 'txApplied', () =>
      this.statistics.incrementCounter('txApplied')
    )
    this._registerListener(this.stateManager.eventEmitter, 'txProcessed', () =>
      this.statistics.incrementCounter('txProcessed')
    )
  }

  /**
   * Function to unregister all transaction related events
   */
  _attemptRemoveAppliedListener() {
    if (!this.statistics || !this.stateManager) return
    this._unregisterListener('txQueued')
    this._unregisterListener('txPopped')
    this._unregisterListener('txApplied')
    this._unregisterListener('txProcessed')
  }

  /**
   * function to unregister listener for the "accepted" event
   */
  _unlinkStateManager() {
    this._unregisterListener('accepted')
  }

  /**
   * Creates an instance of the StateManager module and registers the "accepted" event listener for queueing transactions
   */
  _createAndLinkStateManager() {
    this.stateManager = new StateManager(
      this.profiler,
      this.app,
      this.logger,
      this.storage,
      this.p2p,
      this.crypto,
      this.config
    )

    this.storage.stateManager = this.stateManager
    Context.setStateManagerContext(this.stateManager)
  }

  /**
   * Function used to allow shardus to sync data specific to an app if it should be required
   */
  async syncAppData() {
    if (!this.app) {
      await this.p2p.goActive()
      if (this.stateManager) {
        this.stateManager.appFinishedSyncing = true
      }
      return
    }
    console.log('syncAppData')
    if (this.stateManager) {
      try {
        await this.stateManager.accountSync.initialSyncMain(3)
        console.log('syncAppData - initialSyncMain finished')
      } catch (err) {
        console.log(utils.formatErrorMessage(err))
        apoptosizeSelf(`initialSyncMain-failed: ${err?.message}`)
        return
      }
    }
    // if (this.stateManager) await this.stateManager.accountSync.syncStateDataFast(3) // fast mode
    if (this.p2p.isFirstSeed) {
      console.log('syncAppData - isFirstSeed')
      await this.p2p.goActive()
      console.log('syncAppData - goActive')
      await this.stateManager.waitForShardCalcs()
      await this.app.sync()
      console.log('syncAppData - sync')
      this.stateManager.appFinishedSyncing = true
      Self.setp2pIgnoreJoinRequests(false)
      console.log('p2pIgnoreJoinRequests = false')
    } else {
      await this.stateManager.startCatchUpQueue()
      console.log('syncAppData - startCatchUpQueue')
      await this.app.sync()
      console.log('syncAppData - sync')
      Self.setp2pIgnoreJoinRequests(false)
      console.log('p2pIgnoreJoinRequests = false')
      await this.p2p.goActive()
      console.log('syncAppData - goActive')
      this.stateManager.appFinishedSyncing = true
    }
    // Set network joinable to true
    this.p2p.setJoinRequestToggle(true)
    console.log('Server ready!')
    if (this.stateManager) {
      await utils.sleep(3000)
      // Original sync check
      // this.stateManager.enableSyncCheck()

      // Partition check and data repair (new)
      // disable and compare this.stateManager.startSyncPartitions()

      //this.stateManager.partitionObjects.startSyncPartitions()
      this.stateManager.startProcessingCycleSummaries()
    }
  }

  /**
   * Calls the "put" function with the "set" boolean parameter set to true
   * @param {*} tx The transaction data
   */
  set(tx: any) {
    return this.put(tx, true, false)
  }

  /**
   * Allows the application to log specific data to an app.log file
   * @param  {...any} data The data to be logged in app.log file
   */
  log(...data: any[]) {
    if (logFlags.debug) {
      this.appLogger.debug(new Date(), ...data)
    }
  }

  /**
   * Gets log flags.
   * use these for to cull out slow log lines with stringify
   * if you pass comma separated objects to dapp.log you do not need this.
   * Also good for controlling console logging
   */
  getLogFlags(): LogFlags {
    return logFlags
  }

  /**
   * Submits a transaction to the network
   * Returns an object that tells whether a tx was successful or not and the reason why via the
   * validateTxnFields application SDK function.
   * Throws an error if an application was not provided to shardus.
   *
   * {
   *   success: boolean,
   *   reason: string,
   *   staus: number
   * }
   *
   */
  async put(
    tx: ShardusTypes.OpaqueTransaction,
    set = false,
    global = false
  ): Promise<{ success: boolean; reason: string; status: number }> {
    const noConsensus = set || global

    // Check if Consensor is ready to receive txs before processing it further
    if (!this.appProvided)
      throw new Error('Please provide an App object to Shardus.setup before calling Shardus.put')
    if (logFlags.verbose)
      this.mainLogger.debug(`Start of injectTransaction ${JSON.stringify(tx)} set:${set} global:${global}`) // not reducing tx here so we can get the long hashes
    if (!this.stateManager.accountSync.dataSyncMainPhaseComplete) {
      this.statistics.incrementCounter('txRejected')
      nestedCountersInstance.countEvent('rejected', '!dataSyncMainPhaseComplete')
      return { success: false, reason: 'Node is still syncing.', status: 500 }
    }
    if (!this.stateManager.hasCycleShardData()) {
      this.statistics.incrementCounter('txRejected')
      nestedCountersInstance.countEvent('rejected', '!hasCycleShardData')
      return {
        success: false,
        reason: 'Not ready to accept transactions, shard calculations pending',
        status: 500,
      }
    }
    if (set === false) {
      if (!this.p2p.allowTransactions()) {
        if (global === true && this.p2p.allowSet()) {
          // This ok because we are initializing a global at the set time period
        } else {
          if (logFlags.verbose)
            this.mainLogger.debug(`txRejected ${JSON.stringify(tx)} set:${set} global:${global}`)

          this.statistics.incrementCounter('txRejected')
          nestedCountersInstance.countEvent('rejected', '!allowTransactions')
          return {
            success: false,
            reason: 'Network conditions to allow transactions are not met.',
            status: 500,
          }
        }
      }
    } else {
      if (!this.p2p.allowSet()) {
        this.statistics.incrementCounter('txRejected')
        nestedCountersInstance.countEvent('rejected', '!allowTransactions2')
        return {
          success: false,
          reason: 'Network conditions to allow app init via set',
          status: 500,
        }
      }
    }
    if (this.rateLimiting.isOverloaded()) {
      this.statistics.incrementCounter('txRejected')
      nestedCountersInstance.countEvent('rejected', 'isOverloaded')
      return { success: false, reason: 'Maximum load exceeded.', status: 500 }
    }

    try {
      // Perform basic validation of the transaction fields
      if (logFlags.verbose) this.mainLogger.debug('Performing initial validation of the transaction')

      let appData: any = {}

      const internalTx = this.app.isInternalTx(tx)
      if (internalTx && !isInternalTxAllowed()) {
        return {
          success: false,
          reason: `Internal transactions are not allowed in ${networkMode} Mode.`,
          status: 500,
        }
      }
      if (!internalTx && networkMode !== 'processing') {
        return {
          success: false,
          reason: `Application transactions are only allowed in processing Mode.`,
          status: 500,
        }
      }

      // Give the dapp an opportunity to do some up front work and generate
      // appData metadata for the applied TX
      const preCrackSuccess = await this.app.txPreCrackData(tx, appData)
      if (this.config.stateManager.checkPrecrackStatus === true && preCrackSuccess === false) {
        return {
          success: false,
          reason: `PreCrack has failed. Rejecting the tx.`,
          status: 500,
        }
      }

      const injectedTimestamp = this.app.getTimestampFromTransaction(tx, appData)

      const txId = this.app.calculateTxId(tx)
      let timestampReceipt: ShardusTypes.TimestampReceipt
      if (!injectedTimestamp || injectedTimestamp === -1) {
        if (injectedTimestamp === -1) {
          /* prettier-ignore */ if (logFlags.p2pNonFatal && logFlags.console) console.log('Dapp request to generate a new timestmap for the tx')
        }
        timestampReceipt = await this.stateManager.transactionConsensus.askTxnTimestampFromNode(tx, txId)
        /* prettier-ignore */ if (logFlags.p2pNonFatal && logFlags.console) console.log('Network generated a' +
          ' timestamp', txId, timestampReceipt)
      }
      if (!injectedTimestamp && !timestampReceipt) {
        this.shardus_fatal(
          'put_noTimestamp',
          `Transaction timestamp cannot be determined ${utils.stringifyReduce(tx)} `
        )
        this.statistics.incrementCounter('txRejected')
        nestedCountersInstance.countEvent('rejected', '_timestampNotDetermined')
        return {
          success: false,
          reason: 'Transaction timestamp cannot be determined.',
          status: 500,
        }
      }
      let timestampedTx
      if (timestampReceipt && timestampReceipt.timestamp) {
        timestampedTx = {
          tx,
          timestampReceipt,
        }
      } else {
        timestampedTx = { tx }
      }

      // Perform fast validation of the transaction fields
      const validateResult = this.app.validate(timestampedTx, appData)
      if (validateResult.success === false) {
        // 400 is a code for bad tx or client faulty
        validateResult.status = validateResult.status ? validateResult.status : 400
        return validateResult
      }

      // Ask App to crack open tx and return timestamp, id (hash), and keys
      const { timestamp, id, keys, shardusMemoryPatterns } = this.app.crack(timestampedTx, appData)
      // console.log('app.crack results', timestamp, id, keys)

      // Validate the transaction's sourceKeys & targetKeys
      if (this.config.debug.checkAddressFormat && !isValidShardusAddress(keys.allKeys)) {
        this.shardus_fatal(
          `put_invalidAddress`,
          `Invalid Shardus Address found: allKeys:${keys.allKeys} ${utils.stringifyReduce(tx)}`
        )
        this.statistics.incrementCounter('txRejected')
        nestedCountersInstance.countEvent('rejected', '_hasInvalidShardusAddresses')
        return { success: false, reason: 'Invalid Shardus Addresses', status: 400 }
      }
      // Validate the transaction timestamp
      let txExpireTimeMs = this.config.transactionExpireTime * 1000

      if (global) {
        txExpireTimeMs = 2 * 10 * 1000 //todo consider if this should be a config.
      }

      if (inRangeOfCurrentTime(timestamp, txExpireTimeMs, txExpireTimeMs) === false) {
        /* prettier-ignore */ this.shardus_fatal( `tx_outofrange`, `Transaction timestamp out of range: timestamp:${timestamp} now:${shardusGetTime()} diff(now-ts):${ shardusGetTime() - timestamp }  ${utils.stringifyReduce(tx)} our offset: ${getNetworkTimeOffset()} ` )
        this.statistics.incrementCounter('txRejected')
        nestedCountersInstance.countEvent('rejected', 'transaction timestamp out of range')
        return { success: false, reason: 'Transaction timestamp out of range', status: 400 }
      }

      this.profiler.profileSectionStart('put')

      //as ShardusMemoryPatternsInput
      // Pack into acceptedTx, and pass to StateManager
      const acceptedTX: ShardusTypes.AcceptedTx = {
        timestamp,
        txId: id,
        keys,
        data: timestampedTx,
        appData,
        shardusMemoryPatterns: shardusMemoryPatterns,
      }
      if (logFlags.verbose) this.mainLogger.debug('Transaction validated')
      if (global === false) {
        //temp way to make global modifying TXs not over count
        this.statistics.incrementCounter('txInjected')
      }
      this.logger.playbackLogNote(
        'tx_injected',
        `${txId}`,
        `Transaction: ${utils.stringifyReduce(timestampedTx)}`
      )
      this.stateManager.transactionQueue.routeAndQueueAcceptedTransaction(
        acceptedTX,
        /*send gossip*/ true,
        null,
        global,
        noConsensus
      )

      // Pass received txs to any subscribed 'DATA' receivers
      // this.io.emit('DATA', tx)
    } catch (err) {
      this.shardus_fatal(`put_ex_` + err.message, `Put: Failed to process transaction. Exception: ${err}`)
      this.fatalLogger.fatal('Put: ' + err.name + ': ' + err.message + ' at ' + err.stack)
      return {
        success: false,
        reason: `Failed to process transaction: ${utils.stringifyReduce(tx)} ${inspect(err)}`,
        status: 500, // 500 status code means transaction is generally failed
      }
    } finally {
      this.profiler.profileSectionEnd('put')
    }

    if (logFlags.verbose) {
      this.mainLogger.debug(`End of injectTransaction ${utils.stringifyReduce(tx)}`)
    }

    return {
      success: true,
      reason: 'Transaction queued, poll for results.',
      status: 200, // 200 status code means transaction is generally successful
    }
  }

  /**
   * Returns the nodeId for this node
   */
  getNodeId() {
    return this.p2p.getNodeId()
  }

  /**
   * Returns node info given a node id
   * @param {*} id The nodeId of this node
   */
  getNode(id: string): ShardusTypes.Node {
    return this.p2p.state.getNode(id)
  }

  getNodeByPubKey(id: string): ShardusTypes.Node {
    return this.p2p.state.getNodeByPubKey(id)
  }

  isNodeActiveByPubKey(pubKey: string): boolean {
    const node = this.p2p.state.getNodeByPubKey(pubKey)
    if (node == null) {
      return false
    }
    if (node.status !== NodeStatus.ACTIVE) {
      return false
    }
    return true
  }

  isNodeActive(id: string): boolean {
    const node = this.p2p.state.getNode(id)
    if (node == null) {
      return false
    }
    if (node.status !== NodeStatus.ACTIVE) {
      return false
    }
    return true
  }

  /**
   * Returns an array of cycles in the cycleChain history starting from the current cycle
   * @param {*} amount The number cycles to fetch from the recent cycle history
   */
  getLatestCycles(amount = 1) {
    return this.p2p.getLatestCycles(amount)
  }

  /**
   * This function return number of active in the latest cycle.
   */
  getNumActiveNodes() {
    let lastCycle = CycleChain.getNewest()
    if (lastCycle == null) {
      nestedCountersInstance.countEvent('debug', 'getNumActiveNodes lastCycle == null')
      return 0
    }
    nestedCountersInstance.countEvent('debug', `getNumActiveNodes lastCycle.active: ${lastCycle.active}`)

    const latestCycle = this.p2p.getLatestCycles(1)[0]

    if (latestCycle == null) {
      nestedCountersInstance.countEvent('debug', 'getNumActiveNodes latestCycle == null')
      return 0
    }
    nestedCountersInstance.countEvent('debug', `getNumActiveNodes latestCycle.active: ${latestCycle.active}`)

    return latestCycle ? latestCycle.active : 0
  }

  /**
   *
   * @returns {ShardusTypes.Cycle['mode']} returns the current network mode
   */
  getNetworkMode(): ShardusTypes.Cycle['mode'] {
    return networkMode
  }

  /**
   * @typedef {import('../shardus/index.js').Node} Node
   */
  /**
   * getClosestNodes finds the closes nodes to a certain hash value
   * @param {string} hash any hash address (256bit 64 characters)
   * @param {number} count how many nodes to return
   * @param {boolean} selfExclude
   * @returns {string[]} returns a list of nodes ids that are closest. roughly in order of closeness
   */
  getClosestNodes(hash: string, count: number = 1, selfExclude: boolean = false): string[] {
    return this.stateManager.getClosestNodes(hash, count, selfExclude).map((node) => node.id)
  }

  getClosestNodesGlobal(hash, count) {
    return this.stateManager.getClosestNodesGlobal(hash, count)
  }

  removeNodeWithCertificiate(cert: RemoveCertificate) {
    return removeNodeWithCertificiate(cert)
  }

  computeNodeRank(nodeId: string, txId: string, timestamp: number): bigint {
    return this.stateManager.transactionQueue.computeNodeRank(nodeId, txId, timestamp)
  }

  getShardusProfiler() {
    return profilerInstance
  }

  /** Get the time in MS a replacement for Date.Now().  If p2p.useNTPOffsets===true then adds the NPT offset  */
  shardusGetTime(): number {
    return shardusGetTime()
  }

  setDebugSetLastAppAwait(label: string, complete = DebugComplete.Incomplete) {
    this.stateManager?.transactionQueue.setDebugSetLastAppAwait(label, complete)
  }

  validateActiveNodeSignatures(
    signedAppData: any,
    signs: ShardusTypes.Sign[],
    minRequired: number
  ): { success: boolean; reason: string } {
    let validNodeCount = 0
    // let validNodes = []
    let appData = { ...signedAppData }
    if (appData.signs) delete appData.signs
    if (appData.sign) delete appData.sign
    for (let i = 0; i < signs.length; i++) {
      const sign = signs[i]
      const nodePublicKey = sign.owner
      appData.sign = sign // attach the node's sig for verification
      const node = this.p2p.state.getNodeByPubKey(nodePublicKey)
      const isValid = this.crypto.verify(appData, nodePublicKey)
      if (node && isValid) {
        validNodeCount++
      }
      // early break loop
      if (validNodeCount >= minRequired) {
        // if (validNodes.length >= minRequired) {
        return {
          success: true,
          reason: `Validated by ${minRequired} valid nodes!`,
        }
      }
    }
    return {
      success: false,
      reason: `Fail to verify enough valid nodes signatures`,
    }
  }

  validateClosestActiveNodeSignatures(
    signedAppData: any,
    signs: ShardusTypes.Sign[],
    minRequired: number,
    nodesToSign: number,
    allowedBackupNodes: number
  ): { success: boolean; reason: string } {
    let validNodeCount = 0
    // let validNodes = []
    let appData = { ...signedAppData }
    if (appData.signs) delete appData.signs
    if (appData.sign) delete appData.sign
    const hash = crypto.hashObj(appData)
    const closestNodes = this.getClosestNodes(hash, nodesToSign + allowedBackupNodes)
    const closestNodesByPubKey = new Map()
    for (let i = 0; i < closestNodes.length; i++) {
      const node = this.p2p.state.getNode(closestNodes[i])
      if (node) {
        closestNodesByPubKey.set(node.publicKey, node)
      }
    }
    for (let i = 0; i < signs.length; i++) {
      const sign = signs[i]
      const nodePublicKey = sign.owner
      appData.sign = sign // attach the node's sig for verification
      if (!closestNodesByPubKey.has(nodePublicKey)) {
        this.mainLogger.warn(`Node ${nodePublicKey} is not in the closest nodes list. Skipping`)
        continue
      }
      const node = closestNodesByPubKey.get(nodePublicKey)
      const isValid = this.crypto.verify(appData, nodePublicKey)
      if (node && isValid) {
        validNodeCount++
      }
      // early break loop
      if (validNodeCount >= minRequired) {
        // if (validNodes.length >= minRequired) {
        return {
          success: true,
          reason: `Validated by ${minRequired} valid nodes!`,
        }
      }
    }
    return {
      success: false,
      reason: `Fail to verify enough valid nodes signatures`,
    }
  }

  /**
   * isNodeInDistance
   * @param {string} hash any hash address (256bit 64 characters)
   * @param {string} nodeId id of a node
   * @param {number} distance how far away can this node be to the home node of the hash
   * @returns {boolean} is the node in the distance to the target
   */
  isNodeInDistance(hash: string, nodeId: string, distance: number) {
    //@ts-ignore
    return this.stateManager.isNodeInDistance(hash, nodeId, distance)
  }

  // USED BY SIMPLECOINAPP
  createApplyResponse(txId, txTimestamp) {
    const replyObject = {
      stateTableResults: [],
      txId,
      txTimestamp,
      accountData: [],
      accountWrites: [],
      appDefinedData: {},
      failed: false,
      failMessage: null,
      appReceiptData: null,
      appReceiptDataHash: null,
    }
    return replyObject
  }

  async shutdownFromDapp(tag: string, message: string, restart: boolean) {
    const exitType = restart ? 'exitCleanly' : 'exitUncleanly'
    nestedCountersInstance.countRareEvent('fatal', `invoke-exit: ${exitType}: ${tag}`)
    this.mainLogger.error(`invoke-exit: ${exitType}: ${tag}`)
    this.mainLogger.error(message)
    this.mainLogger.error(getCallstack())
    if (this.reporter) {
      this.reporter.stopReporting()
      await this.reporter.reportRemoved(Self.id)
    }
    if (restart)
      // exits with status 0 so that PM2 can restart the process
      this.exitHandler.exitCleanly(
        `invoke-exit: ${tag}`,
        `invoke-exit: ${tag}. but exiting cleanly for a restart`
      )
    // exits with status 1 so that PM2 CANNOT restart the process
    else this.exitHandler.exitUncleanly(`invoke-exit: ${tag}`, `invoke-exit: ${exitType}: ${tag}`)
  }

  applyResponseAddReceiptData(
    resultObject: ShardusTypes.ApplyResponse,
    appReceiptData: any,
    appReceiptDataHash: string
  ) {
    resultObject.appReceiptData = appReceiptData
    resultObject.appReceiptDataHash = appReceiptDataHash
  }

  applyResponseSetFailed(resultObject: ShardusTypes.ApplyResponse, failMessage: string) {
    resultObject.failed = true
    resultObject.failMessage = failMessage
  }

  // USED BY SIMPLECOINAPP
  applyResponseAddState(
    resultObject: ShardusTypes.ApplyResponse, //TODO define type! :{stateTableResults: ShardusTypes.StateTableObject[], accountData:ShardusTypes.WrappedResponse[] },
    accountData: any,
    localCache: any,
    accountId: string,
    txId: string,
    txTimestamp: number,
    stateBefore: string,
    stateAfter: string,
    accountCreated: boolean
  ) {
    const state = { accountId, txId, txTimestamp, stateBefore, stateAfter }
    if (accountCreated) {
      state.stateBefore = allZeroes64
    }
    //@ts-ignore
    resultObject.stateTableResults.push(state)
    let foundAccountData = resultObject.accountData.find((a) => a.accountId === accountId)
    if (foundAccountData) {
      foundAccountData = {
        ...foundAccountData,
        accountId,
        data: accountData,
        //@ts-ignore
        txId,
        timestamp: txTimestamp,
        hash: stateAfter,
        stateId: stateAfter, // duplicate of hash.., really need to go back and add types to this
        localCache,
      }
    } else {
      resultObject.accountData.push({
        accountId,
        data: accountData,
        //@ts-ignore
        txId,
        timestamp: txTimestamp,
        hash: stateAfter,
        stateId: stateAfter, // duplicate of hash.., really need to go back and add types to this
        localCache,
      })
    }
  }
  // USED BY SIMPLECOINAPP
  applyResponseAddChangedAccount(
    resultObject: ShardusTypes.ApplyResponse, //TODO define this type!
    accountId: string,
    account: ShardusTypes.WrappedResponse,
    txId: string,
    txTimestamp: number
  ) {
    resultObject.accountWrites.push({
      accountId,
      data: account,
      txId,
      timestamp: txTimestamp,
    })
  }

  useAccountWrites() {
    console.log('Using accountWrites only')
    this.stateManager.useAccountWritesOnly = true
  }

  tryInvolveAccount(txId: string, address: string, isRead: boolean): boolean {
    try {
      const result = this.stateManager.transactionQueue.tryInvloveAccount(txId, address, isRead)
      return result
    } catch (err) {
      this.fatalLogger.fatal(
        'Error while checking tryInvolveAccount ' + err.name + ': ' + err.message + ' at ' + err.stack
      )
      return false
    }
  }
  signAsNode(obj) {
    return this.crypto.sign(obj)
  }
  // USED BY SIMPLECOINAPP
  async resetAppRelatedState() {
    await this.storage.clearAppRelatedState()
  }

  // USED BY SIMPLECOINAPP
  async getLocalOrRemoteAccount(
    address,
    opts: {
      useRICache: boolean // enables the RI cache. enable only for immutable data
    } = { useRICache: false }
  ) {
    if (this.p2p.allowTransactions() || isServiceMode()) {
      return this.stateManager.getLocalOrRemoteAccount(address, opts)
    } else {
      return null
    }
  }

  async getLocalOrRemoteCachedAppData(topic, dataId): Promise<CachedAppData | null> {
    if (this.p2p.allowTransactions()) {
      return this.stateManager.cachedAppDataManager.getLocalOrRemoteCachedAppData(topic, dataId)
    } else {
      return null
    }
  }

  async getLocalOrRemoteAccountQueueCount(address): Promise<QueueCountsResult> {
    if (this.p2p.allowTransactions()) {
      return this.stateManager.getLocalOrRemoteAccountQueueCount(address)
    } else {
      return { count: 0, committingAppData: [] }
    }
  }

  async registerCacheTopic(topic: string, maxCycleAge: number, maxCacheElements: number) {
    try {
      return this.stateManager.cachedAppDataManager.registerTopic(topic, maxCycleAge, maxCacheElements)
    } catch (e) {
      this.mainLogger.error(`Error while registerCacheTopic`, e)
    }
  }

  async sendCorrespondingCachedAppData(
    topic: string,
    dataID: string,
    appData: any,
    cycle: number,
    fromId: string,
    txId: string
  ) {
    try {
      await this.stateManager.cachedAppDataManager.sendCorrespondingCachedAppData(
        topic,
        dataID,
        appData,
        cycle,
        fromId,
        txId
      )
    } catch (e) {
      this.mainLogger.error(`Error while sendCorrespondingCachedAppData`, e)
    }
  }

  /**
   * This function is used to query data from an account that is guaranteed to be in a remote shard
   * @param {*} address The address / publicKey of the account in which to query
   */
  async getRemoteAccount(address) {
    return this.stateManager.getRemoteAccount(address)
  }

  getConsenusGroupForAccount(address: string): ShardusTypes.Node[] {
    return this.stateManager.transactionQueue.getConsenusGroupForAccount(address)
  }

  getRandomConsensusNodeForAccount(address: string): ShardusTypes.Node {
    return this.stateManager.transactionQueue.getRandomConsensusNodeForAccount(address)
  }

  isAccountRemote(address: string): boolean {
    return this.stateManager.transactionQueue.isAccountRemote(address)
  }

  /**
   * test once at the given probability to fail.  If it fails, log the message and return true.  If it doesnt fail, return false.
   * @param failChance 0-1
   * @param debugName
   * @param key
   * @param message
   * @param verboseRequired
   * @returns
   */
  testFailChance(
    failChance: number,
    debugName: string,
    key: string,
    message: string,
    verboseRequired: boolean
  ): boolean {
    //MAIN-NET disable this.
    if (this.stateManager.testFailChance(failChance, debugName, key, message, verboseRequired)) {
      return true
    } else {
      return false
    }
  }

  async debugForeverLoop(tag: string) {
    this.debugForeverLoopCounter++
    /* prettier-ignore */ this.stateManager.transactionQueue.setDebugSetLastAppAwait('debugForeverLoop'+tag)
    while (this.debugForeverLoopsEnabled) {
      await utils.sleep(1000)
    }
    /* prettier-ignore */ this.stateManager.transactionQueue.setDebugSetLastAppAwait('debugForeverLoop'+tag, DebugComplete.Completed)
  }

  setupDebugEndpoints() {
    Context.network.registerExternalGet('debug-toggle-foreverloop', isDebugModeMiddleware, (req, res) => {
      this.debugForeverLoopsEnabled = !this.debugForeverLoopsEnabled
      //optionally check the query param set and use that instead
      if (req.query.set) {
        this.debugForeverLoopsEnabled = req.query.set === 'true'
      }
      res.json(`debugForeverLoopsEnabled: ${this.debugForeverLoopsEnabled}`)
    })
  }

  /**
   * Creates a wrapped response for formatting required by shardus
   * @param {*} accountId
   * @param {*} accountCreated
   * @param {*} hash
   * @param {*} timestamp
   * @param {*} fullData
   */
  createWrappedResponse(accountId, accountCreated, hash, timestamp, fullData) {
    // create and return the response object, it will default to full data.
    return {
      accountId,
      accountCreated,
      isPartial: false,
      stateId: hash,
      timestamp,
      data: fullData,
    }
  }

  /**
   * setPartialData
   * @param {Shardus.WrappedResponse} response
   * @param {any} partialData
   * @param {any} userTag
   */
  setPartialData(response, partialData, userTag) {
    // if the account was just created we have to do something special and ignore partial data
    if (response.accountCreated) {
      response.localCache = response.data
      return
    }
    response.isPartial = true
    // otherwise we will convert this response to be using partial data
    response.localCache = response.data
    response.data = partialData
    response.userTag = userTag
  }

  genericApplyPartialUpate(fullObject, updatedPartialObject) {
    const dataKeys = Object.keys(updatedPartialObject)
    for (const key of dataKeys) {
      fullObject[key] = updatedPartialObject[key]
    }
  }

  // ended up not using this yet:
  // async debugSetAccountState(wrappedResponse:ShardusTypes.WrappedResponse) {
  //   //set data. this will invoke the app to set data also
  //   await this.stateManager.checkAndSetAccountData([wrappedResponse], 'debugSetAccountState', false)
  // }

  /**
   * This is for a dapp to restore a bunch of account data in a debug situation.
   * This will call back into the dapp and instruct it to commit each account
   * This will also update shardus values.
   * There is a bug with re-updating the accounts copy db though.
   * @param accountCopies
   */
  async debugCommitAccountCopies(accountCopies: ShardusTypes.AccountsCopy[]) {
    await this.stateManager._commitAccountCopies(accountCopies)
  }

  async forwardAccounts(data: Archivers.InitialAccountsData) {
    await Archivers.forwardAccounts(data)
  }

  // Expose dev public key to verify things on the app
  getDevPublicKeys() {
    return getDevPublicKeys()
  }

  // Expose dev public key to verify things on the app
  getDevPublicKey(keyName?: string) {
    return getDevPublicKey(keyName)
  }

  // Expose dev key with highest security level
  getDevPublicKeyMaxLevel(clearance?: DevSecurityLevel) {
    return getDevPublicKeyMaxLevel(clearance)
  }

  // Verify that the key is the dev key and has the required security level
  ensureKeySecurity(keyName: string, clearance: DevSecurityLevel) {
    return ensureKeySecurity(keyName, clearance)
  }

  /**
   * Shutdown this node in the network
   * @param {boolean} exitProcess Exit the process when shutting down
   */
  async shutdown(exitProcess = true) {
    try {
      this.mainLogger.info('exitCleanly: shutdown')
      await this.exitHandler.exitCleanly(exitProcess)
      // consider if we want this.  it can help for debugging:
      // await this.exitHandler.exitUncleanly()
    } catch (e) {
      throw e
    }
  }

  /**
   * Grab the SDK interface provided by the application for shardus
   * @param {App} application
   * @returns {App}
   */
  _getApplicationInterface(application: ShardusTypes.App): ShardusTypes.App {
    if (logFlags.debug) this.mainLogger.debug('Start of _getApplicationInterfaces()')
    const applicationInterfaceImpl: Partial<ShardusTypes.App> = {}
    try {
      if (application == null) {
        // throw new Error('Invalid Application Instance')
        return null
      }
      if (typeof application.isInternalTx === 'function') {
        applicationInterfaceImpl.isInternalTx = (tx) => application.isInternalTx(tx)
      }

      if (typeof application.validate === 'function') {
        applicationInterfaceImpl.validate = (inTx, appData) => application.validate(inTx, appData)
      } else if (typeof application.validateTxnFields === 'function') {
        /**
         * Compatibility layer for Apps that use the old validateTxnFields fn
         * instead of the new validate fn
         */
        applicationInterfaceImpl.validate = (inTx, appData) => {
          const oldResult: ShardusTypes.IncomingTransactionResult = application.validateTxnFields(
            inTx,
            appData
          )
          const newResult = {
            success: oldResult.success,
            reason: oldResult.reason,
            status: oldResult.status,
          }
          return newResult
        }
      } else {
        throw new Error('Missing required interface function. validate()')
      }

      if (typeof application.crack === 'function') {
        applicationInterfaceImpl.crack = (inTx, appData) => application.crack(inTx, appData)
      } else if (
        typeof application.getKeyFromTransaction === 'function' &&
        typeof application.validateTxnFields === 'function'
      ) {
        /**
         * Compatibility layer for Apps that use the old getKeyFromTransaction
         * fn instead of the new crack fn
         */
        applicationInterfaceImpl.crack = (inTx) => {
          const oldGetKeyFromTransactionResult: ShardusTypes.TransactionKeys =
            application.getKeyFromTransaction(inTx)
          const oldValidateTxnFieldsResult: ShardusTypes.IncomingTransactionResult =
            application.validateTxnFields(inTx, null)
          const newResult = {
            timestamp: oldValidateTxnFieldsResult.txnTimestamp,
            id: this.crypto.hash(inTx), // [TODO] [URGENT] We really shouldn't be doing this and should change all apps to use the new way and do their own hash
            keys: oldGetKeyFromTransactionResult,
            shardusMemoryPatterns: null,
          }
          return newResult
        }
      } else {
        throw new Error('Missing required interface function. validate()')
      }

      if (typeof application.txPreCrackData === 'function') {
        applicationInterfaceImpl.txPreCrackData = async (tx, appData): Promise<boolean> => {
          this.profiler.scopedProfileSectionStart('process-dapp.txPreCrackData', false)
          let success = await application.txPreCrackData(tx, appData)
          this.profiler.scopedProfileSectionEnd('process-dapp.txPreCrackData')
          return success
        }
      } else {
        applicationInterfaceImpl.txPreCrackData = async function () {
          return true
        }
      }

      if (typeof application.getTimestampFromTransaction === 'function') {
        applicationInterfaceImpl.getTimestampFromTransaction = (inTx, appData) =>
          application.getTimestampFromTransaction(inTx, appData)
      } else {
        throw new Error('Missing requried interface function.getTimestampFromTransaction()')
      }

      if (typeof application.calculateTxId === 'function') {
        applicationInterfaceImpl.calculateTxId = (inTx) => application.calculateTxId(inTx)
      } else {
        throw new Error('Missing requried interface function.calculateTxId()')
      }

      if (typeof application.apply === 'function') {
        applicationInterfaceImpl.apply = (inTx, wrappedStates, appData) =>
          application.apply(inTx, wrappedStates, appData)
      } else {
        throw new Error('Missing required interface function. apply()')
      }

      if (typeof application.transactionReceiptPass === 'function') {
        applicationInterfaceImpl.transactionReceiptPass = async (tx, wrappedStates, applyResponse) =>
          application.transactionReceiptPass(tx, wrappedStates, applyResponse)
      } else {
        applicationInterfaceImpl.transactionReceiptPass = async function (tx, wrappedStates, applyResponse) {}
      }

      if (typeof application.transactionReceiptFail === 'function') {
        applicationInterfaceImpl.transactionReceiptFail = async (tx, wrappedStates, applyResponse) =>
          application.transactionReceiptFail(tx, wrappedStates, applyResponse)
      } else {
        applicationInterfaceImpl.transactionReceiptFail = async function (tx, wrappedStates, applyResponse) {}
      }

      if (typeof application.updateAccountFull === 'function') {
        applicationInterfaceImpl.updateAccountFull = async (wrappedStates, localCache, applyResponse) => {
          this.profiler.scopedProfileSectionStart('process-dapp.updateAccountFull', false)
          await application.updateAccountFull(wrappedStates, localCache, applyResponse)
          this.profiler.scopedProfileSectionEnd('process-dapp.updateAccountFull')
        }
      } else {
        throw new Error('Missing required interface function. updateAccountFull()')
      }

      if (typeof application.updateAccountPartial === 'function') {
        applicationInterfaceImpl.updateAccountPartial = async (wrappedStates, localCache, applyResponse) =>
          application.updateAccountPartial(wrappedStates, localCache, applyResponse)
      } else {
        throw new Error('Missing required interface function. updateAccountPartial()')
      }

      if (typeof application.getRelevantData === 'function') {
        applicationInterfaceImpl.getRelevantData = async (accountId, tx, appData: any) =>
          application.getRelevantData(accountId, tx, appData)
      } else {
        throw new Error('Missing required interface function. getRelevantData()')
      }

      if (typeof application.getStateId === 'function') {
        applicationInterfaceImpl.getStateId = async (accountAddress, mustExist) =>
          application.getStateId(accountAddress, mustExist)
      } else {
        if (logFlags.debug) this.mainLogger.debug('getStateId not used by global server')
      }

      if (typeof application.close === 'function') {
        applicationInterfaceImpl.close = async () => application.close()
      } else {
        throw new Error('Missing required interface function. close()')
      }

      // App.get_account_data (Acc_start, Acc_end, Max_records)
      // Provides the functionality defined for /get_accounts API
      // Max_records - limits the number of records returned
      if (typeof application.getAccountData === 'function') {
        applicationInterfaceImpl.getAccountData = async (accountStart, accountEnd, maxRecords) => {
          this.profiler.scopedProfileSectionStart('process-dapp.getAccountData', false)
          const res = await application.getAccountData(accountStart, accountEnd, maxRecords)
          this.profiler.scopedProfileSectionEnd('process-dapp.getAccountData')
          return res
        }
      } else {
        throw new Error('Missing required interface function. getAccountData()')
      }

      if (typeof application.getCachedRIAccountData === 'function') {
        applicationInterfaceImpl.getCachedRIAccountData = async (addressList: string[]) => {
          this.profiler.scopedProfileSectionStart('process-dapp.getCachedRIAccountData', false)
          const res = await application.getCachedRIAccountData(addressList)
          this.profiler.scopedProfileSectionEnd('process-dapp.getCachedRIAccountData')
          return res
        }
      } else {
        applicationInterfaceImpl.getCachedRIAccountData = async (addressList: string[]) => {
          return []
        }
      }

      if (typeof application.setCachedRIAccountData === 'function') {
        applicationInterfaceImpl.setCachedRIAccountData = async (accountRecords: any[]) => {
          this.profiler.scopedProfileSectionStart('process-dapp.setCachedRIAccountData', false)
          await application.setCachedRIAccountData(accountRecords)
          this.profiler.scopedProfileSectionEnd('process-dapp.setCachedRIAccountData')
        }
      } else {
        applicationInterfaceImpl.setCachedRIAccountData = async (accountRecords: any[]) => {}
      }

      if (typeof application.getAccountDataByRange === 'function') {
        applicationInterfaceImpl.getAccountDataByRange = async (
          accountStart,
          accountEnd,
          tsStart,
          tsEnd,
          maxRecords,
          offset,
          accountOffset
        ) => {
          this.profiler.scopedProfileSectionStart('process-dapp.getAccountDataByRange', false)
          const res = await application.getAccountDataByRange(
            accountStart,
            accountEnd,
            tsStart,
            tsEnd,
            maxRecords,
            offset,
            accountOffset
          )
          this.profiler.scopedProfileSectionEnd('process-dapp.getAccountDataByRange')
          return res
        }
      } else {
        throw new Error('Missing required interface function. getAccountDataByRange()')
      }

      if (typeof application.calculateAccountHash === 'function') {
        applicationInterfaceImpl.calculateAccountHash = (account) => application.calculateAccountHash(account)
      } else {
        throw new Error('Missing required interface function. calculateAccountHash()')
      }

      // App.set_account_data (Acc_records)
      // Acc_records - as provided by App.get_accounts
      // Stores the records into the Accounts table if the hash of the Acc_data matches State_id
      // Returns a list of failed Acc_id
      if (typeof application.setAccountData === 'function') {
        applicationInterfaceImpl.setAccountData = async (accountRecords) => {
          this.profiler.scopedProfileSectionStart('process-dapp.setAccountData', false)
          application.setAccountData(accountRecords)
          this.profiler.scopedProfileSectionEnd('process-dapp.setAccountData')
        }
      } else {
        throw new Error('Missing required interface function. setAccountData()')
      }

      // pass array of account ids to this and it will delete the accounts
      if (typeof application.deleteAccountData === 'function') {
        applicationInterfaceImpl.deleteAccountData = async (addressList) =>
          application.deleteAccountData(addressList)
      } else {
        throw new Error('Missing required interface function. deleteAccountData()')
      }

      if (typeof application.getAccountDataByList === 'function') {
        applicationInterfaceImpl.getAccountDataByList = async (addressList) => {
          this.profiler.scopedProfileSectionStart('process-dapp.getAccountDataByList', false)
          const accData = await application.getAccountDataByList(addressList)
          this.profiler.scopedProfileSectionEnd('process-dapp.getAccountDataByList')
          return accData
        }
      } else {
        throw new Error('Missing required interface function. getAccountDataByList()')
      }

      if (typeof application.getNetworkAccount === 'function') {
        applicationInterfaceImpl.getNetworkAccount = () => application.getNetworkAccount()
      } else {
        applicationInterfaceImpl.getNetworkAccount = () => null
      }

      if (typeof application.deleteLocalAccountData === 'function') {
        applicationInterfaceImpl.deleteLocalAccountData = async () => {
          this.profiler.scopedProfileSectionStart('process-dapp.deleteLocalAccountData', false)
          await application.deleteLocalAccountData()
          this.profiler.scopedProfileSectionEnd('process-dapp.deleteLocalAccountData')
        }
      } else {
        throw new Error('Missing required interface function. deleteLocalAccountData()')
      }
      if (typeof application.getAccountDebugValue === 'function') {
        applicationInterfaceImpl.getAccountDebugValue = (wrappedAccount) =>
          application.getAccountDebugValue(wrappedAccount)
      } else {
        applicationInterfaceImpl.getAccountDebugValue = (wrappedAccount) =>
          'getAccountDebugValue() missing on app'
      }

      //getSimpleTxDebugValue(tx)
      if (typeof application.getSimpleTxDebugValue === 'function') {
        applicationInterfaceImpl.getSimpleTxDebugValue = (tx) => application.getSimpleTxDebugValue(tx)
      } else {
        applicationInterfaceImpl.getSimpleTxDebugValue = (tx) => ''
      }

      if (typeof application.canDebugDropTx === 'function') {
        applicationInterfaceImpl.canDebugDropTx = (tx) => application.canDebugDropTx(tx)
      } else {
        applicationInterfaceImpl.canDebugDropTx = (tx) => true
      }

      if (typeof application.sync === 'function') {
        applicationInterfaceImpl.sync = async () => {
          this.profiler.scopedProfileSectionStart('process-dapp.sync', false)
          const res = await application.sync()
          this.profiler.scopedProfileSectionEnd('process-dapp.sync')
          return res
        }
      } else {
        const thisPtr = this
        applicationInterfaceImpl.sync = async function () {
          thisPtr.mainLogger.debug('no app.sync() function defined')
        }
      }

      if (typeof application.dataSummaryInit === 'function') {
        applicationInterfaceImpl.dataSummaryInit = async (blob, accountData) =>
          application.dataSummaryInit(blob, accountData)
      } else {
        applicationInterfaceImpl.dataSummaryInit = async function (blob, accountData) {}
      }
      if (typeof application.dataSummaryUpdate === 'function') {
        applicationInterfaceImpl.dataSummaryUpdate = async (blob, accountDataBefore, accountDataAfter) =>
          application.dataSummaryUpdate(blob, accountDataBefore, accountDataAfter)
      } else {
        applicationInterfaceImpl.dataSummaryUpdate = async function (
          blob,
          accountDataBefore,
          accountDataAfter
        ) {}
      }
      if (typeof application.txSummaryUpdate === 'function') {
        applicationInterfaceImpl.txSummaryUpdate = async (blob, tx, wrappedStates) =>
          application.txSummaryUpdate(blob, tx, wrappedStates)
      } else {
        applicationInterfaceImpl.txSummaryUpdate = async function (blob, tx, wrappedStates) {}
      }

      if (typeof application.getAccountTimestamp === 'function') {
        applicationInterfaceImpl.getAccountTimestamp = async (accountAddress, mustExist) =>
          application.getAccountTimestamp(accountAddress, mustExist)
      } else {
        applicationInterfaceImpl.getAccountTimestamp = async function (accountAddress, mustExist) {
          return 0
        }
      }

      if (typeof application.getTimestampAndHashFromAccount === 'function') {
        applicationInterfaceImpl.getTimestampAndHashFromAccount = (account) =>
          application.getTimestampAndHashFromAccount(account)
      } else {
        applicationInterfaceImpl.getTimestampAndHashFromAccount = function (account) {
          return {
            timestamp: 0,
            hash: 'getTimestampAndHashFromAccount not impl',
          }
        }
      }
      if (typeof application.validateJoinRequest === 'function') {
        applicationInterfaceImpl.validateJoinRequest = (data, mode, latestCycle, minNodes) =>
          application.validateJoinRequest(data, mode, latestCycle, minNodes)
      }
      if (typeof application.validateArchiverJoinRequest === 'function') {
        applicationInterfaceImpl.validateArchiverJoinRequest = (data) =>
          application.validateArchiverJoinRequest(data)
      }
      if (typeof application.getJoinData === 'function') {
        applicationInterfaceImpl.getJoinData = () => application.getJoinData()
      }
      if (typeof application.eventNotify === 'function') {
        applicationInterfaceImpl.eventNotify = application.eventNotify
      }
      if (typeof application.isReadyToJoin === 'function') {
        applicationInterfaceImpl.isReadyToJoin = async (latestCycle, publicKey, activeNodes, mode) =>
          application.isReadyToJoin(latestCycle, publicKey, activeNodes, mode)
      } else {
        // If the app doesn't provide isReadyToJoin, assume it is always ready to join
        applicationInterfaceImpl.isReadyToJoin = async (latestCycle, publicKey, activeNodes, mode) => true
      }
      if (typeof application.getNodeInfoAppData === 'function') {
        applicationInterfaceImpl.getNodeInfoAppData = () => application.getNodeInfoAppData()
      } else {
        // If the app doesn't provide getNodeInfoAppData, assume it returns empty obj
        applicationInterfaceImpl.getNodeInfoAppData = () => {}
      }
      if (typeof application.updateNetworkChangeQueue === 'function') {
        applicationInterfaceImpl.updateNetworkChangeQueue = async (
          account: ShardusTypes.WrappedData,
          appData: any
        ) => application.updateNetworkChangeQueue(account, appData)
      } else {
        // If the app doesn't provide updateNetworkChangeQueue, just return empty arr
        applicationInterfaceImpl.updateNetworkChangeQueue = async (account, appData) => []
      }
      if (typeof application.pruneNetworkChangeQueue === 'function') {
        applicationInterfaceImpl.pruneNetworkChangeQueue = async (
          account: ShardusTypes.WrappedData,
          appData: any
        ) => application.pruneNetworkChangeQueue(account, appData)
      }
      if (typeof application.pruneNetworkChangeQueue === 'function') {
        applicationInterfaceImpl.pruneNetworkChangeQueue = async (
          account: ShardusTypes.WrappedData,
          appData: any
        ) => application.pruneNetworkChangeQueue(account, appData)
      }
      if (typeof application.canStayOnStandby === 'function') {
        applicationInterfaceImpl.canStayOnStandby = (joinInfo: JoinRequest) =>
          application.canStayOnStandby(joinInfo)
      }

      if (typeof application.signAppData === 'function') {
        applicationInterfaceImpl.signAppData = async (
          type,
          hash,
          nodesToSign,
          appData
        ): Promise<ShardusTypes.SignAppDataResult> => {
          this.profiler.scopedProfileSectionStart('process-dapp.signAppData', false)
          const res = await application.signAppData(type, hash, nodesToSign, appData)
          this.profiler.scopedProfileSectionEnd('process-dapp.signAppData')
          return res
        }
      }
      if (typeof application.beforeStateAccountFilter === 'function') {
        applicationInterfaceImpl.beforeStateAccountFilter = application.beforeStateAccountFilter
      }
      if (typeof application.binarySerializeObject === 'function') {
        applicationInterfaceImpl.binarySerializeObject = (identifier: AppObjEnum, obj: any): Buffer => {
          this.profiler.scopedProfileSectionStart('process-dapp.binarySerializeObject', false)
          const res = application.binarySerializeObject(identifier, obj)
          this.profiler.scopedProfileSectionEnd('process-dapp.binarySerializeObject')
          return res
        }
      } else {
        console.log('binarySerializeObject not implemented')
        applicationInterfaceImpl.binarySerializeObject = (identifier: string, obj: any): Buffer => {
          return Buffer.from(utils.cryptoStringify(obj), 'utf8')
        }
      }
      if (typeof application.binaryDeserializeObject === 'function') {
        applicationInterfaceImpl.binaryDeserializeObject = (identifier: AppObjEnum, buffer: Buffer): any => {
          this.profiler.scopedProfileSectionStart('process-dapp.binaryDeserializeObject', false)
          const res = application.binaryDeserializeObject(identifier, buffer)
          this.profiler.scopedProfileSectionEnd('process-dapp.binaryDeserializeObject')
          return res
        }
      } else {
        console.log('binaryDeserializeObject not implemented')
        applicationInterfaceImpl.binaryDeserializeObject = (identifier: string, buffer: Buffer): any => {
          return JSON.parse(buffer.toString('utf8'))
        }
      }
    } catch (ex) {
      this.shardus_fatal(
        `getAppInterface_ex`,
        `Required application interface not implemented. Exception: ${ex}`
      )
      this.fatalLogger.fatal('_getApplicationInterface: ' + ex.name + ': ' + ex.message + ' at ' + ex.stack)
      throw new Error(ex)
    }
    if (logFlags.debug) this.mainLogger.debug('End of _getApplicationInterfaces()')

    // At this point, we have validated all the fields so a cast is appropriate
    return applicationInterfaceImpl as ShardusTypes.App
  }

  /**
   * Register the exit and config routes
   */
  _registerRoutes() {
    // DEBUG routes
    this.network.registerExternalPost('exit', isDebugModeMiddlewareHigh, async (req, res) => {
      res.json({ success: true })
      await this.shutdown()
    })
    // TODO elevate security beyond high when we get multi sig.  or is that too slow when needed?
    this.network.registerExternalPost('exit-apop', isDebugModeMiddlewareHigh, async (req, res) => {
      apoptosizeSelf('Apoptosis called at exit-apop route')
      res.json({ success: true })
    })

    this.network.registerExternalGet('config', isDebugModeMiddlewareLow, async (req, res) => {
      res.json({ config: this.config })
    })
    this.network.registerExternalGet('netconfig', async (req, res) => {
      res.json({ config: netConfig })
    })

    this.network.registerExternalGet('nodeInfo', async (req, res) => {
      let reportIntermediateStatus = req.query.reportIntermediateStatus === 'true'
      const nodeInfo = Self.getPublicNodeInfo(reportIntermediateStatus)
      const appData = this.app.getNodeInfoAppData()
      let result = { nodeInfo: { ...nodeInfo, appData } } as any
      if (isDebugMode() && req.query.debug === 'true') {
        result.debug = {
          queriedWhen: new Date().toISOString(),
          //Note we can't convert to shardusGetTime because process.uptime() uses Date.now() internally
          startedWhen: new Date(Date.now() - process.uptime() * 1000).toISOString(),
          uptimeMins: Math.round((100 * process.uptime()) / 60) / 100,
          pid: process.pid,
          currentQuarter: CycleCreator.currentQuarter,
          currentCycleMarker: CycleChain.getCurrentCycleMarker() ?? null,
          newestCycle: CycleChain.getNewest() ?? null,
          lostArchiversMap: lostArchiversMap,
        }
      }
      res.json(result)
    })

    this.network.registerExternalGet('joinInfo', isDebugModeMiddlewareMedium, async (req, res) => {
      const nodeInfo = Self.getPublicNodeInfo(true)
      let result = {
        respondedWhen: new Date().toISOString(),
        //Note we can't convert to shardusGetTime because process.uptime() uses Date.now() internally
        startedWhen: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        uptimeMins: Math.round((100 * process.uptime()) / 60) / 100,
        pid: process.pid,
        publicKey: nodeInfo.publicKey,
        id: nodeInfo.id,
        status: nodeInfo.status,
        currentQuarter: CycleCreator.currentQuarter,
        currentCycleMarker: CycleChain.getCurrentCycleMarker() ?? null,
        previousCycleMarker: CycleChain.getNewest()?.previous,
        getStandbyListHash: JoinV2.getStandbyListHash(),
        getLastHashedStandbyList: JoinV2.getLastHashedStandbyList(),
        getSortedStandbyNodeList: JoinV2.getSortedStandbyJoinRequests(),
      }
      res.json(deepReplace(result, undefined, '__undefined__'))
    })

    this.network.registerExternalGet('standby-list-debug', isDebugModeMiddlewareLow, async (req, res) => {
      let getSortedStandbyNodeList = JoinV2.getSortedStandbyJoinRequests()
      let result = getSortedStandbyNodeList.map((node) => ({
        pubKey: node.nodeInfo.publicKey,
        ip: node.nodeInfo.externalIp,
        port: node.nodeInfo.externalPort,
      }))
      res.json(result)
    })

    this.network.registerExternalGet('status-history', isDebugModeMiddlewareLow, async (req, res) => {
      let result = Self.getStatusHistoryCopy()
      res.json(deepReplace(result, undefined, '__undefined__'))
    })

    this.network.registerExternalGet('socketReport', isDebugModeMiddlewareLow, async (req, res) => {
      res.json(await getSocketReport())
    })
    this.network.registerExternalGet('forceCycleSync', isDebugModeMiddleware, async (req, res) => {
      let enable = req.query.enable === 'true' || false
      config.p2p.hackForceCycleSyncComplete = enable
      res.json(await getSocketReport())
    })

    this.p2p.registerInternal(
      'sign-app-data',
      async (
        payload: {
          type: string
          nodesToSign: string
          hash: string
          appData: any
        },
        respond: (arg0: any) => any
      ) => {
        const { type, nodesToSign, hash, appData } = payload
        const { success, signature } = await this.app.signAppData?.(type, hash, Number(nodesToSign), appData)

        await respond({ success, signature })
      }
    )

    // FOR internal testing. NEEDS to be removed for security purposes
    this.network.registerExternalPost('testGlobalAccountTX', isDebugModeMiddleware, async (req, res) => {
      try {
        this.mainLogger.debug(`testGlobalAccountTX: req:${utils.stringifyReduce(req.body)}`)
        const tx = req.body.tx
        this.put(tx, false, true)
        res.json({ success: true })
      } catch (ex) {
        this.mainLogger.debug('testGlobalAccountTX:' + ex.name + ': ' + ex.message + ' at ' + ex.stack)
        this.shardus_fatal(
          `registerExternalPost_ex`,
          'testGlobalAccountTX:' + ex.name + ': ' + ex.message + ' at ' + ex.stack
        )
      }
    })

    this.network.registerExternalPost('testGlobalAccountTXSet', isDebugModeMiddleware, async (req, res) => {
      try {
        this.mainLogger.debug(`testGlobalAccountTXSet: req:${utils.stringifyReduce(req.body)}`)
        const tx = req.body.tx
        this.put(tx, true, true)
        res.json({ success: true })
      } catch (ex) {
        this.mainLogger.debug('testGlobalAccountTXSet:' + ex.name + ': ' + ex.message + ' at ' + ex.stack)
        this.shardus_fatal(
          `registerExternalPost2_ex`,
          'testGlobalAccountTXSet:' + ex.name + ': ' + ex.message + ' at ' + ex.stack
        )
      }
    })
  }

  /**
   * Registers exception handlers for "uncaughtException" and "unhandledRejection"
   */
  registerExceptionHandler() {
    const logFatalAndExit = (err) => {
      console.log('Encountered a fatal error. Check fatal log for details.')
      this.shardus_fatal(
        `unhandledRejection_ex_` + err.stack.substring(0, 100),
        'unhandledRejection: ' + err.stack
      )
      // this.exitHandler.exitCleanly()

      // If the networks active node count is < some percentage of minNodes, don't exit on exceptions and log a counter instead
      if (config.p2p.continueOnException === true) {
        const activeNodes = activeByIdOrder
        const minNodesToExit = config.p2p.baselineNodes * config.p2p.minNodesPerctToAllowExitOnException
        if (activeNodes.length < minNodesToExit) {
          // Log a counter to say node is not going to apoptosize
          const msg = `Not enough active nodes to exit on exception. Active nodes: ${activeNodes.length}, minNodesToExit: ${minNodesToExit}, baselineNodes: ${config.p2p.baselineNodes}, minNodesPerctToAllowExitOnException: ${config.p2p.minNodesPerctToAllowExitOnException}`
          this.mainLogger.warn(msg)
          nestedCountersInstance.countEvent('continueOnException', msg)
          return
        }
      }

      this.mainLogger.info(`exitUncleanly: logFatalAndExit`)
      this.exitHandler.exitUncleanly('Unhandled Exception', err.message)
    }
    process.on('uncaughtException', (err) => {
      logFatalAndExit(err)
    })
    process.on('unhandledRejection', (err) => {
      logFatalAndExit(err)
    })
  }

  /**
   * Checks a transaction timestamp for expiration
   * deprecated
   * @param {number} timestamp
   */
  // _isTransactionTimestampExpired(timestamp) {
  //   // this.mainLogger.debug(`Start of _isTransactionTimestampExpired(${timestamp})`)
  //   let transactionExpired = false
  //   const txnExprationTime = this.config.transactionExpireTime
  //   const currNodeTimestamp = Date.now()

  //   const txnAge = currNodeTimestamp - timestamp
  //   if (logFlags.debug)
  //     this.mainLogger.debug(`Transaction Timestamp: ${timestamp} CurrNodeTimestamp: ${currNodeTimestamp}
  //   txnExprationTime: ${txnExprationTime}   TransactionAge: ${txnAge}`)

  //   // this.mainLogger.debug(`TransactionAge: ${txnAge}`)
  //   if (txnAge >= txnExprationTime * 1000) {
  //     this.fatalLogger.error('Transaction Expired')
  //     transactionExpired = true
  //   }
  //   // this.mainLogger.debug(`End of _isTransactionTimestampExpired(${timestamp})`)
  //   return transactionExpired
  // }

  async updateConfigChangeQueue(account: ShardusTypes.WrappedData, lastCycle: ShardusTypes.Cycle) {
    if (account == null || lastCycle == null) return

    // @ts-ignore // TODO where is listOfChanges coming from here? I don't think it should exist on data
    let changes = account.data.listOfChanges as {
      cycle: number
      change: any
      appData: any
    }[]
    if (!changes || !Array.isArray(changes)) {
      //this may get logged if we have a changeListGlobalAccount that does not have config settings on it.
      //The fix is to let the dapp set the global account to use for this
      // this.mainLogger.error(
      //   `Invalid changes in global account ${changeListGlobalAccount}`
      // )
      return
    }
    for (let change of changes) {
      //skip future changes
      if (change.cycle > lastCycle.counter) {
        continue
      }
      const changeHash = this.crypto.hash(change)
      //skip handled changes
      if (this.appliedConfigChanges.has(changeHash)) {
        continue
      }
      //apply this change
      this.appliedConfigChanges.add(changeHash)
      let changeObj = change.change
      let appData = change.appData

      // If there is initShutdown change, if the latest cycle is greater than the cycle of the change, then skip it
      if (changeObj['p2p'] && changeObj['p2p']['initShutdown'] && change.cycle !== lastCycle.counter) continue

      this.patchObject(this.config, changeObj, appData)

      const prunedData: WrappedData[] = await this.app.pruneNetworkChangeQueue(account, lastCycle.counter)
      await this.stateManager.checkAndSetAccountData(prunedData, 'global network account update', true)

      if (appData) {
        const data: WrappedData[] = await this.app.updateNetworkChangeQueue(account, appData)
        await this.stateManager.checkAndSetAccountData(data, 'global network account update', true)
      }

      this.p2p.configUpdated()
      this.loadDetection.configUpdated()
    }
  }

  patchObject(existingObject: any, changeObj: any, appData: any) {
    for (const [key, value] of Object.entries(changeObj)) {
      if (existingObject[key] != null) {
        if (typeof value === 'object') {
          this.patchObject(existingObject[key], value, appData)
        } else {
          existingObject[key] = value
          this.mainLogger.info(`patched ${key} to ${value}`)
          nestedCountersInstance.countEvent('config', `patched ${key} to ${value}`)
        }
      }
    }
  }

  /**
   * Do some periodic debug logic work
   * @param lastCycle
   */
  updateDebug(lastCycle: ShardusTypes.Cycle) {
    if (lastCycle == null) return
    let countEndpointStart = this.config?.debug?.countEndpointStart
    let countEndpointStop = this.config?.debug?.countEndpointStop

    if (countEndpointStart == null || countEndpointStart < 0) {
      return
    }

    //reset counters
    if (countEndpointStart === lastCycle.counter) {
      //nestedCountersInstance.resetCounters()
      //nestedCountersInstance.resetRareCounters()
      profilerInstance.clearScopedTimes()

      if (countEndpointStop === -1 || countEndpointStop <= countEndpointStart || countEndpointStop == null) {
        this.config.debug.countEndpointStop = countEndpointStart + 2
      }
    }

    if (countEndpointStop === lastCycle.counter && countEndpointStop != null) {
      //nestedCountersInstance.resetRareCounters()
      //convert a scoped report into rare counter report blob
      let scopedReport = profilerInstance.scopedTimesDataReport()
      scopedReport.cycle = lastCycle.counter
      scopedReport.node = `${Self.ip}:${Self.port}`
      scopedReport.id = utils.makeShortHash(Self.id)
      nestedCountersInstance.countRareEvent('scopedTimeReport', JSON.stringify(scopedReport))
    }
  }

  setGlobal(address, value, when, source) {
    GlobalAccounts.setGlobal(address, value, when, source)
  }

  getDebugModeMiddleware() {
    return isDebugModeMiddleware
  }
  getDebugModeMiddlewareLow() {
    return isDebugModeMiddlewareLow
  }
  getDebugModeMiddlewareMedium() {
    return isDebugModeMiddlewareMedium
  }
  getDebugModeMiddlewareHigh() {
    return isDebugModeMiddlewareHigh
  }

  shardus_fatal(key, log, log2 = null) {
    nestedCountersInstance.countEvent('fatal-log', key)

    if (log2 != null) {
      this.fatalLogger.fatal(log, log2)
    } else {
      this.fatalLogger.fatal(log)
    }
  }

  monitorEvent(category: string, name: string, count: number, message: string) {
    nestedCountersInstance.countEvent(category, name, count)

    if (logFlags.verbose) {
      this.mainLogger.info(`Event received with info: {
        eventCategory: ${category},
        eventName: ${name},
        eventMessage: ${count},
      }`)
    }

    this.statistics.countEvent(category, name, count, message)
  }

  async getAppDataSignatures(
    type: string,
    hash: string,
    nodesToSign: number,
    appData: any,
    allowedBackupNodes: number = 0
  ): Promise<ShardusTypes.GetAppDataSignaturesResult> {
    const closestNodesIds = this.getClosestNodes(hash, nodesToSign + allowedBackupNodes)

    const filterNodeIds = closestNodesIds.filter((id) => id !== Self.id)

    const closestNodes = filterNodeIds.map((nodeId) => this.p2p.state.getNode(nodeId))

    let responses = []
    if (filterNodeIds.length > 0) {
      const groupPromiseResp = await groupResolvePromises(
        closestNodes.map((node) => {
          return this.p2p.ask(node, 'sign-app-data', {
            type,
            hash,
            nodesToSign,
            appData,
          })
        }),
        (res) => {
          if (res.success) return true
          return false
        },
        allowedBackupNodes,
        Math.min(nodesToSign, filterNodeIds.length)
      )

      if (groupPromiseResp.success) responses = groupPromiseResp.wins
      else
        return {
          success: groupPromiseResp.success,
          signatures: [],
        }
    }

    if (closestNodesIds.includes(Self.id)) {
      const { success, signature } = await this.app.signAppData?.(type, hash, Number(nodesToSign), appData)
      /* prettier-ignore */ if (logFlags.p2pNonFatal && logFlags.console) console.log(success, signature)
      responses = [...responses, ...[{ success, signature }]]
    }

    const signatures = responses.map(({ signature }) => signature)
    if (logFlags.verbose) this.mainLogger.debug('Signatures for get signed app data request', signatures)

    return {
      success: true,
      signatures: signatures,
    }
  }

  isOnStandbyList(publicKey: string): boolean {
    return JoinV2.isOnStandbyList(publicKey)
  }
}

function deepReplace(obj: object | ArrayLike<any>, find: any, replace: any): any {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (obj[i] === find) {
        obj[i] = replace
      } else if (typeof obj[i] === 'object' && obj[i] !== null) {
        deepReplace(obj[i], find, replace)
      }
    }
  } else if (typeof obj === 'object' && obj !== null) {
    for (const key in obj) {
      if (obj[key] === find) {
        obj[key] = replace
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        deepReplace(obj[key], find, replace)
      }
    }
  }
  return obj
}

// tslint:disable-next-line: no-default-export
export default Shardus
export * as ShardusTypes from '../shardus/shardus-types'
