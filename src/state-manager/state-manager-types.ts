//import { AccountData } from "../shardus/shardus-types";

//import { WrappedData } from "../shardus/shardus-types";

// import { Node } from "../p2p/NodeList";

//import { WrappedResponse } from "../shardus/shardus-types";

//import { ShardGlobals } from "./shardFunctionTypes";

//import { WrappedData } from "../shardus/shardus-types";
//imports up top break the export, boo.
import * as Shardus from '../shardus/shardus-types'
import { StateManager } from 'shardus-types'
export { App, Cycle, Sign, AcceptedTx, ApplyResponse } from '../shardus/shardus-types'

export type WrappedStateArray = Shardus.WrappedData[]

export type QueueEntry = {
    acceptedTx: Shardus.AcceptedTx;
    txKeys: Shardus.TransactionKeys
    collectedData: WrappedResponses;
    originalData: WrappedResponses;//{[accountID:string]:string}; //serialized to string backups of account data.
    beforeHashes: {[accountID:string]:string}; //before hashes of account data
    homeNodes: {[accountID:string]:StateManager.shardFunctionTypes.NodeShardData};
    /**
     * TODO (after Jan 2022): review if we even need patchedOnNodes, it seems complicated, and I cant remember if the fix is still needed!
     */
    patchedOnNodes: Map<string, StateManager.shardFunctionTypes.NodeShardData>; //{[accountID:string]:import('./shardFunctionTypes').NodeShardData};
    hasShardInfo: boolean;
    state: string;
    dataCollected: number;
    hasAll: boolean;
    /**
     * based on the incrementing queueEntryCounter
     */
    entryID: number;
    localKeys: {
        [x: string]: boolean;
    };
    localCachedData: any;
    syncCounter: number;
    didSync: boolean;
    queuedBeforeMainSyncComplete: boolean; // todo debug related, so we may want to remove it to save mememory eventually
    didWakeup: boolean;
    txGroupDebug: string;
    syncKeys: any[];
    logstate: string; // logging state
    requests: {[key:string]:Shardus.Node} // map of account keys to the node that we are requesting the account data from
    globalModification:boolean;
    noConsensus:boolean; // This means our queue entry does not need the consensus step. should only be used for initial network set commands
    m2TimeoutReached:boolean; // A flag to track if we have executed the M2 timeout yet.
    waitForReceiptOnly:boolean; // This means dont try to produce a receipt
    uniqueKeys?: string[];
    uniqueWritableKeys?: string[];
    ourNodeInTransactionGroup: boolean;
    ourNodeInConsensusGroup: boolean;
    ourTXGroupIndex: number;
    conensusGroup?: Shardus.Node[];
    transactionGroup?: Shardus.Node[];
    txGroupCycle:number;
    updatedTransactionGroup?: Shardus.Node[];
    updatedTxGroupCycle:number;
    approximateCycleAge: number;

    // Local preapply response
    preApplyTXResult? : PreApplyAcceptedTransactionResult; // Shardus.ApplyResponse;

    // Consensus tracking:
    ourVote? : AppliedVote;
    collectedVotes : AppliedVote[];
    newVotes : boolean
    // receipt that we created
    appliedReceipt?: AppliedReceipt;

    gossipedReceipt: boolean;
    // receipt that we got from gossip
    recievedAppliedReceipt?: AppliedReceipt;

    // receipt that we need to repair to
    appliedReceiptForRepair?: AppliedReceipt;

    // receipt coalesced in getReceipt().
    appliedReceiptFinal?: AppliedReceipt;

    repairFinished?: boolean;
    repairFailed: boolean;

    requestingReceipt: boolean;
    receiptEverRequested: boolean;

    //calculate this data early to make the receipt map easy to calculate
    cycleToRecordOn: number;
    //any partitions that are involved in this TX (includes global)
    involvedPartitions: number[];
    //any global partitions that are involved in this TX
    involvedGlobalPartitions: number[];
    //short copy of the hash
    shortReceiptHash: string;
    // receipt status is in the receipt


    requestingReceiptFailed: boolean;

    //collectedData for repair
    debugFail_voteFlip:boolean;

    debugFail_failNoRepair:Boolean;
    //short log id
    logID:string;

    //true once our data matches the receipt
    hasValidFinalData:boolean;

    pendingDataRequest:boolean;

    fromClient:boolean; //from a client, or from another node in the network

    archived:boolean,
    involvedReads: {[accountID:string]:boolean};
    involvedWrites: {[accountID:string]:boolean};

  executionDebug?:any
};

