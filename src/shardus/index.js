const Logger = require('../logger')
const ExitHandler = require('../exit-handler')
const P2P = require('../p2p')
const Crypto = require('../crypto')
const Storage = require('../storage')
const Network = require('../network')
const utils = require('../utils')
const Consensus = require('../consensus')
const Reporter = require('../reporter')
const Debug = require('../debug')
const StateManager = require('../state-manager')
const Statistics = require('../statistics')
const LoadDetection = require('../load-detection')
const RateLimiting = require('../rate-limiting')
const Profiler = require('../utils/profiler.js')
const allZeroes64 = '0'.repeat(64)
const path = require('path')

class Shardus {
  constructor ({ server: config, logs: logsConfig, storage: storageConfig }) {
    this.profiler = new Profiler()
    this.config = config
    this.verboseLogs = false
    this.logger = new Logger(config.baseDir, logsConfig)
    this.mainLogger = this.logger.getLogger('main')
    this.fatalLogger = this.logger.getLogger('fatal')
    this.exitHandler = new ExitHandler()
    this.storage = new Storage(config.baseDir, storageConfig, this.logger, this.profiler)
    this.crypto = {}
    this.network = new Network(config.network, this.logger)
    this.p2p = {}
    this.debug = {}
    this.consensus = {}
    this.appProvided = null
    this.app = null
    this.reporter = null
    this.stateManager = null
    this.statistics = null
    this.loadDetection = null
    this.rateLimiting = null

    this._listeners = {}

    this.heartbeatInterval = config.heartbeatInterval
    this.heartbeatTimer = null

    if (this.mainLogger && ['TRACE'].includes(this.mainLogger.level.levelStr)) {
      this.verboseLogs = true
    }

    // alias the network register calls so that an app can get to them
    this.registerExternalGet = (route, handler) => this.network.registerExternalGet(route, handler)
    this.registerExternalPost = (route, handler) => this.network.registerExternalPost(route, handler)
    this.registerExternalPut = (route, handler) => this.network.registerExternalPut(route, handler)
    this.registerExternalDelete = (route, handler) => this.network.registerExternalDelete(route, handler)
    this.registerExternalPatch = (route, handler) => this.network.registerExternalPatch(route, handler)

    this.exitHandler.addSigListeners()
    this.exitHandler.registerSync('reporter', () => {
      if (this.reporter) {
        this.reporter.stopReporting()
      }
    })
    this.exitHandler.registerSync('p2p', () => {
      if (this.p2p) {
        this.p2p.cleanupSync()
      }
    })
    this.exitHandler.registerSync('shardus', () => {
      this._stopHeartbeat()
    })
    this.exitHandler.registerSync('crypto', () => {
      this.crypto.stopAllGenerators()
    })
    this.exitHandler.registerAsync('network', () => {
      this.mainLogger.info('Shutting down networking...')
      return this.network.shutdown()
    })
    this.exitHandler.registerAsync('shardus', () => {
      this.mainLogger.info('Writing heartbeat to database before exiting...')
      return this._writeHeartbeat()
    })
    this.exitHandler.registerAsync('storage', () => {
      return this.storage.close()
    })
    this.exitHandler.registerAsync('application', () => {
      this.mainLogger.info('Closing the application...')
      if (this.app && this.app.close) {
        return this.app.close()
      }
    })
    this.exitHandler.registerAsync('logger', () => {
      return this.logger.shutdown()
    })

    this.logger.playbackLogState('constructed', '', '')
  }

