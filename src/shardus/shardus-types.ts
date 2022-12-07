import { P2P } from '@shardus/types'
export type Node = P2P.NodeListTypes.Node
export type Cycle = P2P.CycleCreatorTypes.CycleRecord
//import { RequestHandler } from "express"; //express was causing problems.

type RequestHandler = any

// Type definitions for Shardus
// Project: Shardus Enterprise Server
// Definitions by: Erik Xavier
// export class Shardus {
//   constructor(configs?: ShardusConfiguration)
//   /**
//    * Setups an application to run within the shardus enterprise server instance
//    * @param App The provided application
//    */
//   setup(App: App): Shardus
//   /**
//    * Starts the shardus enterprise server instace
//    * @param exitProcOnFail Sets if the process should terminate on any error
//    *
//    */
//   start(exitProcOnFail?: boolean): void
//   /**
//    * Register an external endpoint to shardus enterprise server
//    * https://shardus.gitlab.io/docs/developer/main-concepts/building-a-poc-app/shardus-app-interface/register-external-get.html
//    * @param route The route to register an external GET endpoint
//    * @param handler An express.js standard route handler function
//    */
//   registerExternalGet(route: string, handler: RequestHandler): void
//   /**.
//    * Register an external endpoint to shardus enterprise server.  version 2
//    * https://shardus.gitlab.io/docs/developer/main-concepts/building-a-poc-app/shardus-app-interface/register-external-get.html
//    * @param route The route to register an external POST endpoint
//    * @param handler An express.js standard route handler function
//    */

//   registerExternalPost(route: string, handler: RequestHandler): void
//   /**
//    * Register an external endpoint to shardus enterprise server
//    * @param route The route to register an external PUT endpoint
//    * @param handler An express.js standard route handler function
//    */

//   registerExternalPut(route: string, handler: RequestHandler): void
//   /**
//    * Register an external endpoint to shardus enterprise server
//    * @param route The route to register an external DELETE endpoint
//    * @param handler An express.js standard route handler function
//    */

//   registerExternalDelete(route: string, handler: RequestHandler): void
//   /**
//    * Register an external endpoint to shardus enterprise server
//    * @param route The route to register an external PATCH endpoint
//    * @param handler An express.js standard route handler function
//    */

//   registerExternalPatch(route: string, handler: RequestHandler): void
//   /**
//    * Register handler for caught exceptions on http requests
//    */
//   registerExceptionHandler(): void
//   /**
//    * Handle incoming transaction requests
//    *
//    * @param tx the transaction
//    * @param set?
//    */
//   put(tx: object, set?: boolean): IncomingTransactionResult
//   /**
//    * Handle incoming set requests
//    *
//    * @param tx the set tx
//    */
//   set(tx: object): IncomingTransactionResult
//   /**
//    * Logging for the application
//    * @param data The data you want the application to log
//    */
//   log(...data: any): void
//   /**
//    * A function that clears shardus App related State
//    */
//   resetAppRelatedState(): void
//   /**
//    * A function that executes a cleanup and terminates the server
//    * @param exitProcess Flag to define if process.exit() should be called or not. Default: true
//    */
//   shutdown(exitProcess?: boolean): void

//   /**
//    * Returns the application associated with the shardus module
//    * @param Application The configured application
//    */

//   _getApplicationInterface(Application: App): App

//   createApplyResponse(txId: string, txTimestamp: number): ApplyResponse

//   createWrappedResponse(
//     accountId: string,
//     accountCreated: boolean,
//     hash: string,
//     timestamp: number,
//     fullData: any
//   ): WrappedResponse

//   setPartialData(response: any, partialData: any, userTag: any): void

//   genericApplyPartialUpate(
//     fullAccountData: any,
//     updatedPartialAccount: any
//   ): void

//   applyResponseAddState(
//     applyResponse: any,
//     fullAccountData: any,
//     localCache: any,
//     accountId: string,
//     txId: string,
//     txTimestamp: number,
//     accountStateBefore: string,
//     accountStateAfter: string,
//     accountCreated: boolean
//   ): void

//   getLocalOrRemoteAccount(
//     address: string
//   ): Promise<WrappedDataFromQueue>

