import { ServerMode, StrictServerConfiguration } from '../shardus/shardus-types'

const SERVER_CONFIG: StrictServerConfiguration = {
  heartbeatInterval: 5,
  baseDir: '.',
  transactionExpireTime: 5,
  globalAccount: '0'.repeat(64),
  /**
   * [TODO] Introduced on 2024-04-15 and needs to be checked through out the code
   */
  nonceMode: true, // true for nonce mode, false for timestamp mode
  crypto: {
    hashKey: '69fa4195670576c0160d660c3be36556ff8d504725be8a59b5a96509e0c994bc',
    keyPairConfig: {
      useKeyPairFromFile: true,
      keyPairJsonFile: 'secrets.json',
    },
  },
  p2p: {
    ipServers: [
      'https://ipapi.co/json',
      'https://ifconfig.co/json',
      'https://ipinfo.io/json',
      'api.ipify.org/?format=json',
    ],
    timeServers: ['0.pool.ntp.org', '1.pool.ntp.org', '2.pool.ntp.org', '3.pool.ntp.org'],
    existingArchivers: [
      {
        ip: '127.0.0.1',
        port: 4000,
        publicKey: '758b1c119412298802cd28dbfa394cdfeecc4074492d60844cc192d632d84de3',
      },
      {
        ip: '127.0.0.1',
        port: 4001,
        publicKey: 'e4b5e3d51e727f897786a1bb176a028ecfe1941bfa5beefd3c6209c3dbc07cf7',
      },
    ],
    syncLimit: 180, //180 seconds seems way to high to allow.
    useNTPOffsets: true,
    cycleDuration: 30,
    maxRejoinTime: 20,
    difficulty: 2,
    dynamicBogonFiltering: true,
    forceBogonFilteringOn: false, //should turn this on for releases or dev testing
    rejectBogonOutboundJoin: true,
    queryDelay: 1,
    gossipRecipients: 8,
    gossipFactor: 4,
    dynamicGossipFactor: false,
    gossipStartSeed: 15,
    gossipSeedFallof: 15,
    gossipTimeout: 180,
    maxSeedNodes: 10,
    minNodesToAllowTxs: 1,
    continueOnException: false,
    minNodesPerctToAllowExitOnException: 0.66,
    baselineNodes: 15, // config used for new threshold for entering recovery, restore, and safety. Should be equivalient to minNodes on network startup
    minNodes: 15,
    enableMaxStandbyCount: true,
    maxStandbyCount: 30000,
    maxNodes: 30,
    seedNodeOffset: 4,
    nodeExpiryAge: 30,
    maxJoinedPerCycle: 1,
    maxSyncingPerCycle: 5,
    syncBoostEnabled: true,
    maxSyncTimeFloor: 1200,
    maxNodeForSyncTime: 9,
    maxRotatedPerCycle: 1,
    firstCycleJoin: 10,
    maxPercentOfDelta: 40,
    minScaleReqsNeeded: 5,
    maxScaleReqs: 200,
    scaleConsensusRequired: 0.25,
    amountToGrow: 1,
    amountToShrink: 1,
    maxShrinkMultiplier: 0.02,
    scaleInfluenceForShrink: 0.2,
    maxDesiredMultiplier: 1.2,
    startInWitnessMode: false,
    experimentalSnapshot: true,
    detectLostSyncing: true,
    scaleGroupLimit: 25,
    useSignaturesForAuth: false,
    checkVersion: false,
    extraCyclesToKeep: 33,
    extraCyclesToKeepMultiplier: 1,
    checkNetworkStopped: false,
    validateActiveRequests: false,
    hackForceCycleSyncComplete: false,
    uniqueRemovedIds: false,
    uniqueRemovedIdsUpdate: false,
    uniqueLostIdsUpdate: false,
    useLruCacheForSocketMgmt: false,
    lruCacheSizeForSocketMgmt: 1000,
    delayLostReportByNumOfCycles: 1,
    aggregateLostReportsTillQ1: true,
    isDownCachePruneCycles: 10,
    isDownCacheEnabled: true,
    stopReportingLostPruneCycles: 10,
    lostMapPruneCycles: 10,
    instantForwardReceipts: false,
    maxArchiversSubscriptionPerNode: 2,
    writeSyncProtocolV2: false,
    useSyncProtocolV2: true,
    validateArchiverAppData: false,
    useNetworkModes: true,
    useJoinProtocolV2: true,
    randomJoinRequestWait: 2000, //todo set this to 1000 before release
    standbyListCyclesTTL: 10, //todo release should be > 1000
    standbyListMaxRemoveTTL: 100, //todo set this be 100 for production
    standbyListMaxRemoveApp: 100, //todo set this be 100 for production
    standbyAgeScrub: true,
    standbyVersionScrub: true,
    standbyAgeCheck: true, //todo consider for migration
    q1DelayPercent: 0.125,
    goldenTicketEnabled: true,
    preGossipNodeCheck: true,
    preGossipDownCheck: true,
    preGossipLostCheck: true,
    preGossipRecentCheck: true,
    initShutdown: false,
    enableLostArchiversCycles: false, //disabled until we can properly re-test and fix some issues
    lostArchiversCyclesToWait: 3,
    standbyListFastHash: false, //todo set to false and migrate
    networkBaselineEnabled: false, // feature flag to enable use of baselineNodes that's new threshold for the safety, restore, and recovery modes instead of minNodes
    useBinarySerializedEndpoints: false,
    useCombinedTellBinary: true,
    rotationCountMultiply: 1,
    rotationCountAdd: 0,
    rotationPercentActive: 0.001, //rotate 0.1% of active nodes per cycle when in a steady processing state
    rotationMaxAddPercent: 0.1,
    rotationMaxRemovePercent: 0.05,
    allowActivePerCycle: 7,
    useProxyForDownCheck: false,
    numCheckerNodes: 1,
    minChecksForDown: 1,
    minChecksForUp: 1,
    attemptJoiningWaitMultiplier: 2,
    cyclesToWaitForSyncStarted: 3,
    cyclesToRefreshEarly: 4,
    extraNodesToAddInRestart: 5,
    secondsToCheckForQ1: 1000, // 1 seconds in ms
    hardenNewSyncingProtocol: true,
    removeLostSyncingNodeFromList: false,
    compareCertBinary: true,
    makeReceiptBinary: true,
    lostArchiverInvestigateBinary: true,
    signAppDataBinary: true,
    sendCachedAppDataBinary: true,
    syncTrieHashesBinary: true, //should be ok with latest fixes  SHM-4280
    getTrieHashesBinary: true,
    getTrieAccountHashesBinary: true,
    getAccountDataBinary: true,
    getAccountDataByHashBinary: true,
    getAccountDataByListBinary: true,
    getGloablAccountReportBinary: true,
    getCachedAppDataBinary: true,
    getAccountQueueCountBinary: true,
    getAccountDataWithQueueHintsBinary: true,
    getTxTimestampBinary: true,
    getAppliedVoteBinary: true, //disabled due to SHM-4286
    getConfirmOrChallengeBinary: true,
    spreadAppliedVoteHashBinary: true,
    spreadTxToGroupSyncingBinary: true,
    broadcastStateBinary: true,
    broadcastFinalStateBinary: true, //should be ok with latest fixes SHM-4282
    requestTxAndStateBinary: true,
    requestStateForTxPostBinary: true, //disabled because unhandled rejection SHM-4299
    requestStateForTxBinary: true,
    requestReceiptForTxBinary: true,
    lostReportBinary: true,
    repairMissingAccountsBinary: true,
    rotationEdgeToAvoid: 3,
    forcedMode: '',
    delayZombieRestartSec: 180,
    resumbitStandbyRefreshWaitDuration: 1000, // 1 second in ms
    formingNodesPerCycle: 7,
    downNodeFilteringEnabled: false,
    useFactCorrespondingTell: true,
    resubmitStandbyAddWaitDuration: 1000, // 1 second in ms
    requiredVotesPercentage: 2 / 3,
  },
  ip: {
    externalIp: '0.0.0.0',
    externalPort: 9001,
    internalIp: '0.0.0.0',
    internalPort: 10001,
  },
  network: { timeout: 5 },
  reporting: {
    report: true,
    recipient: 'http://127.0.0.1:3000/api',
    interval: 2,
    console: false,
    logSocketReports: true,
  },
  debug: {
    ignoreScaleGossipSelfCheck: false,
    loseReceiptChance: 0,
    loseTxChance: 0,
    canDataRepair: false,
    startInFatalsLogMode: false,
    startInErrorLogMode: true,
    fakeNetworkDelay: 0,
    disableSnapshots: true,
    disableTxCoverageReport: true,
    disableLostNodeReports: false,
    haltOnDataOOS: false,
    countEndpointStart: -1,
    countEndpointStop: -1,
    hashedDevAuth: '',
    devPublicKeys: {},
    debugNoTxVoting: false,
    ignoreRecieptChance: 0,
    ignoreVoteChance: 0,
    failReceiptChance: 0,
    voteFlipChance: 0,
    skipPatcherRepair: false,
    failNoRepairTxChance: 0,
    useNewParitionReport: false,
    oldPartitionSystem: false,
    dumpAccountReportFromSQL: false,
    profiler: false,
    minApprovalsMultiAuth: 3,
    robustQueryDebug: false,
    forwardTXToSyncingNeighbors: false,
    recordAcceptedTx: false,
    recordAccountStates: false,
    useShardusMemoryPatterns: true,
    sanitizeInput: false,
    checkTxGroupChanges: true,
    ignoreTimeCheck: false,
    checkAddressFormat: false,
    produceBadVote: false,
    produceBadChallenge: false,
    debugNTPErrorWindowMs: 200,
    enableScopedProfiling: false,
    enableBasicProfiling: true,
    enableCycleRecordDebugTool: false,
    forcedExpiration: false,
    ignoreStandbyRefreshChance: 0,
    localEnableCycleRecordDebugTool: false,
    enableTestMode: false,
    highResolutionProfiling: true,
    randomCycleData: false,
    debugStatListMaxSize: 1000,
  },
  statistics: { save: true, interval: 1 },
  loadDetection: {
    queueLimit: 1000,
    executeQueueLimit: 1000.0,
    desiredTxTime: 15,
    highThreshold: 0.5,
    lowThreshold: 0.2,
  },
  rateLimiting: {
    limitRate: true,
    loadLimit: {
      internal: 0.5,
      external: 0.4,
      txTimeInQueue: 0.2,
      queueLength: 0.2,
      executeQueueLength: 0.2,
    },
  },
  stateManager: {
    maxNonceQueueSize: 100000,
    stateTableBucketSize: 500,
    accountBucketSize: 200,
    patcherAccountsPerRequest: 250,
    patcherAccountsPerUpdate: 2500,
    patcherMaxHashesPerRequest: 300,
    patcherMaxLeafHashesPerRequest: 300,
    patcherMaxChildHashResponses: 2000,
    maxDataSyncRestarts: 5,
    maxTrackerRestarts: 5,
    syncWithAccountOffset: true,
    useAccountCopiesTable: false,
    stuckProcessingLimit: 300,
    autoUnstickProcessing: false,
    apopFromStuckProcessing: false,
    discardVeryOldPendingTX: false,
    transactionApplyTimeout: -1, //ms for timeout. something like 7000 is a starting point. todo set to -1 before release
    includeBeforeStatesInReceipts: false,
    fifoUnlockFix: true, //enabled for testing
    fifoUnlockFix2: false,
    fifoUnlockFix3: false,
    enableAccountFetchForQueueCounts: false,
    configChangeMaxCyclesToKeep: 5,
    configChangeMaxChangesToKeep: 1000,
    waitTimeBeforeConfirm: 200,
    waitTimeBeforeReceipt: 200,
    waitLimitAfterFirstVote: 2000,
    waitLimitAfterFirstMessage: 2000,
    minRequiredChallenges: 1,
    useNewPOQ: false,
    nonExWaitForData: 5000,
    usePOQo: true,
    poqoloopTime: 2000,
    poqobatchCount: 1,
    forwardToLuckyNodes: true,
    forwardToLuckyNodesNonceQueue: false,
    forwardToLuckyNodesCheckRotation: true,
    integrityCheckBeforeChallenge: true,
    checkPrecrackStatus: true,
    noVoteSeenExpirationTime: 10000,
    voteSeenExpirationTime: 20000,
    confirmationSeenExpirationTime: 30000,
    voterPercentage: 0.1,
    waitUpstreamTx: false,
    gossipCompleteData: false,
    shareCompleteData: true,
    txStateMachineChanges: true,
    canRequestFinalData: true,
    numberOfReInjectNodes: 5,
    maxPendingNonceTxs: 10,
    attachDataToReceipt: true,
    nodesToGossipAppliedReceipt: 10,
    useCopiedWrappedStateForApply: true,
    disableTxExpiration: true,
    removeStuckTxsFromQueue: false, //this should remain disabled due to possible stuck/oos issues
    stuckTxRemoveTime: 1000 * 60 * 2, // 2 minutes
    removeStuckTxsFromQueue2: false, //start disabled turn on via migration only
    stuckTxRemoveTime2: 1000 * 60 * 2, // 2 minutes (since we saw a valid vote, not the total age)
    removeStuckChallengedTXs: true,
    receiptRemoveFix: true,
    stuckTxQueueFix: true,
    singleAccountStuckFix: true,
    stuckTxMoveTime: 60000,
    forceVoteForFailedPreApply: true,
  },
  sharding: { nodesPerConsensusGroup: 5, nodesPerEdge: 2, executeInOneShard: false },
  mode: ServerMode.Debug,
  features: {
    dappFeature1enabled: false,
    fixHomeNodeCheckForTXGroupChanges: false,
    archiverDataSubscriptionsUpdate: false,
    startInServiceMode: false,
    enableRIAccountsCache: true,
  },
}
export default SERVER_CONFIG