export type SyncTracker = {
    syncStarted: boolean;
    syncFinished: boolean;
    range: StateManager.shardFunctionTypes.BasicAddressRange;
    cycle: number;
    index: number;
    queueEntries: QueueEntry[];

    isGlobalSyncTracker:boolean;
    globalAddressMap: {[address:string]:boolean}; //this appears to be unused?
    isPartOfInitialSync:boolean;

    keys: {[address:string]:boolean};
};


export type CycleShardData = {
    shardGlobals: StateManager.shardFunctionTypes.ShardGlobals// any // import('./shardFunctionTypes').ShardGlobals;
    cycleNumber: number;
    ourNode: Shardus.Node;
    /**
     * our node's node shard data
     */
    nodeShardData: StateManager.shardFunctionTypes.NodeShardData;
    nodeShardDataMap: Map<string, StateManager.shardFunctionTypes.NodeShardData>;
    parititionShardDataMap: Map<number, StateManager.shardFunctionTypes.ShardInfo>;
    activeNodes: Shardus.Node[];
    syncingNeighbors: Shardus.Node[];
    syncingNeighborsTxGroup: Shardus.Node[];
    hasSyncingNeighbors: boolean;

    partitionsToSkip: Map<number, boolean>

    timestamp:number // timestamp for cleanup purposes, may not match exactly the rules of which transactions will live in a partition for this cycle.
    timestampEndCycle:number

    hasCompleteData:boolean;

    /**
     * hashlist index of the voters for this vote
     */
    voters: number[];
    /**
     * list of partitions that we do consensus on
     */
    ourConsensusPartitions?: number[];
    /**
     * list of stored parititions
     */
    ourStoredPartitions?: number[];

    calculationTime:number;
};
/**
 * a partition object
 */
export type RepairTracker = {
    triedHashes: string[];
    numNodes: number;
    /**
     * cycle number for the repair obbject
     */
    counter: number;
    /**
     * partition id for the repair object
     */
    partitionId: number;
    /**
     * this key is based on the cycle counter in the form c###  where ### is the cycle number (can be as many digits as needed)
     */
    key: string;
    /**
     * this key is based on the partition in the form p## where ## is the partition number (can be as many digits as needed)
     */
    key2: string;
    removedTXIds: string[];
    repairedTXs: string[];
    newPendingTXs: Shardus.AcceptedTx[];
    newFailedTXs: Shardus.AcceptedTx[];
    extraTXIds: string[];
    missingTXIds: string[];
    repairing: boolean;
    repairsNeeded: boolean;
    busy: boolean;
    /**
     * we have the TXs and TX data we need to apply data repairs
     */
    txRepairReady: boolean;
    txRepairComplete: boolean;
    evaluationStarted: boolean;
    /**
     * not sure if we really need this
     */
    evaluationComplete: boolean;
    awaitWinningHash: boolean;
    repairsFullyComplete: boolean;
    solutionDeltas?: SolutionDelta[];
    outputHashSet?: string;
};
/**
 * a partition reciept
 */
export type PartitionReceipt = {
    resultsList: PartitionResult[];
    sign?: Shardus.Sign;
};
/**
 * A simple address range
 */
export type SimpleRange = {
    /**
     * Starting index
     */
    low: string;
    /**
     * End index
     */
    high: string;
};
/**
 * a partition object
 */
export type PartitionObject = {
    Partition_id: number;
    Partitions: number;
    Cycle_number: number;
    Cycle_marker: string;
    Txids: string[];
    Status: number[];
    States: string[];
    /**
     * todo more specific data export type
     */
    Chain: any[];
};
/**
 * a partition result
 */
export type PartitionResult = {
    Partition_id: number;
    Partition_hash: string;
    Cycle_number: number;
    hashSet: string;
    /**
     * // property {any} \[hashSetList\] this seems to be used as debug. considering commenting it out in solveHashSetsPrep for safety.
     */
    sign?: Shardus.Sign;
};
/**
 * some generic data that represents a vote for hash set comparison
 */