//   getRemoteAccount(address: string): Promise<WrappedDataFromQueue>

//   getLatestCycles(): Cycle[]

//   getNodeId(): string

//   getClosestNodes(hash: string, number: number): string[]

//   getNode(nodeId: string): Node
//   // not sure where this def should go?
//   // profiler: any
//   p2p: any
// }

export interface App {
  /**
   * Runs fast validation of the tx checking if all tx fields present, data
   * types acceptable, and ranges valid.
   *
   * Returns whether tx pass or failed validation plus the reason why
   */
  validate(tx: OpaqueTransaction, appData: any): { success: boolean; reason: string; status: number }

  /**
   * Cracks open the transaction and returns its timestamp, id (hash), and any
   * involved keys.
   *
   * Txs passed to this function are guaranteed to have passed validation first.
   */
  crack(
    tx: OpaqueTransaction,
    appData: any
  ): {
    timestamp: number
    id: string
    keys: TransactionKeys
  }

  /**
   * give the app a chance to generate additional data for the crack function
   * @param tx
   * @param appData
   */
  txPreCrackData(tx: OpaqueTransaction, appData: any): Promise<void> // Promise<any>

  // DEPRECATED . This was previously a deep validate for buisness logic but it is up to the dapp to handle this as part of apply
  validateTransaction?: (...data: any) => any
  /**
   * A function responsible for validation the incoming transaction fields
   */
  // DEPRECATED in favor of `validate`
  validateTxnFields?: (
    inTx: OpaqueTransaction // it is better to not use IncomingTransaction
  ) => IncomingTransactionResult
  /**
   * A function responsible for applying an accepted transaction
   */
  apply: (
    inTx: OpaqueTransaction,
    wrappedStates: { [accountId: string]: WrappedData },
    appData: any
  ) => Promise<ApplyResponse>

  /**
   * This is called after consensus has received or produced a receipt and the trasaction is approved.
   * Do not change any of the values passes in.
   * This is a place to generate other transactions, or do off chain work like send and email.
   */
  transactionReceiptPass?: (inTx: OpaqueTransaction, wrappedStates: any, applyResponse: ApplyResponse) => void

  /**
   * This is called after consensus has received or produced a receipt and the trasaction fails.
   * Do not change any of the values passes in.
   * This is a place to generate other transactions, or do off chain work like send and email.
   */

  transactionReceiptFail?: (inTx: OpaqueTransaction, wrappedStates: any, applyResponse: ApplyResponse) => void

  updateAccountFull: (wrappedState: WrappedResponse, localCache: any, applyResponse: ApplyResponse) => void

  updateAccountPartial: (wrappedState: WrappedResponse, localCache: any, applyResponse: ApplyResponse) => void

  getRelevantData: (accountId: string, tx: object) => Promise<WrappedResponse>

  /**
   * A function responsible for getting timestamp from injected transaction
   */
  getTimestampFromTransaction: (
    inTx: OpaqueTransaction, // it is better to not use IncomingTransaction
    appData: {}
  ) => number

  /**
   * A function that returns the Keys for the accounts involved in the transaction
   */
  // DEPRECATED in favor of `crack`
  getKeyFromTransaction?: (inTx: OpaqueTransaction) => TransactionKeys
  /**
   * A function that returns the State ID for a given Account Address
   */
  getStateId?: (accountAddress: string, mustExist?: boolean) => Promise<string>
  /**
   * A function that returns the timestamp for a given Account Address
   */
  getAccountTimestamp?: (accountAddress: string, mustExist?: boolean) => number

  /**
   * A function that allows the app to look at a passed in account ane return the hash and timestamp
   */
  getTimestampAndHashFromAccount?: (account: any) => {
    timestamp: number
    hash: string
  }

  /**
   * A function that will be called when the shardus instance shuts down
   */
  close: () => void

  getAccountData: (accountStart: string, accountEnd: string, maxRecords: number) => Promise<WrappedData[]>

  getAccountDataByRange: (
    accountStart: string,
    accountEnd: string,
    tsStart: number,
    tsEnd: number,
    maxRecords: number,
    offset: number,
    accountOffset: string
  ) => Promise<WrappedData[]>