  setup (app) {
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

  async start (exitProcOnFail = true) {
    if (this.appProvided === null) throw new Error('Please call Shardus.setup with an App object or null before calling Shardus.start.')
    await this.storage.init()
    this._setupHeartbeat()
    this.crypto = new Crypto(this.config.crypto, this.logger, this.storage)
    await this.crypto.init()

    const ipInfo = this.config.ip
    const p2pConf = Object.assign({ ipInfo }, this.config.p2p)
    this.p2p = new P2P(p2pConf, this.logger, this.storage, this.crypto)
    await this.p2p.init(this.network)
    this.debug = new Debug(this.config.baseDir, this.network)
    this.debug.addFolder(this.logger.logDir, './logs')
    this.debug.addFolder(path.parse(this.storage.storage.storageConfig.options.storage).dir, './db')

    if (this.app) {
      this.statistics = new Statistics(this.config.baseDir, this.config.statistics, {
        counters: ['txInjected', 'txApplied', 'txRejected', 'txExpired'],
        watchers: {
          queueLength: () => this.stateManager ? this.stateManager.newAcceptedTXQueue.length : 0,
          serverLoad: () => this.loadDetection ? this.loadDetection.getCurrentLoad() : 0
        },
        timers: ['txTimeInQueue']
      }, this)
      this.debug.addFile('./statistics.tsv', './statistics.tsv')

      this.loadDetection = new LoadDetection(this.config.loadDetection, this.statistics)
      this.statistics.on('snapshot', () => this.loadDetection.updateLoad())
      this.loadDetection.on('highLoad', async () => {
        await this.p2p.requestNetworkUpsize()
      })
      this.loadDetection.on('lowLoad', async () => {
        await this.p2p.requestNetworkDownsize()
      })

      this.rateLimiting = new RateLimiting(this.config.rateLimiting, this.loadDetection)

      this.consensus = new Consensus(this.app, this.config, this.logger, this.crypto, this.p2p, this.storage, this.profiler)
      this._createAndLinkStateManager()
      this._attemptCreateAppliedListener()
    }

    this.reporter = this.config.reporting.report ? new Reporter(this.config.reporting, this.logger, this.p2p, this.statistics, this.stateManager, this.profiler) : null

    this._registerRoutes()

    this.p2p.on('joining', (publicKey) => {
      this.logger.playbackLogState('joining', '', publicKey)
      if (this.reporter) this.reporter.reportJoining(publicKey)
    })
    this.p2p.on('joined', (nodeId, publicKey) => {
      this.logger.playbackLogState('joined', nodeId, publicKey)
      this.logger.setPlaybackID(nodeId)
      if (this.reporter) this.reporter.reportJoined(nodeId, publicKey)
    })
    this.p2p.on('active', (nodeId) => {
      this.logger.playbackLogState('active', nodeId, '')
      if (this.reporter) {
        this.reporter.reportActive(nodeId)
        this.reporter.startReporting()
      }
      if (this.statistics) this.statistics.startSnapshots()
    })
    this.p2p.on('failed', () => {
      this.shutdown(exitProcOnFail)
    })
    this.p2p.on('error', (e) => {
      console.log(e.message + ' at ' + e.stack)
      this.mainLogger.debug('shardus.start() ' + e.message + ' at ' + e.stack)
      this.fatalLogger.fatal('shardus.start() ' + e.message + ' at ' + e.stack)
      throw new Error(e)
    })
    this.p2p.on('initialized', async () => {
      await this.syncAppData()
    })
    this.p2p.on('removed', async () => {
      if (this.statistics) {
        this.statistics.stopSnapshots()
        this.statistics.initialize()
      }
      if (this.reporter) {
        this.reporter.stopReporting()
        await this.reporter.reportRemoved(this.p2p.id)
      }
      if (this.app) {
        await this.app.deleteLocalAccountData()
        this._attemptRemoveAppliedListener()
        this._unlinkStateManager()
        await this.stateManager.cleanup()
        this._createAndLinkStateManager()
        this._attemptCreateAppliedListener()
      }
      await this.p2p.restart()
    })

    await this.p2p.startup()
  }

  _registerListener (emitter, event, callback) {
    if (this._listeners[event]) {
      this.mainLogger.fatal('Shardus can only register one listener per event!')
      return
    }
    emitter.on(event, callback)
    this._listeners[event] = [emitter, callback]
  }

  _unregisterListener (event) {
    if (!this._listeners[event]) {
      this.mainLogger.warn(`This event listener doesn't exist! Event: \`${event}\` in Shardus`)
      return
    }
    const entry = this._listeners[event]
    const [emitter, callback] = entry
    emitter.removeListener(event, callback)
    delete this._listeners[event]
  }

  _cleanupListeners () {
    for (const event of Object.keys(this._listeners)) {
      this._unregisterListener(event)
    }
  }

  _attemptCreateAppliedListener () {
    if (!this.statistics || !this.stateManager) return
    this._registerListener(this.stateManager, 'txQueued', txId => this.statistics.startTimer('txTimeInQueue', txId))
    this._registerListener(this.stateManager, 'txPopped', txId => this.statistics.stopTimer('txTimeInQueue', txId))
    this._registerListener(this.stateManager, 'txApplied', () => this.statistics.incrementCounter('txApplied'))
  }

  _attemptRemoveAppliedListener () {
    if (!this.statistics || !this.stateManager) return
    this._unregisterListener('txQueued')
    this._unregisterListener('txPopped')
    this._unregisterListener('txApplied')
  }

  _unlinkStateManager () {
    this._unregisterListener('accepted')
  }

  _createAndLinkStateManager () {
    this.stateManager = new StateManager(this.verboseLogs, this.profiler, this.app, this.consensus, this.logger, this.storage, this.p2p, this.crypto, this.config)
    this._registerListener(this.consensus, 'accepted', (...txArgs) => this.stateManager.queueAcceptedTransaction(...txArgs))
  }

  async syncAppData () {
    if (this.stateManager) await this.stateManager.syncStateData(3)

    await this.p2p.goActive()
    console.log('Server ready!')

    if (this.stateManager) {
      await utils.sleep(3000)
      this.stateManager.enableSyncCheck()
    }
  }

  /**
   * Handle incoming tranaction requests
   */
  put (req, res) {
    if (!this.appProvided) throw new Error('Please provide an App object to Shardus.setup before calling Shardus.put')

    if (!this.stateManager.dataSyncMainPhaseComplete) {
      return res.status(200).send({ success: false, reason: 'Node is still syncing.' })
    }

    if (this.verboseLogs) this.mainLogger.debug(`Start of injectTransaction ${JSON.stringify(req.body)}`) // not reducing tx here so we can get the long hashes

    if (this.rateLimiting.isOverloaded()) {
      this.statistics.incrementCounter('txRejected')
      return res.status(200).send({ success: false, reason: 'Maximum load exceeded.' })
    } else {
      res.status(200).send({ success: true, reason: 'Transaction queued, poll for results.' })
    }

    // retrieve incoming transaction from HTTP request
    let inTransaction = req.body
    let shardusTransaction = {}

    try {
      if (typeof inTransaction !== 'object') {
        return { success: false, reason: `Invalid Transaction! ${utils.stringifyReduce(inTransaction)}` }
      }
      /**
       * Perform basic validation of the transaction fields. Also, validate the transaction timestamp
       */
      if (this.verboseLogs) this.mainLogger.debug(`Performing initial validation of the transaction`)
      const initValidationResp = this.app.validateTxnFields(inTransaction)
      if (this.verboseLogs) this.mainLogger.debug(`InitialValidationResponse: ${utils.stringifyReduce(initValidationResp)}`)

      const timestamp = initValidationResp.txnTimestamp
      if (this._isTransactionTimestampExpired(timestamp)) {
        this.fatalLogger.fatal(`Transaction Expired: ${utils.stringifyReduce(inTransaction)}`)
        this.statistics.incrementCounter('txExpired')
        return { success: false, reason: 'Transaction Expired' }
      }

      /**
       * {txnReceivedTimestamp, sign, inTxn:{srcAct, tgtAct, tnxAmt, txnType, seqNum, timestamp, signs}}
       * Timestamping the transaction of when the transaction was received. Sign the complete transaction
       * with the node SK
       * ToDo: Check with Omar if validateTransaction () methods needs receivedTimestamp and Node Signature
       */
      shardusTransaction.receivedTimestamp = Date.now()
      shardusTransaction.inTransaction = inTransaction

      let txId = this.crypto.hash(inTransaction)

      this.profiler.profileSectionStart('put')

      if (this.verboseLogs) this.mainLogger.debug(`ShardusTransaction. shortTxID: ${txId} txID: ${utils.makeShortHash(txId)} TX data: ${utils.stringifyReduce(shardusTransaction)}`)

      shardusTransaction = this.crypto.sign(shardusTransaction)

      if (this.verboseLogs) this.mainLogger.debug('Transaction Valided')
      // Perform Consensus -- Currently no algorithm is being used
      // At this point the transaction is injected. Add a playback log
      this.logger.playbackLogNote('tx_injected', `${txId}`, `Transaction: ${utils.stringifyReduce(inTransaction)}`)
      this.statistics.incrementCounter('txInjected')
      this.profiler.profileSectionStart('consensusInject')
      this.consensus.inject(shardusTransaction).then(transactionReceipt => {
        this.profiler.profileSectionEnd('consensusInject')
        if (this.verboseLogs) this.mainLogger.debug(`Received Consensus. Receipt: ${utils.stringifyReduce(transactionReceipt)}`)
      })
    } catch (ex) {
      this.fatalLogger.fatal(`Put: Failed to process transaction. Exception: ${ex}`)
      this.fatalLogger.fatal('put: ' + ex.name + ': ' + ex.message + ' at ' + ex.stack)
      return { success: false, reason: `Failed to process trasnaction: ${utils.stringifyReduce(inTransaction)} ${ex}` }
    } finally {
      this.profiler.profileSectionEnd('put')
    }
    if (this.verboseLogs) this.mainLogger.debug(`End of injectTransaction ${utils.stringifyReduce(inTransaction)}`)
    return { success: true, reason: 'Transaction successfully processed' }
  }

  // USED BY SIMPLECOINAPP
  createApplyResponse (txId, txTimestamp) {
    let replyObject = { stateTableResults: [], txId, txTimestamp }
    return replyObject
  }

  // USED BY SIMPLECOINAPP
  applyResponseAddState (resultObject, accountId, txId, txTimestamp, stateBefore, stateAfter, accountCreated) {
    let state = { accountId, txId, txTimestamp, stateBefore, stateAfter }
    if (accountCreated) {
      state.stateBefore = allZeroes64
    }
    resultObject.stateTableResults.push(state)
  }

  // USED BY SIMPLECOINAPP
  async resetAppRelatedState () {
    await this.storage.clearAppRelatedState()
  }

  async shutdown (exitProcess = true) {
    try {
      await this.exitHandler.exitCleanly(exitProcess)
    } catch (e) {
      throw e
    }
  }

  /**
 * getApplicaitonInterface() method acts as an interface between Shardus core and Application
 * It validates the implementation of Shardus Application Interface
 * @param {Application} Application running on Shardus network
 * @returns {applicationInterfaceImpl} Shardus application interface implementation
 * @throws {Exception} If the interface is not appropriately implemented
 */
  _getApplicationInterface (application) {
    this.mainLogger.debug('Start of _getApplicationInterfaces()')
    let applicationInterfaceImpl = {}
    try {
      if (application == null) {
        // throw new Error('Invalid Application Instance')
        return null
      }

      // Required Methods:
      if (typeof (application.validateTransaction) === 'function') {
        applicationInterfaceImpl.validateTransaction = async (inTx) => application.validateTransaction(inTx)
      } else {
        throw new Error('Missing requried interface function. validateTransaction()')
      }

      if (typeof (application.validateTxnFields) === 'function') {
        applicationInterfaceImpl.validateTxnFields = (inTx) => application.validateTxnFields(inTx)
      } else {
        throw new Error('Missing requried interface function. validateTxnFields()')
      }

      if (typeof (application.apply) === 'function') {
        applicationInterfaceImpl.apply = async (inTx, receipt) => application.apply(inTx, receipt)
      } else {
        throw new Error('Missing requried interface function. apply()')
      }

      if (typeof (application.getKeyFromTransaction) === 'function') {
        applicationInterfaceImpl.getKeyFromTransaction = application.getKeyFromTransaction
      } else {
        throw new Error('Missing requried interface function. getKeysFromTransaction()')
      }

      if (typeof (application.getStateId) === 'function') {
        applicationInterfaceImpl.getStateId = async (accountAddress, mustExist) => application.getStateId(accountAddress, mustExist)
      } else {
        throw new Error('Missing requried interface function. getStateId()')
      }

      // opitonal methods
      if (typeof (application.close) === 'function') {
        applicationInterfaceImpl.close = async () => application.close()
      } else {
        // throw new Error('Missing requried interface function. apply()')
      }
      if (typeof (application.handleHttpRequest) === 'function') {
        applicationInterfaceImpl.handleHttpRequest = async (httpMethod, uri, req, res) => application.handleHttpRequest(httpMethod, uri, req, res)
      } else {
        // throw new Error('Missing requried interface function. apply()')
      }

      // TEMP endpoints for workaround. delete this later.
      if (typeof (application.onAccounts) === 'function') {
        applicationInterfaceImpl.onAccounts = async (req, res) => application.onAccounts(req, res)
      } else {
        // throw new Error('Missing requried interface function. apply()')
      }

      if (typeof (application.onGetAccount) === 'function') {
        applicationInterfaceImpl.onGetAccount = async (req, res) => application.onGetAccount(req, res)
      } else {
        // throw new Error('Missing requried interface function. apply()')
      }

      // App.get_account_data (Acc_start, Acc_end, Max_records)
      // Provides the functionality defined for /get_accounts API
      // Max_records - limits the number of records returned
      if (typeof (application.getAccountData) === 'function') {
        applicationInterfaceImpl.getAccountData = async (accountStart, accountEnd, maxRecords) => application.getAccountData(accountStart, accountEnd, maxRecords)
      } else {
        // throw new Error('Missing requried interface function. apply()')
      }

      if (typeof (application.getAccountData2) === 'function') {
        applicationInterfaceImpl.getAccountData2 = async (accountStart, accountEnd, tsStart, tsEnd, maxRecords) => application.getAccountData2(accountStart, accountEnd, tsStart, tsEnd, maxRecords)
      } else {
        // throw new Error('Missing requried interface function. apply()')
      }

      if (typeof (application.getAccountData3) === 'function') {
        applicationInterfaceImpl.getAccountData3 = async (accountStart, accountEnd, tsStart, maxRecords) => application.getAccountData3(accountStart, accountEnd, tsStart, maxRecords)
      } else {
        // throw new Error('Missing requried interface function. apply()')
      }

      // App.set_account_data (Acc_records)
      // Acc_records - as provided by App.get_accounts
      // Stores the records into the Accounts table if the hash of the Acc_data matches State_id
      // Returns a list of failed Acc_id
      if (typeof (application.setAccountData) === 'function') {
        applicationInterfaceImpl.setAccountData = async (accountRecords) => application.setAccountData(accountRecords)
      } else {
        // throw new Error('Missing requried interface function. apply()')
      }

      if (typeof (application.getAccountDataByList) === 'function') {
        applicationInterfaceImpl.getAccountDataByList = async (addressList) => application.getAccountDataByList(addressList)
      } else {
        // throw new Error('Missing requried interface function. apply()')
      }
      if (typeof (application.deleteLocalAccountData) === 'function') {
        applicationInterfaceImpl.deleteLocalAccountData = async () => application.deleteLocalAccountData()
      } else {
        // throw new Error('Missing requried interface function. apply()')
      }
    } catch (ex) {
      this.fatalLogger.fatal(`Required application interface not implemented. Exception: ${ex}`)
      this.fatalLogger.fatal('_getApplicationInterface: ' + ex.name + ': ' + ex.message + ' at ' + ex.stack)
      throw new Error(ex)
    }
    this.mainLogger.debug('End of _getApplicationInterfaces()')
    return applicationInterfaceImpl
  }

  _registerRoutes () {
    this.network.registerExternalPost('exit', async (req, res) => {
      res.json({ success: true })
      await this.shutdown()
    })
  }

  registerExceptionHandler () {
    process.on('uncaughtException', async (err) => {
      this.fatalLogger.fatal('uncaughtException: ' + err.name + ': ' + err.message + ' at ' + err.stack)
      try {
        await this.exitHandler.exitCleanly()
      } catch (e) {
        console.error('uncaughtException: ' + e.name + ': ' + e.message + ' at ' + e.stack)
        process.exit(1)
      }
    })
  }

  async _writeHeartbeat () {
    const timestamp = utils.getTime('s')
    await this.storage.setProperty('heartbeat', timestamp)
  }

  _setupHeartbeat () {
    this.heartbeatTimer = setInterval(async () => {
      await this._writeHeartbeat()
    }, this.heartbeatInterval * 1000)
  }

  _stopHeartbeat () {
    this.mainLogger.info('Stopping heartbeat...')
    clearInterval(this.heartbeatTimer)
  }

  _isTransactionTimestampExpired (timestamp) {
    // this.mainLogger.debug(`Start of _isTransactionTimestampExpired(${timestamp})`)
    let transactionExpired = false
    const txnExprationTime = this.config.transactionExpireTime
    const currNodeTimestamp = Date.now()

    const txnAge = currNodeTimestamp - timestamp
    this.mainLogger.debug(`Transaction Timestamp: ${timestamp} CurrNodeTimestamp: ${currNodeTimestamp}
    txnExprationTime: ${txnExprationTime}   TransactionAge: ${txnAge}`)

    // this.mainLogger.debug(`TransactionAge: ${txnAge}`)
    if (txnAge >= (txnExprationTime * 1000)) {
      this.fatalLogger.error(`Transaction Expired`)
      transactionExpired = true
    }
    // this.mainLogger.debug(`End of _isTransactionTimestampExpired(${timestamp})`)
    return transactionExpired
  }
}

module.exports = Shardus