export type GenericHashSetEntry = {
    hash: string;
    votePower: number;
    hashSet: string;
    lastValue: string;
    errorStack: HashSetEntryError[];
    corrections: HashSetEntryCorrection[];
    /**
     * {string[]} owners a list of owner addresses that have this solution
    {boolean} ourRow
     */
    indexOffset: number;
    waitForIndex: number;
    waitedForThis?: boolean;
    /**
     * this gets added when you call expandIndexMapping. index map is our index to the solution output
     */
    indexMap?: number[];
    /**
     * this gets added when you call expandIndexMapping. extra map is the index in our list that is an extra
     */
    extraMap?: number[];
    futureIndex?: number;
    futureValue?: string;
    /**
     * current Pin index of this entry.. modified by solver.
     */
    pinIdx?: number;
    /**
     * the object/vote we are pinned to.  todo make this a export type!!
     */
    pinObj?: any;
    ownVotes?: any[];
};
/**
 * extends GenericHashSetEntry some generic data that represents a vote for hash set comparison
 */
export type IHashSetEntryPartitions = {
    /**
     * a list of owner addresses that have this solution
     */
    owners: string[];
    ourRow?: boolean;
    outRow?: boolean;
};
/**
 * newTXList, allAccountsToResetById, partitionId
 */
export type UpdateRepairData = {
    newTXList: Shardus.AcceptedTx[];
    allAccountsToResetById: {
        [x: string]: number;
    };
    partitionId: number;
    txIDToAcc: {
        [x: string]: {
            sourceKeys: string[];
            targetKeys: string[];
        };
    };
};
/**
 * an object to hold a temp tx record for processing later
 */
export type TempTxRecord = {
    txTS: number;
    acceptedTx: Shardus.AcceptedTx;
    passed: boolean;
    applyResponse: Shardus.ApplyResponse;
    /**
     * below 0 for not redacted. a value above zero indicates the cycle this was redacted
     */
    redacted: number;

    isGlobalModifyingTX: boolean;
    savedSomething: boolean;
};
/**
 * an object that tracks our TXs that we are storing for later.
 */
export type TxTallyList = {
    hashes: string[];
    /**
     * AcceptedTx?
     */
    passed: number[];
    txs: any[];
    processed: boolean;
    /**
     * below 0 for not redacted. a value above zero indicates the cycle this was redacted
     */
    states: any[];
    /**
     * this gets added on when we are reparing something newTxList seems to have a different format than existing types.
     */
    newTxList?: NewTXList;
};

export type NewTXList = { hashes: string[], passed: number[], txs: any[], thashes: string[], tpassed: number[], ttxs: any[], tstates: any[], states: any[], processed: boolean }



//export type Node = import("../shardus").Node;


// export type ShardGlobals = any;
// export type NodeShardData = any;
// export type ShardInfo = any;
// export type AddressRange = any;
// export type BasicAddressRange = any;
/**
 * a partition reciept that contains one copy of of the data and all of the signatures for that data
 */
export type CombinedPartitionReceipt = {
    /**
     * with signatures moved to a list
     */
    result: PartitionResult;
    signatures: Shardus.Sign[];
};
/**
 * an object to hold a temp tx record for processing later
 */
export type SolutionDelta = {
    /**
     * index into our request list: requestsByHost.requests
     */
    i: number;
    tx: Shardus.AcceptedTx;
    pf: number; // TSConversion was a boolean
    /**
     * a string snipped from our solution hash set
     */
    state: string;
};
export type HashSetEntryPartitions = GenericHashSetEntry & IHashSetEntryPartitions;
/**
 * some generic data that represents a vote for hash set comparison
 */
export type HashSetEntryCorrection = {
    /**
     * index
     */
    i: number;
    /**
     * top vote index
     */
    tv: Vote;
    /**
     * top vote value
     */
    v: string;
    /**
     * export type 'insert', 'extra'
     */
    t: string;
    /**
     * last value
     */
    bv: string;
    /**
     * lat output count?
     */
    if: number;
    /**
     * another index.
     */
    hi?: number;
    /**
     * reference to the correction that this one is replacing/overriding
     */
    c?: HashSetEntryCorrection;
};
/**
 * some generic data that represents a vote for hash set comparison
 */