  calculateAccountHash: (account: unknown) => string

  setAccountData: (accountRecords: unknown[]) => void

  resetAccountData: (accountRecords: unknown[]) => void

  deleteAccountData: (addressList: string[]) => void

  getAccountDataByList: (addressList: string[]) => Promise<WrappedData[]>

  deleteLocalAccountData: () => void

  getAccountDebugValue: (wrappedAccount: WrappedData) => string

  canDebugDropTx?: (tx: unknown) => boolean

  /**
   * This gives the application a chance to sync or load initial data before going active.
   * If it is the first node it can use .set() to set data
   * If it is not the first node it could use getLocalOrRemote() to query data it needs.
   */
  sync?: () => any

  dataSummaryInit?: (blob: any, accountData: any) => void
  dataSummaryUpdate?: (blob: any, accountDataBefore: any, accountDataAfter: any) => void
  txSummaryUpdate?: (blob: any, tx: any, wrappedStates: any) => void
  validateJoinRequest?: (data: any) => any
  getJoinData?: () => any
}

export interface TransactionKeys {
  /**
   * An array of the source keys
   */
  sourceKeys: string[]
  /**
   * An array of the target keys
   */

  targetKeys: string[]
  /**
   * all keys
   */

  allKeys: string[]
  /**
   * Timestamp for the transaction
   */
  timestamp: number
  /**
   * debug info string
   */
  debugInfo?: string
}
export interface ApplyResponse {
  /**
   * The statle table results array
   */
  stateTableResults: StateTableObject[]
  /**
   * Transaction ID
   */
  txId: string
  /**
   * Transaction timestamp
   */
  txTimestamp: number
  /**
   * Account data array
   */
  accountData: WrappedResponse[]
  /**
   * Optional(for now) list of accounts that were written to
   * Can include accounts that were not in the initial list of involved accounts
   */
  accountWrites: {
    accountId: string
    data: WrappedResponse
    txId: string
    timestamp: number
  }[]
  /**
   * a blob for the app to define.
   * This gets passed to post apply
   */
  appDefinedData: unknown
  /**
   * can return this if failed instead of throwing an exception
   */
  failed: boolean
  failMessage: string
  /**
   * a blob of dapp data returned. This can attach to the receipt for a pass
   * or fail vote
   */
  appReceiptData: WrappedResponse
  appReceiptDataHash: string
}

export interface AccountData {
  /** Account ID */
  accountId: string
  /** Account Data */
  data: string
  /** Transaction ID */
  txId: string
  /** Timestamp */
  timestamp: number // is it ok to use string here, how about data?
  /** Account hash */
  hash: string
}

// similar to AccountData but comes from the accounts copy backup table.
export interface AccountsCopy {
  accountId: string
  cycleNumber: number
  data: unknown
  timestamp: number
  hash: string
  isGlobal: boolean
}

export interface WrappedData {
  /** Account ID */
  accountId: string
  /** hash of the data blob */
  stateId: string
  /** data blob opaqe */
  data: unknown
  /** Timestamp */
  timestamp: number

  /** optional data related to sync process */
  syncData?: any
}

export interface WrappedResponse extends WrappedData {
  accountCreated: boolean
  isPartial: boolean

  //Set by setPartialData
  userTag?: any
  localCache?: any // TODO CODEREIVEW: use by partial data, but really need to code review everything localCache related.
  // LocalCache was supposed to be a full copy of the account before tx was applied. This would allow for
  // sending partial account data out for a TX but still doing the full transform when it is local
  // for some reason localCache is also getting check for logic to determin if the account should be saved locally,
  // a more explicit mechanism would be nicer

  // state manager tracking
  prevStateId?: string
  // need a before copy of the data for stats system. may not be super effcient. possibly merge this with original data on the queue entry
  prevDataCopy?: any
}

// old version:
// export interface WrappedResponse {
//   accountId: string,
//   accountCreated: boolean,
//   isPartial: boolean,
//   stateId: string,
//   timestamp: number,
//   data: any
// }

//seenInQueue

export interface WrappedDataFromQueue extends WrappedData {
  /** is this account still in the queue */
  seenInQueue: boolean
}
export interface TimestampReceipt {
  txId: string
  cycleMarker: string
  cycleCounter: number
  timestamp: number
}

export interface AccountData2 {
  /** Account ID */
  accountId: string
  /** Account Data */
  data: string
  /** Transaction ID */
  txId: string
  /** Timestamp */
  txTimestamp: string
  /** Account hash */
  hash: string
  /** Account data */
  accountData: unknown
  /** localCache */
  localCache: any
}

// createWrappedResponse (accountId, accountCreated, hash, timestamp, fullData) {
//   // create and return the response object, it will default to full data.
//   return { accountId: accountId, accountCreated, isPartial: false, stateId: hash, timestamp: timestamp, data: fullData }
// }

// createApplyResponse (txId, txTimestamp) {
//   let replyObject = { stateTableResults: [], txId, txTimestamp, accountData: [] }
//   return replyObject
// }

// // USED BY SIMPLECOINAPP
// applyResponseAddState (resultObject, accountData, localCache, accountId, txId, txTimestamp, stateBefore, stateAfter, accountCreated) {
//   let state = { accountId, txId, txTimestamp, stateBefore, stateAfter }
//   if (accountCreated) {
//     state.stateBefore = allZeroes64
//   }
//   resultObject.stateTableResults.push(state)
//   resultObject.accountData.push({ accountId, data: accountData, txId, timestamp: txTimestamp, hash: stateAfter, localCache: localCache })
// }

export interface StateTableObject {
  /** Account ID */
  accountId: string
  /** Transaction ID */
  txId: string
  /** Transaction Timestamp */
  txTimestamp: string
  /** The hash of the state before applying the transaction */
  stateBefore: string
  /** The hash of the state after applying the transaction */
  stateAfter: string
}

// NEED to loosen this defination..  shardus should not know this much!!!  maybe just move it to the app side
export interface IncomingTransaction {
  /** Source account address for the transaction */
  srcAct: string
  /** Target account address for the transaction */
  tgtActs?: string
  /** Target account addresses for the transaction */
  tgtAct?: string
  /** The transaction type */
  txnType: string
  /** The transaction amount */
  txnAmt: number
  /** The transaction Sequence Number */
  seqNum: number
  /** The transaction signature */
  sign: Sign
  /** The transaction timestamp */
  txnTimestamp?: string
}

export interface Sign {
  /** The key of the owner */
  owner: string
  /** The hash of the object's signature signed by the owner */
  sig: string
}

export interface IncomingTransactionResult {
  /** The result for the incoming transaction */
  success: boolean //was Results before.. but having trouble with that
  /** The reason for the transaction result */
  reason: string
  /** The timestamp for the result */
  txnTimestamp?: number
  status?: number
}

export enum ServerMode {
  Debug = 'debug',
  Release = 'release',
}