export type HashSetEntryError = {
    /**
     * index
     */
    i: number;
    /**
     * top vote index
     */
    tv: Vote;
    /**
     * top vote value
     */
    v: string;
};
/**
 * vote for a value
 */
export type Vote = {
    /**
     * vote value
     */
    v: string;
    /**
     * number of votes
     */
    count: number;
    /**
     * reference to another vote object
     */
    vote?: CountEntry;
    /**
     * count based on vote power
     */
    ec?: number;
    /**
     * hashlist index of the voters for this vote
     */
    voters?: number[];
};

export type StringVoteObjectMap = {[vote:string]:Vote}

export type ExtendedVote = Vote & {
    winIdx: number|null;
    val:string;
    lowestIndex:number;
    voteTally: { i: number, p: number }[];  // number[] // { i: index, p: hashListEntry.votePower }
    votesseen: any;
    finalIdx: number;
}

export type StringExtendedVoteObjectMap = {[vote:string]:ExtendedVote}

//{ winIdx: null, val: v, count: 0, ec: 0, lowestIndex: index, voters: [], voteTally: Array(hashSetList.length), votesseen }

/**
 * vote count tracking
 */
export type CountEntry = {
    /**
     * number of votes
     */
    count: number;
    /**
     * count based on vote power
     */
    ec: number;
    /**
     * hashlist index of the voters for this vote
     */
    voters: number[];
};

export type StringCountEntryObjectMap = {[vote:string]:CountEntry}


//let accountCopy = { accountId: accountEntry.accountId, data: accountEntry.data, timestamp: accountEntry.timestamp, hash: accountEntry.stateId, cycleNumber }
export type AccountCopy = {
    accountId: string;
    data: any;
    timestamp: number;
    hash: string;
    cycleNumber: number;
    isGlobal: boolean
};

// AppliedVote
// The vote contains: [txid, [account_id], [account_state_hash_after], transaction_result, sign];

// where the
// result is the transaction result;
// the account_id array is sorted by account_id and
// the account_state_hash_after array is in corresponding order.
// The applied vote is sent even if the result is ‘fail’.

export type AppliedVoteCore = {
    txid: string;
    transaction_result: boolean;
    sign?: Shardus.Sign
}

// export type AppliedVote2 = {
//     coreVote: AppliedVoteCore;
//     account_id: string[];
//     account_state_hash_after: string[];
//     cant_apply: boolean; // indicates that the preapply could not give a pass or fail
//     sign?: Shardus.Sign
// };


export type AppliedVote = {
    txid: string;
    transaction_result: boolean;
    account_id: string[];
    //if we add hash state before then we could prove a dishonest apply vote
    //have to consider software version
    account_state_hash_after: string[];
    cant_apply: boolean;  // indicates that the preapply could not give a pass or fail
    node_id: string; // record the node that is making this vote.. todo could look this up from the sig later
    sign?: Shardus.Sign
};

// export type AppliedReceipt2 = {
//     vote: AppliedVoteCore;
//     signatures: Shardus.Sign[]
// };

//[txid, result, [applied_receipt]]
export type AppliedReceipt = {
    txid: string;
    result: boolean;
    appliedVotes: AppliedVote[]
};

// export type AppliedReceiptGossip2 = {
//     appliedReceipt: AppliedReceipt2
// };

//Transaction Related
export type TimeRangeandLimit = {tsStart:number, tsEnd:number, limit:number}
export type AccountAddressAndTimeRange = {accountStart:string, accountEnd:string, tsStart:number, tsEnd:number}
export type AccountRangeAndLimit = {accountStart:string, accountEnd:string, maxRecords:number}

export type AccountStateHashReq = AccountAddressAndTimeRange
export type AccountStateHashResp = {stateHash: string, ready:boolean};

export type GossipAcceptedTxRecv = {acceptedTX: Shardus.AcceptedTx, sender: Shardus.Node, tracker: string}


export type GetAccountStateReq = AccountAddressAndTimeRange & {stateTableBucketSize: number}