export interface ServerConfiguration {
  /** The heartbeatInterval parameter is an Integer that defines the number of seconds between each heartbeat logged within shardus */
  heartbeatInterval?: number
  /** The baseDir parameter is a String that defines the relative base directory for this running instance of shardus */
  baseDir?: string
  /** The transactionExpireTime parameter is an Integer that defines the amount of time (in seconds) allowed to pass before a transaction will expire and be rejected by the network. */
  transactionExpireTime?: number
  /** Crypto module configuration */
  crypto?: {
    /** The hashkey parameter is a String that is used to initialize the crypto module, which is used for the cryptographic functions within shardus */
    hashKey?: string
  }
  /** P2P module configuration */
  p2p?: {
    /** The ipServer parameter is a String that specifies a the url for the ipServer. */
    ipServer?: string
    /** The timeServers parameter is an Array of String that specifies where to get time critical data. */
    timeServers?: string[]
    /**  */
    existingArchivers?: Array<{
      ip: string
      port: number
      publicKey: string
    }>
    /** The syncLimit parameter is an Integer that specifies the amount of time (in seconds) a node’s local time can differ from the network’s time. */
    syncLimit?: number
    /** The cycleDuration parameter is an Integer specifying the amount of time (in seconds) it takes for a shardus network cycle to complete. */
    cycleDuration?: number
    /** The maxRejoinTime parameter is an Integer specifying the amount of time (in seconds) between network heartbeats before a node must ask to rejoin. */
    maxRejoinTime?: number
    /** The seedList parameter is a String specifying the url for the seedNode server that the application will communicate with. */
    // seedList?: string
    /** The difficulty parameter is an Integer specifying the proof of work difficulty to prevent network spam. */
    difficulty?: number
    /** The queryDelay parameter is an Integer specifying the amount of time (in seconds) to delay between cycle phase. */
    queryDelay?: number
    /** The netadmin parameter is a String specifying the public key of the network admin for emergency network alerts, updates, or broadcasts. */
    // netadmin?: string
    /** The gossipRecipients parameter is an Integer specifying the number of nodes to send gossip to in the network after receiving a message.
     * Shardus groups nodes with neighbors, who they can gossip the message to, so you can set this pretty low and still expect it to be
     * propogated through the entire network. (It’s recommended to set this to AT LEAST 3, 4 is recommended, and 5 would be even safer,
     * but maybe overkill). Shardus will send 2 gossips to neighboring nodes, and send the remaining number left over in the parameter to
     * random nodes in the network, so messages will be propagated very quickly.
     **/
    gossipRecipients?: number
    gossipFactor?: number
    gossipStartSeed?: number
    gossipSeedFallof?: number
    /** The gossipTimeout parameter is an Integer specifying the amount of time (in seconds) before an old gossip is deleted from a node. */
    gossipTimeout?: number
    /** The maxSeedNodes parameter is an Integer specifying the maximum number of seedNodes used to be used. */
    maxSeedNodes?: number
    /** The minNodesToAllowTxs parameter is an Integer specifying the minimum number of active nodes needed in the network to process txs. */
    minNodesToAllowTxs?: number
    /** The minNodes parameter is an Integer specifying the minimum number of nodes that need to be active in the network in order to process transactions. */
    minNodes?: number
    /** The maxNodes parameter is an Integer specifying the maximum number of nodes that can be active in the network at once. */
    maxNodes?: number
    /** The seedNodeOffset parameter is an Integer specifying the number of seedNodes to remove when producing the seedList */
    seedNodeOffset?: number
    /** The nodeExpiryAge parameter is an Integer specifying the amount of time (in seconds) before a node can be in the network before getting rotated out. */
    nodeExpiryAge?: number

    /** The maxJoinedPerCycle parameter is an Integer specifying the maximum number of nodes that can join the syncing phase each cycle. */
    maxJoinedPerCycle?: number
    /** The maxSyncingPerCycle parameter is an Integer specifying the maximum number of nodes that can be in the syncing phase each cycle. */
    maxSyncingPerCycle?: number
    /** allow syncing more nodes in a small network. only works well if we are not loading a lot of data */
    syncBoostEnabled?: boolean
    /** The max syncing time a node can take */
    maxSyncTimeFloor?: number
    /** max nodes to calculate median/max sync time */
    maxNodeForSyncTime?: number
    /** The maxRotatedPerCycle parameter is an Integer specifying the maximum number of nodes that can that can be rotated out of the network each cycle. */
    maxRotatedPerCycle?: number
    /** A fixed boost to let more nodes in when we have just the one seed node in the network */
    firstCycleJoin?: number

    /** The maxPercentOfDelta parameter is an Integer specifying the percent out of 100 that additional nodes can be accepted to the network. */
    maxPercentOfDelta?: number
    /** The minScaleReqsNeeded parameter is an Integer specyifying the number of internal scaling requests shardus needs to receive before scaling up or down the number of desired nodes in the network.
     *  This is just the minimum votes needed, scaleConsensusRequired is a 0-1 fraction of num nodes required.
     *  The votes needed is  Math.Max(minScaleReqsNeeded,  numNodes * scaleConsensusRequired )
     */
    minScaleReqsNeeded?: number
    /** The maxScaleReqs parameter is an Integer specifying the maximum number of scaling requests the network will process before scaling up or down. */
    maxScaleReqs?: number
    /** What fraction 0-1 of numNodes is required for a scale up or down vote */
    scaleConsensusRequired?: number
    /** The amountToGrow parameter is an Integer specifying the amount of nodes to ADD to the number of desired nodes the network wants. */
    amountToGrow?: number
    /** The amountToShrink parameter is an Integer specifying the amount of nodes to REMOVE from the number of desired nodes the network wants. */
    amountToShrink?: number
    /** max desired nodes based on a multiplier of our active node count */
    maxDesiredMultiplier?: number
    /** If witenss mode is true, node will not join the network but help other nodes to sync the data */
    startInWitnessMode?: boolean
    experimentalSnapshot?: boolean
    detectLostSyncing?: boolean
    /** limit the scaling group to a max number of nodes */
    scaleGroupLimit?: number
    /** this is to switch to signature based auth for gossip messages. default: false */
    useSignaturesForAuth?: boolean
  }
  /** Server IP configuration */
  ip?: {
    /** The IP address the server will run the external API */
    externalIp?: string | 'auto'
    /** The port the server will run the external API */
    externalPort?: number | 'auto'
    /** The IP address the server will run the internal comunication API */
    internalIp?: string | 'auto'
    /** The port the server will run the internal comunication API  */
    internalPort?: number | 'auto'
  }
  /** Server Network module configuration */
  network?: {
    /** The timeout parameter is an Integer specifying the amount of time (in seconds) given to an internal network request made by the node until it gets timed out. */
    timeout?: number
  }
  /** Server Report module configuration */
  reporting?: {
    /** The report parameter is an Boolean specifying whether or not to report data to a monitor server / client. */
    report?: boolean
    /** The recipient parameter is an String specifying the url of the recipient of the data that will be reported if report is set to true. */
    recipient?: string
    /** The interval paramter is an Integer specifying the amount of time (in seconds) between the reported data updates. */
    interval?: number
    /** The console parameter is an Boolean specifying whether or not to report data updates to the console. */
    console?: boolean
  }
  /** Server's current mode or environment to be run in. Can be 'release' or 'debug' with 'release' being the default. */
  mode?: ServerMode
  /** Server Debug module configuration */
  debug?: {
    /**
     * This value control whether a node check itself to be in authorized before sending out scaling request
     */
    ignoreScaleGossipSelfCheck?: boolean

    /** The loseReceiptChance parameter is a Float specifying a percentage chance to randomly drop a receipt (currently doesn’t do anything) */
    loseReceiptChance?: number
    /** The loseTxChance parameter is a Float specifying a percentage chance to randomly drop a transaction. */
    loseTxChance?: number
    /** The canDataRepair parameter is a boolean that allows dataRepair to be turned on/off by the application (true = on | false = off) */
    canDataRepair?: boolean
    /** Disable voting consensus for TXs (true = on | false = off) */
    debugNoTxVoting?: boolean
    /** ignore initial incomming receipt */
    ignoreRecieptChance?: number
    /** ignore initial incomming vote */
    ignoreVoteChance?: number
    /** chance to fail making a receipt */
    failReceiptChance?: number
    /** chance to flip our vote */
    voteFlipChance?: number
    /** should skip patcher repair system */
    skipPatcherRepair?: boolean
    /** chance to fail a TX and the TX repair */
    failNoRepairTxChance?: number
    /** use the new stats data for partition state reports to monitor server */
    useNewParitionReport?: boolean
    /** is the old partition checking system enabled */
    oldPartitionSystem?: boolean
    /** slow old reporting that queries sql for account values */
    dumpAccountReportFromSQL?: boolean
    /** enable the built in profiling */
    profiler?: boolean
    /** starts the node in fatals mode, use endpoints to turn back on default logs */
    startInFatalsLogMode?: boolean
    /** starts the node in error mode, use endpoints to turn back on default logs */
    startInErrorLogMode?: boolean
    /** fake network delay in ms */
    fakeNetworkDelay?: number
    /** disable snapshots */
    disableSnapshots?: boolean
    /** disable txCoverage report */
    disableTxCoverageReport?: boolean
    /** Halt repair attempts when data OOS happens */
    haltOnDataOOS?: boolean
    /** start counting endpoints */
    countEndpointStart?: number
    /** stop counting endpoints */
    countEndpointStop?: number
    //** hash of our dev auth key */
    hashedDevAuth?: string
    devPublicKey?: string
    newCacheFlow?: boolean
    /** dump extra data for robust query even if in error/fatal logggin only mode */
    robustQueryDebug: boolean
    /** pretty sure we don't want this ever but making a config so we can AB test as needed */
    forwardTXToSyncingNeighbors: boolean
    /** flag to toggle recording accepted app transactions in db */
    recordAcceptedTx: boolean
    /** flag to toggle recording app account states in db */
    recordAccountStates: boolean
  }
  /** Options for the statistics module */
  statistics?: {
    /** The save parameter is a Boolean specifying whether or not statistics will be gathered and saved when running the network. */
    save?: boolean
    /** The interval parameter is a Integer specifying the amount of time (in seconds) between each generated stats data. */
    interval?: number
  }
  /**  */
  loadDetection?: {
    /**
     * The queueLimit parameter is an Integer which specifies one of the two possible limits to check whether the network is under heavy load.
     * It does this by checking it’s set value against the current transaction queue. The threshold will be equal to the number of transactions
     * in the queue / the queueLimit.
     **/
    queueLimit?: number
    /**
     * The queueLimit parameter is an Integer which specifies one of the two possible limits to check whether the network is under heavy load.
     * It does this by checking it’s set value against the current transaction queue. The threshold will be equal to the number of transactions
     * in the queue / the queueLimit.
     * executeQueueLimit is similar to queueLimit but will only count transactions that will execute on this node
     */
    executeQueueLimit?: number
    /** The desiredTxTime parameter is an Integer which specifies the other condition to check whether the network is under heavy load. */
    desiredTxTime?: number
    /** The highThreshold parameter is an Integer which specifies the high end of the load the network can take. Reaching this threshold will cause the network to increase the desired nodes. */
    highThreshold?: number
    /** The lowThreshold parameter is an Integer which specifies the low end of the load the network can take. Reaching this threshold will cause the network to decrease the desired nodes. */
    lowThreshold?: number
  }
  /** Options for rate limiting */
  rateLimiting?: {
    /** The limitRate parameter is a Boolean indicating whether or not the network should rate limit in any way. */
    limitRate?: boolean
    /**
     * The loadLimit parameter is a Float (between 0 and 1) indicating the maximum level of load the network can handle before starting to drop transactions.
     * With loadLimit set to 0.5, at 75% or 0.75 load, the network would drop 50% of incoming transactions.
     * (The percentage of chance to drop a transaction scales linearly as the load increases past the threshold).
     **/
    loadLimit?: {
      internal?: number
      external?: number
      txTimeInQueue?: number
      queueLength?: number
      executeQueueLength?: number
    }
  }
  /** Server State manager module configuration */
  stateManager?: {
    /** The stateTableBucketSize parameter is an Integer which defines the max number of accountRecords that the p2p module will ask for in it’s get_account_state call. */
    stateTableBucketSize?: number
    /** The accountBucketSize This is also currently used as input to a p2p ask method for the max number of account records */
    accountBucketSize?: number
    /** number of accounts that the patcher can get per request */
    patcherAccountsPerRequest: number
    /** number of accounts that the patcher can get per upddate (cycle) */
    patcherAccountsPerUpdate: number
    /** number of hashes we can ask for per request (non leaf) , not enabled yet. not sure if we want or need it*/
    patcherMaxHashesPerRequest: number
    /** number of hashes we can ask for child nodes per request */
    patcherMaxLeafHashesPerRequest: number
    /** max number of child hashes that we can respond with */
    patcherMaxChildHashResponses: number
    /** max number of sync restarts allowed due to thrown exceptions before we go apop */
    maxDataSyncRestarts: number
    /** max number of sync restarts allowed due to thrown exceptions for each tracker instance */
    maxTrackerRestarts: number
    /** Use accountID for the offset command when syncing data */
    syncWithAccountOffset: boolean
    /** this will control if the account copies table functions */
    useAccountCopiesTable: boolean
  }
  /** Options for sharding calculations */
  sharding?: {
    /** The nodesPerConsensusGroup parameter defines how many nodes will be contained within a shard */
    nodesPerConsensusGroup?: number
    /** The number of edge nodes on each side */
    nodesPerEdge?: number
    /** Sets if the execute in one shard feature is active */
    executeInOneShard?: boolean
  }
}

export interface LogsConfiguration {
  saveConsoleOutput?: boolean
  dir?: string
  files?: {
    main?: string
    fatal?: string
    net?: string
    app?: string
  }
  options?: {
    appenders?: {
      out?: {
        type?: string
        maxLogSize?: number
        backups?: number
      }
      main?: {
        type?: string
        maxLogSize?: number
        backups?: number
      }
      app?: {
        type?: string
        maxLogSize?: number
        backups?: number
      }
      p2p?: {
        type?: string
        maxLogSize?: number
        backups?: number
      }
      snapshot?: {
        type?: string
        maxLogSize?: number
        backups?: number
      }
      cycle?: {
        type?: string
        maxLogSize?: number
        backups?: number
      }
      fatal?: {
        type?: string
        maxLogSize?: number
        backups?: number
      }
      exit?: {
        type?: string
        maxLogSize?: number
        backups?: number
      }
      errorFile?: {
        type?: string
        maxLogSize?: number
        backups?: number
      }
      errors?: {
        type?: string
        level?: string
        appender?: string
      }
      net?: {
        type?: string
        maxLogSize?: number
        backups?: number
      }
      playback?: {
        type?: string
        maxLogSize?: number
        backups?: number
      }
      shardDump?: {
        type?: string
        maxLogSize?: number
        backups?: number
      }
      statsDump?: {
        type?: string
        maxLogSize?: number
        backups?: number
      }
    }
    categories?: {
      default?: {
        appenders?: string[]
        level?: string
      }
      app?: {
        appenders?: string[]
        level?: string
      }
      main?: {
        appenders?: string[]
        level?: string
      }
      p2p?: {
        appenders?: string[]
        level?: string
      }
      snapshot?: {
        appenders?: string[]
        level?: string
      }
      cycle?: {
        appenders?: string[]
        level?: string
      }
      fatal?: {
        appenders?: string[]
        level?: string
      }
      exit?: {
        appenders?: string[]
        level?: string
      }
      net?: {
        appenders?: string[]
        level?: string
      }
      playback?: {
        appenders?: string[]
        level?: string
      }
      shardDump?: {
        appenders?: string[]
        level?: string
      }
      statsDump?: {
        appenders?: string[]
        level?: string
      }
    }
  }
}