export type AcceptedTransactionsReq = TimeRangeandLimit
export type GetAccountDataReq = AccountRangeAndLimit

export type GetAccountData2Req = AccountAddressAndTimeRange & {maxRecords:number}

export type GetAccountData3Req = {accountStart:string, accountEnd:string, tsStart:number, maxRecords:number}
export type GetAccountData3Resp = { data: GetAccountDataByRangeSmart }

export type PosPartitionResults = { partitionResults: PartitionResult[]; Cycle_number: number; }

export type GetTransactionsByListReq = {Tx_ids:string[]}


export type TransactionsByPartitionReq = { cycle: number; tx_indicies: any; hash: string; partitionId: number; debugSnippets: any }
export type TransactionsByPartitionResp = { success: boolean; acceptedTX?: any; passFail?: any[]; statesList?: any[] }

export type GetPartitionTxidsReq = { Partition_id: any; Cycle_number: string }

export type RouteToHomeNodeReq = { txid: any; timestamp: any; acceptedTx: Shardus.AcceptedTx }

export type RequestStateForTxReq = { txid: string; timestamp: number; keys: any }
export type RequestStateForTxResp = { stateList: Shardus.WrappedResponse[]; beforeHashes: {[accountID:string]:string}; note: string; success:boolean }

export type RequestTxResp = { acceptedTX?:Shardus.AcceptedTx; stateList: Shardus.WrappedResponse[]; beforeHashes: {[accountID:string]:string}; note: string; success:boolean, originalData:{[accountID:string]:string} }


export type RequestReceiptForTxReq = { txid: string; timestamp: number; }
export type RequestReceiptForTxResp = { receipt:AppliedReceipt ; note: string; success:boolean }
//export type RequestStateForTxResp = { stateList: any[]; note: string; success:boolean }

export type RequestStateForTxReqPost = { txid: string; timestamp: number; key:string; hash:string }

export type GetAccountDataWithQueueHintsResp = { accountData: Shardus.WrappedDataFromQueue[] | null}

export type GlobalAccountReportResp = {ready:boolean, combinedHash:string, accounts:{id:string, hash:string, timestamp:number }[]  }

export type PreApplyAcceptedTransactionResult = { applied: boolean, passed: boolean, applyResult:string, reason:string, applyResponse? : Shardus.ApplyResponse }

export type CommitConsensedTransactionResult = { success: boolean }

// Sync related
export type StateHashResult = {stateHash:string}

export type WrappedStates = {[accountID:string]:Shardus.WrappedData}

//export type AccountFilter = {[accountID:string]:boolean}
export type AccountFilter = {[accountID:string]:number}
export type AccountBoolObjectMap = AccountFilter

export type WrappedResponses = {[accountID:string]:Shardus.WrappedResponse}

export type SimpleDistanceObject = {distance:number}
export type StringNodeObjectMap = {[accountID:string]:Shardus.Node}
export type AcceptedTxObjectById = {[txid:string]: Shardus.AcceptedTx}
//localCachedData, applyResponse
export type TxObjectById = AcceptedTxObjectById

export type TxIDToKeyObjectMap = {[accountID:string]:Shardus.TransactionKeys}
export type TxIDToSourceTargetObjectMap = {[accountID:string]:{ sourceKeys:string[], targetKeys:string[] }}
//fifoLocks

//wrappedData.isPartial

export type DebugDumpPartitionAccount = { id: string, hash: string, v: string }
export type DebugDumpNodesCovered = { idx: number, ipPort:string, id: string, fracID: number, hP: number, consensus: [], stored: [], extra: [], numP: number }
export type DebugDumpRangesCovered = { ipPort:string, id: string, fracID: number, hP: number, cMin: number, cMax: number, stMin: number, stMax: number, numP: number }
export type DebugDumpPartition = {parititionID:number, accounts:DebugDumpPartitionAccount[], skip:DebugDumpPartitionSkip, accounts2?: DebugDumpPartitionAccount[], partitionHash2?:string} // {[id:string]:string}
export type DebugDumpPartitionSkip = { p: number, min: number, max: number, noSpread?: boolean, inverted?:boolean }
export type DebugDumpPartitions =  { partitions: DebugDumpPartition[], cycle:number, rangesCovered:DebugDumpRangesCovered,nodesCovered:DebugDumpNodesCovered,allNodeIds:string[], globalAccountIDs:string[], globalAccountSummary:any[], globalStateHash:string, calculationTime:number }