export interface StorageConfiguration {
  database?: string
  username?: string
  password?: string
  options?: {
    logging?: false
    host?: string
    dialect?: string
    operatorsAliases?: false
    pool?: {
      max?: number
      min?: number
      acquire?: number
      idle?: number
    }
    storage?: string
    sync?: {
      force?: false
    }
    memoryFile?: false
    saveOldDBFiles: boolean
    walMode: boolean
    exclusiveLockMode: boolean
  }
}

export interface ShardusConfiguration {
  server?: ServerConfiguration
  logs?: LogsConfiguration
  storage?: StorageConfiguration
}

export type StrictServerConfiguration = DeepRequired<ServerConfiguration>
export type StrictLogsConfiguration = DeepRequired<LogsConfiguration>
export type StrictStorageConfiguration = DeepRequired<StorageConfiguration>

export interface StrictShardusConfiguration {
  server: StrictServerConfiguration
  logs: StrictLogsConfiguration
  storage: StrictStorageConfiguration
}

export interface AcceptedTx {
  timestamp: number
  txId: string
  keys: TransactionKeys
  data: OpaqueTransaction
  appData: any
}

export interface TxReceipt {
  txHash: string
  sign?: Sign
  time: number //transaction timestamp
  stateId: string //hash of the source account.  this should be phased out or modified to handle multiple sources
  targetStateId: string //hash of the target account.  this should be phased out or modified to handle multiple targets
}

type ObjectAlias = object
/**
 * OpaqueTransaction is the way shardus should see transactions internally. it should not be able to mess with parameters individually
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface OpaqueTransaction extends ObjectAlias {}

export type DeepRequired<T> = Required<{
  [P in keyof T]: T[P] extends object | undefined ? DeepRequired<Required<T[P]>> : T[P]
}>