//queue process related:
export type SeenAccounts = {[accountId:string]: (QueueEntry | null)}
export type LocalCachedData = {[accountId:string]:any }
//export type AllNewTXsById = {[accountId:string]: }
export type AccountValuesByKey = {[accountId:string]:any }

// repair related
export type StatusMap = {[txid:string]:number}
export type StateMap = {[txid:string]:string}
export type GetAccountDataByRangeSmart =  { wrappedAccounts:WrappedStateArray, lastUpdateNeeded:boolean, wrappedAccounts2:WrappedStateArray, highestTs:number, delta:number }

//generic relocate?
export type SignedObject = {sign: {owner:string}}
export type StringBoolObjectMap = {[key:string]:boolean}
export type StringNumberObjectMap = {[key:string]:number}
export type NumberStringObjectMap = {[index:number]:string}
export type StringStringObjectMap = {[key:string]:string}

export type FifoWaitingEntry = { id: number }
export type FifoLock = { fifoName:string, queueCounter: number, waitingList: FifoWaitingEntry[], lastServed: number, queueLocked: boolean, lockOwner: number }
export type FifoLockObjectMap = {[lockID:string]:FifoLock}

// export type ReceiptMap = {[txId:string] : string[]  }

// export type ReceiptMapResult = {
//     cycle:number;
//     partition:number;
//     receiptMap:ReceiptMap;
//     txCount:number
// }

// export type OpaqueBlob = any //Shardus is not supposed to know about the details of this, it is up to the dapp to define

// //Shardus wrapper for a summary blob.  Has information that is needed for the reduce algorithm
// export type SummaryBlob = {
//     latestCycle: number; //The highest cycle that was used in this summary.
//     counter:number;
//     errorNull:number;
//     partition:number;
//     opaqueBlob:OpaqueBlob;
// }

// //A collection of blobs that share the same cycle.  For TX summaries
// export type SummaryBlobCollection = {
//     cycle:number;
//     blobsByPartition:Map<number, SummaryBlob>;
// }

// // Stats collected for a cycle
// export type StatsClump = {
//     error:boolean;
//     cycle:number;
//     dataStats:SummaryBlob[];
//     txStats:SummaryBlob[];
//     covered:number[];
//     coveredParititionCount:number;
//     skippedParitionCount:number;
// }

// cache
// export type AccountMemoryCache = {
//     t: number;  //timestamp
//     h: string;  //hash.  todo, a compact form acceptable?
// }

export type AccountHashCache = {
    t: number;  //timestamp
    h: string;  //hash.  todo, a compact form acceptable?
    c: number;  //cycle number
    //p: number;  //partition -1 for global? --built into list.
}



// METHOD 2 stuff below here:

/**
 * History for a single account
 * Recent history, and a index to to the last list it was written to
 */
export type AccountHashCacheHistory = {
    lastSeenCycle: number;
    lastSeenSortIndex: number;
    queueIndex: SafeIndex;
    accountHashList: AccountHashCache[]
    lastStaleCycle: number;
    lastUpdateCycle: number;
}

export type SafeIndex = {
    id:number;
    idx:number;
}
/**
 * This list holds a list of different accounts
 */
export type AccountHashesForPartition = {
    partition: number;
    //note that these are also stored in the map.
    accountHashesSorted: AccountHashCache[]; // for current cycle. all account changes? (same account can occur multiple times) (option to fast remove on the go)
    accountIDs: string[]; // list of account IDs for validation parallel to the above data.
}

/**
 * This is the complete cache structure (old method 2)
 */
export type AccountHashCacheHistoryOld = {
    lastSeenCycle: number;
    lastSeenSortIndex: number;
    accountHashList: AccountHashCache[]
}
export type AccountHashCacheMain = {
    accountHashCacheByPartition: Map<number, AccountHashesForPartition>;
    accountHashMap: Map<string, AccountHashCacheHistoryOld>
}

export type AccountHashCacheList = {
    accountIDs: string[]; //index matches above list.
    accountHashesSorted: AccountHashCache[]; //sorted by timestamp. then by address
}

// METHOD 3 stuff below here:
export type AccountHashCacheMain3 = {
    currentCalculationCycle: number
    // accountHashesSorted: AccountHashCache[]; //sorted by timestamp. then by address
    // accountIDs: string[]; //index matches above list.
    workingHistoryList:AccountHashCacheList
    accountHashMap: Map<string, AccountHashCacheHistory>


    //queue stuff here that we are not ready for yet
    futureHistoryList:AccountHashCacheList
}


// export type AccountReport = {
//     id: string;  // id
//     h: string;  // hash
//     t: number; // timestamp
// }

export type PartitionHashResults = {
    partition: number;
    hashOfHashes: string;
    ids: string[]
    hashes: string[]
    timestamps: number[]
}

export type MainHashResults = {
    cycle:number
    partitionHashResults: Map<number, PartitionHashResults>;
}

export type PartitionCycleReportElement = {
    i : number; // partition id
    h : string; // partition hash
}

export type PartitionCycleReport = {
    res?: PartitionCycleReportElement[]
    cycleNumber? : number
}



// account hash trie.

export type TrieAccount = {
    accountID:string;
    hash:string;
    //cycle:number;
    //timestamp:number
    //todo merge with cache structures at some point
}

export type HashTrieNode = {
    radix: string; //node key
    hash: string;
    childHashes: string[]; //len16 array of child hashes
    children: HashTrieNode[]; // len 16  not on leaf nodes.

    isIncomplete: boolean;
    updated: boolean; // has this trie node or its children been updated

    accounts?: TrieAccount[]; //any length, sorted by id.  only on leaf nodes
    accountTempMap?: Map<string, TrieAccount>; //only on leaf nodes

    nonSparseChildCount:number
}

export type ShardedHashTrie = {
    layerMaps: Map<string, HashTrieNode>[]
}

export type HashTrieSyncConsensus = {
    cycle: number;
    radixHashVotes: Map<string, {
        allVotes:Map<string, {
            count:number,
            voters:Shardus.Node[]
        }>,
        bestHash:string,
        bestVotes:number

        }>;

    coverageMap: Map<string, HashTrieRadixCoverage>
    //repairByRadix //some info on who is helping with repairs.
}

export type HashTrieRadixCoverage = {
    firstChoice:Shardus.Node,
    fullList: Shardus.Node[],
    refuted: Set<string>;
}

export type HashTrieReq = {
    radixList: string[]
}

export type HashTrieResp = {
    nodeHashes: RadixAndHash[] //{radix:string, hash:string}[]

};

export type RadixAndHash = {
    radix:string;
    hash:string;
}
export type AccountIDAndHash = {
    accountID:string;
    hash:string;
}

//todo figure out why this failed
export enum PreTestStatus {
    Valid = 1,
    CantValidate,
    ValidationFailed,
  }

export type AccountPreTest = {
    accountID:string;
    hash:string;
    preTestStatus:PreTestStatus
}

export type HashTrieSyncTell = {
    cycle: number
    nodeHashes: {radix:string, hash:string}[]
}

export type RadixAndChildHashes = {
    radix:string
    childAccounts:AccountIDAndHash[]
}

export type HashTrieAccountsResp = {
    nodeChildHashes: RadixAndChildHashes[]
    stats: {
        matched:number,
        visisted:number,
        empty:number
    }
};

export type HashTrieAccountDataRequest = {
    cycle: number;
    accounts:AccountIDAndHash[];
}
export type HashTrieAccountDataResponse = {
    accounts: Shardus.WrappedData[];
    stateTableData: Shardus.StateTableObject[];
}


export type HashTrieUpdateStats = {
    leafsUpdated: number
    leafsCreated: number
    updatedNodesPerLevel: number[]
    hashedChildrenPerLevel:  number[]
    totalHashes: number
    //totalObjectsHashed: 0,
    totalNodesHashed: number
    totalAccountsHashed: number
    totalLeafs: number
  }


export type CycleDebugNotes = {
    repairs: number
    lateRepairs: number
    patchedAccounts: number
    badAccounts: number
    noRcptRepairs: number
}
