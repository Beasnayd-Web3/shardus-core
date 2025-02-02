import { CycleRecord } from '@shardus/types/build/src/p2p/CycleCreatorTypes'
import { Logger as log4jLogger } from 'log4js'
import StateManager from '.'
import Crypto from '../crypto'
import Logger, { logFlags } from '../logger'
import * as Comms from '../p2p/Comms'
import * as Context from '../p2p/Context'
import { P2PModuleContext as P2P } from '../p2p/Context'
import * as CycleChain from '../p2p/CycleChain'
import * as Self from '../p2p/Self'
import * as Shardus from '../shardus/shardus-types'
import { TimestampReceipt } from '../shardus/shardus-types'
import Storage from '../storage'
import * as utils from '../utils'
import { Ordering } from '../utils'
import { nestedCountersInstance } from '../utils/nestedCounters'
import Profiler, { cUninitializedSize, profilerInstance } from '../utils/profiler'
import ShardFunctions from './shardFunctions'
import {
  AppliedReceipt,
  AppliedReceipt2,
  AppliedVote,
  AppliedVoteHash,
  AppliedVoteQuery,
  AppliedVoteQueryResponse,
  ConfirmOrChallengeMessage,
  ConfirmOrChallengeQuery,
  ConfirmOrChallengeQueryResponse,
  GetAccountData3Req,
  GetAccountData3Resp,
  QueueEntry,
  RequestReceiptForTxReq,
  RequestReceiptForTxResp,
  WrappedResponses,
} from './state-manager-types'
import { shardusGetTime } from '../network'
import { robustQuery } from '../p2p/Utils'
import { SignedObject } from '@shardus/crypto-utils'
import { isDebugModeMiddleware } from '../network/debugMiddleware'

class TransactionConsenus {
  app: Shardus.App
  crypto: Crypto
  config: Shardus.StrictServerConfiguration
  profiler: Profiler

  logger: Logger
  p2p: P2P
  storage: Storage
  stateManager: StateManager

  mainLogger: log4jLogger
  fatalLogger: log4jLogger
  shardLogger: log4jLogger
  statsLogger: log4jLogger
  statemanager_fatal: (key: string, log: string) => void

  txTimestampCache: { [key: string | number]: { [key: string]: TimestampReceipt } }

  produceBadVote: boolean
  produceBadChallenge: boolean

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
    this.crypto = crypto
    this.app = app
    this.logger = logger
    this.config = config
    this.profiler = profiler
    this.p2p = p2p
    this.storage = storage
    this.stateManager = stateManager

    this.mainLogger = logger.getLogger('main')
    this.fatalLogger = logger.getLogger('fatal')
    this.shardLogger = logger.getLogger('shardDump')
    this.statsLogger = logger.getLogger('statsDump')
    this.statemanager_fatal = stateManager.statemanager_fatal
    this.txTimestampCache = {}

    this.produceBadVote = this.config.debug.produceBadVote
    this.produceBadChallenge = this.config.debug.produceBadChallenge
  }

  /***
   *    ######## ##    ## ########  ########   #######  #### ##    ## ########  ######
   *    ##       ###   ## ##     ## ##     ## ##     ##  ##  ###   ##    ##    ##    ##
   *    ##       ####  ## ##     ## ##     ## ##     ##  ##  ####  ##    ##    ##
   *    ######   ## ## ## ##     ## ########  ##     ##  ##  ## ## ##    ##     ######
   *    ##       ##  #### ##     ## ##        ##     ##  ##  ##  ####    ##          ##
   *    ##       ##   ### ##     ## ##        ##     ##  ##  ##   ###    ##    ##    ##
   *    ######## ##    ## ########  ##         #######  #### ##    ##    ##     ######
   */

  setupHandlers(): void {
    Context.network.registerExternalGet('debug-poq-switch', isDebugModeMiddleware, (_req, res) => {
      try {
        this.stateManager.transactionQueue.useNewPOQ = !this.stateManager.transactionQueue.useNewPOQ
        res.write(`this.useNewPOQ: ${this.stateManager.transactionQueue.useNewPOQ}\n`)
      } catch (e) {
        res.write(`${e}\n`)
      }
      res.end()
    })

    Context.network.registerExternalGet(
      'debug-poq-wait-before-confirm',
      isDebugModeMiddleware,
      (_req, res) => {
        try {
          const waitTimeBeforeConfirm = _req.query.waitTimeBeforeConfirm as string
          if (waitTimeBeforeConfirm && !isNaN(parseInt(waitTimeBeforeConfirm)))
            this.config.stateManager.waitTimeBeforeConfirm = parseInt(waitTimeBeforeConfirm)
          res.write(`stateManager.waitTimeBeforeConfirm: ${this.config.stateManager.waitTimeBeforeConfirm}\n`)
        } catch (e) {
          res.write(`${e}\n`)
        }
        res.end()
      }
    )

    Context.network.registerExternalGet(
      'debug-poq-wait-limit-confirm',
      isDebugModeMiddleware,
      (_req, res) => {
        try {
          const waitLimitAfterFirstVote = _req.query.waitLimitAfterFirstVote as string
          if (waitLimitAfterFirstVote && !isNaN(parseInt(waitLimitAfterFirstVote)))
            this.config.stateManager.waitLimitAfterFirstVote = parseInt(waitLimitAfterFirstVote)
          res.write(
            `stateManager.waitLimitAfterFirstVote: ${this.config.stateManager.waitLimitAfterFirstVote}\n`
          )
        } catch (e) {
          res.write(`${e}\n`)
        }
        res.end()
      }
    )

    Context.network.registerExternalGet(
      'debug-poq-wait-before-receipt',
      isDebugModeMiddleware,
      (_req, res) => {
        try {
          const waitTimeBeforeReceipt = _req.query.waitTimeBeforeReceipt as string
          if (waitTimeBeforeReceipt && !isNaN(parseInt(waitTimeBeforeReceipt)))
            this.config.stateManager.waitTimeBeforeReceipt = parseInt(waitTimeBeforeReceipt)
          res.write(`stateManager.waitTimeBeforeReceipt: ${this.config.stateManager.waitTimeBeforeReceipt}\n`)
        } catch (e) {
          res.write(`${e}\n`)
        }
        res.end()
      }
    )

    Context.network.registerExternalGet(
      'debug-poq-wait-limit-receipt',
      isDebugModeMiddleware,
      (_req, res) => {
        try {
          const waitLimitAfterFirstMessage = _req.query.waitLimitAfterFirstMessage as string
          if (waitLimitAfterFirstMessage && !isNaN(parseInt(waitLimitAfterFirstMessage)))
            this.config.stateManager.waitLimitAfterFirstMessage = parseInt(waitLimitAfterFirstMessage)
          res.write(
            `stateManager.waitLimitAfterFirstVote: ${this.config.stateManager.waitLimitAfterFirstMessage}\n`
          )
        } catch (e) {
          res.write(`${e}\n`)
        }
        res.end()
      }
    )

    Context.network.registerExternalGet('debug-produceBadVote', isDebugModeMiddleware, (req, res) => {
      this.produceBadVote = !this.produceBadVote
      res.json({ status: 'ok', produceBadVote: this.produceBadVote })
    })

    Context.network.registerExternalGet('debug-produceBadChallenge', isDebugModeMiddleware, (req, res) => {
      this.produceBadChallenge = !this.produceBadChallenge
      res.json({ status: 'ok', produceBadChallenge: this.produceBadChallenge })
    })

    this.p2p.registerInternal(
      'get_tx_timestamp',
      async (
        payload: { txId: string; cycleCounter: number; cycleMarker: string },
        respond: (arg0: Shardus.TimestampReceipt) => unknown
      ) => {
        const { txId, cycleCounter, cycleMarker } = payload
        /* eslint-disable security/detect-object-injection */
        if (this.txTimestampCache[cycleCounter] && this.txTimestampCache[cycleCounter][txId]) {
          await respond(this.txTimestampCache[cycleCounter][txId])
        } else {
          const tsReceipt: Shardus.TimestampReceipt = this.generateTimestampReceipt(
            txId,
            cycleMarker,
            cycleCounter
          )
          await respond(tsReceipt)
        }
        /* eslint-enable security/detect-object-injection */
      }
    )

    this.p2p.registerInternal(
      'get_confirm_or_challenge',
      async (payload: AppliedVoteQuery, respond: (arg0: ConfirmOrChallengeQuery) => unknown) => {
        nestedCountersInstance.countEvent('consensus', 'get_confirm_or_challenge')
        this.profiler.scopedProfileSectionStart('get_confirm_or_challenge', true)
        try {
          const { txId } = payload
          let queueEntry = this.stateManager.transactionQueue.getQueueEntrySafe(txId)
          if (queueEntry == null) {
            // It is ok to search the archive for this.  Not checking this was possibly breaking the gossip chain before
            queueEntry = this.stateManager.transactionQueue.getQueueEntryArchived(
              txId,
              'get_confirm_or_challenge'
            )
          }

          if (queueEntry == null) {
            /* prettier-ignore */ if (logFlags.error) this.mainLogger.error(`get_confirm_or_challenge no queue entry for ${payload.txId} dbg:${this.stateManager.debugTXHistory[utils.stringifyReduce(payload.txId)]}`)
            return
          }
          if (queueEntry.receivedBestConfirmation == null && queueEntry.receivedBestChallenge == null) {
            nestedCountersInstance.countEvent(
              'consensus',
              'get_confirm_or_challenge no confirmation or challenge'
            )
            /* prettier-ignore */ if (logFlags.error) this.mainLogger.error(`get_confirm_or_challenge no confirmation or challenge for ${queueEntry.logID}, bestVote: ${JSON.stringify(queueEntry.receivedBestVote)},  bestConfirmation: ${JSON.stringify(queueEntry.receivedBestConfirmation)}`)
            return
          }
          const waitedTime = shardusGetTime() - queueEntry.lastConfirmOrChallengeTimestamp
          const waitCompletionPercent = waitedTime / this.config.stateManager.waitTimeBeforeReceipt
          // late nodes should not respond to this request
          // if (waitCompletionPercent < 0.5) {
          //   nestedCountersInstance.countEvent(
          //     'consensus',
          //     'get_confirm_or_challenge wait completion: ' + waitCompletionPercent
          //   )
          //   nestedCountersInstance.countEvent('consensus', 'get_confirm_or_challenge still waiting messages')
          //   /* prettier-ignore */ if (logFlags.error) this.mainLogger.error(`get_confirm_or_challenge still accepting messages for ${queueEntry.logID}, bestVote: ${JSON.stringify(queueEntry.receivedBestVote)},  bestConfirmation: ${JSON.stringify(queueEntry.receivedBestConfirmation)}`)
          //   return
          // }
          const confirmOrChallengeResult: ConfirmOrChallengeQueryResponse = {
            txId,
            appliedVoteHash: queueEntry.receivedBestVoteHash
              ? queueEntry.receivedBestVoteHash
              : this.calculateVoteHash(queueEntry.receivedBestVote),
            result: queueEntry.receivedBestChallenge
              ? queueEntry.receivedBestChallenge
              : queueEntry.receivedBestConfirmation,
            uniqueCount: queueEntry.receivedBestChallenge ? queueEntry.uniqueChallengesCount : 1,
          }
          await respond(confirmOrChallengeResult)
        } catch (e) {
          if (logFlags.error) this.mainLogger.error(`get_confirm_or_challenge error ${e.message}`)
        } finally {
          this.profiler.scopedProfileSectionEnd('get_confirm_or_challenge')
          this.profiler.profileSectionEnd('get_confirm_or_challenge', true)
        }
      }
    )

    this.p2p.registerInternal(
      'get_applied_vote',
      async (payload: AppliedVoteQuery, respond: (arg0: AppliedVoteQueryResponse) => unknown) => {
        nestedCountersInstance.countEvent('consensus', 'get_applied_vote')
        const { txId } = payload
        let queueEntry = this.stateManager.transactionQueue.getQueueEntrySafe(txId)
        if (queueEntry == null) {
          // It is ok to search the archive for this.  Not checking this was possibly breaking the gossip chain before
          queueEntry = this.stateManager.transactionQueue.getQueueEntryArchived(txId, 'get_applied_vote')
        }

        if (queueEntry == null) {
          /* prettier-ignore */ if (logFlags.error) this.mainLogger.error(`get_applied_vote no queue entry for ${payload.txId} dbg:${this.stateManager.debugTXHistory[utils.stringifyReduce(payload.txId)]}`)
          return
        }
        if (queueEntry.receivedBestVote == null) {
          /* prettier-ignore */ if (logFlags.error) this.mainLogger.error(`get_applied_vote no receivedBestVote for ${payload.txId} dbg:${this.stateManager.debugTXHistory[utils.stringifyReduce(payload.txId)]}`)
          return
        }
        const appliedVote: AppliedVoteQueryResponse = {
          txId,
          appliedVote: queueEntry.receivedBestVote,
          appliedVoteHash: queueEntry.receivedBestVoteHash
            ? queueEntry.receivedBestVoteHash
            : this.calculateVoteHash(queueEntry.receivedBestVote),
        }
        await respond(appliedVote)
      }
    )

    Comms.registerGossipHandler(
      'gossip-applied-vote',
      async (payload: AppliedVote, sender: string, tracker: string) => {
        nestedCountersInstance.countEvent('consensus', 'gossip-applied-vote')
        profilerInstance.scopedProfileSectionStart('gossip-applied-vote', true)
        try {
          const queueEntry = this.stateManager.transactionQueue.getQueueEntrySafe(payload.txid) // , payload.timestamp)
          if (queueEntry == null) {
            return
          }
          const newVote = payload as AppliedVote
          const appendSuccessful = this.stateManager.transactionConsensus.tryAppendVote(queueEntry, newVote)

          if (appendSuccessful) {
            const gossipGroup = this.stateManager.transactionQueue.queueEntryGetTransactionGroup(queueEntry)
            if (gossipGroup.length > 1) {
              // should consider only forwarding in some cases?
              this.stateManager.debugNodeGroup(
                queueEntry.acceptedTx.txId,
                queueEntry.acceptedTx.timestamp,
                `share appliedVote to consensus nodes`,
                gossipGroup
              )
              Comms.sendGossip(
                'gossip-applied-vote',
                newVote,
                tracker,
                null,
                queueEntry.transactionGroup,
                false
              )
            }
          }
        } finally {
          profilerInstance.scopedProfileSectionEnd('gossip-applied-vote')
        }
      }
    )

    this.p2p.registerGossipHandler(
      'spread_appliedReceipt',
      async (
        payload: {
          txid: string
          result?: boolean
          appliedVotes?: AppliedVote[]
          app_data_hash?: string
        },
        tracker: string,
        msgSize: number
      ) => {
        nestedCountersInstance.countEvent('consensus', 'spread_appliedReceipt')
        profilerInstance.scopedProfileSectionStart('spread_appliedReceipt', false, msgSize)
        let respondSize = cUninitializedSize
        try {
          const appliedReceipt = payload as AppliedReceipt
          let queueEntry = this.stateManager.transactionQueue.getQueueEntrySafe(appliedReceipt.txid) // , payload.timestamp)
          if (queueEntry == null) {
            if (queueEntry == null) {
              // It is ok to search the archive for this.  Not checking this was possibly breaking the gossip chain before
              queueEntry = this.stateManager.transactionQueue.getQueueEntryArchived(
                payload.txid as string,
                'spread_appliedReceipt'
              ) // , payload.timestamp)
              if (queueEntry != null) {
                // TODO : PERF on a faster version we may just bail if this lives in the arcive list.
                // would need to make sure we send gossip though.
              }
            }
            if (queueEntry == null) {
              /* prettier-ignore */ if (logFlags.error) this.mainLogger.error(`spread_appliedReceipt no queue entry for ${appliedReceipt.txid} dbg:${this.stateManager.debugTXHistory[utils.stringifyReduce(payload.txid)]}`)
              // NEW start repair process that will find the TX then apply repairs
              // this.stateManager.transactionRepair.repairToMatchReceiptWithoutQueueEntry(appliedReceipt)
              return
            }
          }

          if (
            this.stateManager.testFailChance(
              this.stateManager.ignoreRecieptChance,
              'spread_appliedReceipt',
              utils.stringifyReduce(appliedReceipt.txid),
              '',
              logFlags.verbose
            ) === true
          ) {
            return
          }

          // TODO STATESHARDING4 ENDPOINTS check payload format
          // TODO STATESHARDING4 ENDPOINTS that this message is from a valid sender (may need to check docs)

          const receiptNotNull = appliedReceipt != null

          if (queueEntry.gossipedReceipt === false) {
            queueEntry.gossipedReceipt = true
            /* prettier-ignore */ if (logFlags.debug) this.mainLogger.debug(`spread_appliedReceipt update ${queueEntry.logID} receiptNotNull:${receiptNotNull}`)

            if (queueEntry.archived === false) {
              queueEntry.recievedAppliedReceipt = appliedReceipt
            }

            // I think we handle the negative cases later by checking queueEntry.recievedAppliedReceipt vs queueEntry.appliedReceipt

            // share the appliedReceipt.
            const sender = null
            const gossipGroup = this.stateManager.transactionQueue.queueEntryGetTransactionGroup(queueEntry)
            if (gossipGroup.length > 1) {
              // should consider only forwarding in some cases?
              this.stateManager.debugNodeGroup(
                queueEntry.acceptedTx.txId,
                queueEntry.acceptedTx.timestamp,
                `share appliedReceipt to neighbors`,
                gossipGroup
              )
              //no await so we cant get the message out size in a reasonable way
              respondSize = await this.p2p.sendGossipIn(
                'spread_appliedReceipt',
                appliedReceipt,
                tracker,
                sender,
                gossipGroup,
                false
              )
            }
          } else {
            // we get here if the receipt has already been shared
            /* prettier-ignore */ if (logFlags.debug) this.mainLogger.debug(`spread_appliedReceipt skipped ${queueEntry.logID} receiptNotNull:${receiptNotNull} Already Shared`)
          }
        } finally {
          profilerInstance.scopedProfileSectionEnd('spread_appliedReceipt', respondSize)
        }
      }
    )

    this.p2p.registerGossipHandler(
      'spread_appliedReceipt2',
      async (
        payload: {
          txid: string
          result?: boolean
          appliedVote?: AppliedVote
          signatures?: Shardus.Sign[]
          app_data_hash?: string
        },
        tracker: string,
        msgSize: number
      ) => {
        nestedCountersInstance.countEvent('consensus', 'spread_appliedReceipt2')
        profilerInstance.scopedProfileSectionStart('spread_appliedReceipt2', false, msgSize)
        const respondSize = cUninitializedSize
        try {
          const receivedAppliedReceipt2 = payload as AppliedReceipt2
          let queueEntry = this.stateManager.transactionQueue.getQueueEntrySafe(receivedAppliedReceipt2.txid) // , payload.timestamp)
          if (queueEntry == null) {
            if (queueEntry == null) {
              // It is ok to search the archive for this.  Not checking this was possibly breaking the gossip chain before
              queueEntry = this.stateManager.transactionQueue.getQueueEntryArchived(
                payload.txid as string,
                'spread_appliedReceipt2'
              ) // , payload.timestamp)
              if (queueEntry != null) {
                // TODO : PERF on a faster version we may just bail if this lives in the arcive list.
                // would need to make sure we send gossip though.
              }
            }
            if (queueEntry == null) {
              /* prettier-ignore */
              if (logFlags.error || this.stateManager.consensusLog)
                this.mainLogger.error(
                  `spread_appliedReceipt no queue entry for ${receivedAppliedReceipt2.txid} dbg:${
                    this.stateManager.debugTXHistory[utils.stringifyReduce(payload.txid)]
                  }`
                )
              // NEW start repair process that will find the TX then apply repairs
              // this.stateManager.transactionRepair.repairToMatchReceiptWithoutQueueEntry(receivedAppliedReceipt2)
              return
            }
          }

          if (
            this.stateManager.testFailChance(
              this.stateManager.ignoreRecieptChance,
              'spread_appliedReceipt2',
              utils.stringifyReduce(receivedAppliedReceipt2.txid),
              '',
              logFlags.verbose
            ) === true
          ) {
            return
          }

          // TODO STATESHARDING4 ENDPOINTS check payload format
          // TODO STATESHARDING4 ENDPOINTS that this message is from a valid sender (may need to check docs)

          const receiptNotNull = receivedAppliedReceipt2 != null

          if (queueEntry.state === 'expired') {
            //have we tried to repair this yet?
            const startRepair = queueEntry.repairStarted === false
            /* prettier-ignore */
            if (logFlags.debug || this.stateManager.consensusLog) this.mainLogger.debug(`spread_appliedReceipt2. tx expired. start repair:${startRepair}. update ${queueEntry.logID} receiptNotNull:${receiptNotNull}`);
            if (queueEntry.repairStarted === false) {
              nestedCountersInstance.countEvent('repair1', 'got receipt for expiredTX start repair')
              queueEntry.appliedReceiptForRepair2 = receivedAppliedReceipt2
              //todo any limits to how many repairs at once to allow?
              this.stateManager.getTxRepair().repairToMatchReceipt(queueEntry)
            }
            //x - dont forward gossip, it is probably too late?
            //do forward gossip so we dont miss on sharing a receipt!
            //return
          }

          let shouldStoreAndForward = false
          if (this.config.stateManager.useNewPOQ === false) {
            shouldStoreAndForward = queueEntry.gossipedReceipt === false
          } else {
            const localAppliedReceipt2 = queueEntry.appliedReceipt2
            if (localAppliedReceipt2) {
              const localReceiptConfirmNode = localAppliedReceipt2.confirmOrChallenge.nodeId
              const receivedReceiptConfirmNode = receivedAppliedReceipt2.confirmOrChallenge.nodeId
              if (localReceiptConfirmNode === receivedReceiptConfirmNode) {
                if (logFlags.debug)
                  this.mainLogger.debug(
                    `spread_appliedReceipt2 ${queueEntry.logID} we have the same receipt. We do not need to store and forward`
                  )
              } else {
                if (logFlags.debug)
                  this.mainLogger.debug(
                    `spread_appliedReceipt2 ${queueEntry.logID} we have different receipt ${
                      queueEntry.logID
                    }. localReceipt: ${utils.stringifyReduce(
                      localAppliedReceipt2
                    )}, receivedReceipt: ${utils.stringifyReduce(receivedAppliedReceipt2)}`
                  )
                const localReceiptRank = this.stateManager.transactionQueue.computeNodeRank(
                  localReceiptConfirmNode,
                  queueEntry.acceptedTx.txId,
                  queueEntry.acceptedTx.timestamp
                )
                const receivedReceiptRank = this.stateManager.transactionQueue.computeNodeRank(
                  receivedReceiptConfirmNode,
                  queueEntry.acceptedTx.txId,
                  queueEntry.acceptedTx.timestamp
                )
                if (receivedReceiptRank < localReceiptRank) {
                  shouldStoreAndForward = true
                  this.mainLogger.debug(
                    `spread_appliedReceipt2 ${queueEntry.logID} received receipt is better`
                  )
                }
              }
            } else {
              shouldStoreAndForward = true
              if (logFlags.debug)
                this.mainLogger.debug(
                  `spread_appliedReceipt2 ${queueEntry.logID} we do not have a local or received receipt generated. will store and forward`
                )
            }
          }

          if (shouldStoreAndForward === true && queueEntry.gossipedReceipt === false) {
            queueEntry.gossipedReceipt = true
            /* prettier-ignore */
            if (logFlags.debug || this.stateManager.consensusLog)
              this.mainLogger.debug(
                `spread_appliedReceipt2 update ${queueEntry.logID} receiptNotNull:${receiptNotNull}, appliedReceipt2: ${utils.stringifyReduce(receivedAppliedReceipt2)}`
              )

            if (queueEntry.archived === false) {
              queueEntry.recievedAppliedReceipt2 = receivedAppliedReceipt2
              queueEntry.appliedReceipt2 = receivedAppliedReceipt2 // is this necessary?
            }

            // I think we handle the negative cases later by checking queueEntry.recievedAppliedReceipt vs queueEntry.receivedAppliedReceipt2

            // share the receivedAppliedReceipt2.
            const sender = null
            const gossipGroup = this.stateManager.transactionQueue.queueEntryGetTransactionGroup(queueEntry)
            if (gossipGroup.length > 1) {
              // should consider only forwarding in some cases?
              this.stateManager.debugNodeGroup(
                queueEntry.acceptedTx.txId,
                queueEntry.acceptedTx.timestamp,
                `share appliedReceipt to neighbors`,
                gossipGroup
              )
              //no await so we cant get the message out size in a reasonable way
              this.p2p.sendGossipIn(
                'spread_appliedReceipt2',
                receivedAppliedReceipt2,
                tracker,
                sender,
                gossipGroup,
                false
              )
            }
          } else {
            // we get here if the receipt has already been shared
            /* prettier-ignore */ if (logFlags.debug) this.mainLogger.debug(`spread_appliedReceipt2 skipped ${queueEntry.logID} receiptNotNull:${receiptNotNull} Already Shared or shouldStoreAndForward:${shouldStoreAndForward}`)
          }
        } catch (ex) {
          this.statemanager_fatal(
            `spread_appliedReceipt2_ex`,
            'spread_appliedReceipt2 endpoint failed: ' + ex.name + ': ' + ex.message + ' at ' + ex.stack
          )
        } finally {
          profilerInstance.scopedProfileSectionEnd('spread_appliedReceipt2')
        }
      }
    )

    Comms.registerGossipHandler(
      'spread_confirmOrChallenge',
      (payload: ConfirmOrChallengeMessage, msgSize: number) => {
        nestedCountersInstance.countEvent('consensus', 'spread_confirmOrChallenge')
        profilerInstance.scopedProfileSectionStart('spread_confirmOrChallenge', false, msgSize)
        try {
          const queueEntry = this.stateManager.transactionQueue.getQueueEntrySafe(payload.appliedVote?.txid) // , payload.timestamp)
          if (queueEntry == null) {
            if (logFlags.error) {
              this.mainLogger.error(
                `spread_confirmOrChallenge no queue entry for ${payload.appliedVote?.txid} dbg:${
                  this.stateManager.debugTXHistory[utils.stringifyReduce(payload.appliedVote?.txid)]
                }`
              )
            }
            return
          }
          if (queueEntry.acceptConfirmOrChallenge === false) {
            if (logFlags.debug)
              this.mainLogger.debug(`spread_confirmOrChallenge ${queueEntry.logID} not accepting anymore`)
            return
          }

          const appendSuccessful = this.tryAppendMessage(queueEntry, payload)

          if (logFlags.debug)
            this.mainLogger.debug(
              `spread_confirmOrChallenge ${queueEntry.logID} appendSuccessful:${appendSuccessful}`
            )

          if (appendSuccessful) {
            // Gossip further
            const sender = null
            const gossipGroup = this.stateManager.transactionQueue.queueEntryGetTransactionGroup(queueEntry)
            Comms.sendGossip('spread_confirmOrChallenge', payload, '', sender, gossipGroup, false, 10)
            queueEntry.gossipedConfirmOrChallenge = true
          }
        } catch (e) {
          this.mainLogger.error(`Error in spread_confirmOrChallenge handler: ${e.message}`)
        } finally {
          profilerInstance.scopedProfileSectionEnd('spread_confirmOrChallenge', msgSize)
        }
      }
    )
  }

  generateTimestampReceipt(
    txId: string,
    cycleMarker: string,
    cycleCounter: CycleRecord['counter']
  ): TimestampReceipt {
    const tsReceipt: TimestampReceipt = {
      txId,
      cycleMarker,
      cycleCounter,
      // shardusGetTime() was replaced with shardusGetTime() so we can have a more reliable timestamp consensus
      timestamp: shardusGetTime(),
    }
    const signedTsReceipt = this.crypto.sign(tsReceipt)
    /* prettier-ignore */ if (logFlags.debug) this.mainLogger.debug(`Timestamp receipt generated for txId ${txId}: ${utils.stringifyReduce(signedTsReceipt)}`)

    // caching ts receipt for later nodes
    if (!this.txTimestampCache[signedTsReceipt.cycleCounter]) {
      this.txTimestampCache[signedTsReceipt.cycleCounter] = {}
    }
    // eslint-disable-next-line security/detect-object-injection
    this.txTimestampCache[signedTsReceipt.cycleCounter][txId] = signedTsReceipt
    return signedTsReceipt
  }

  pruneTxTimestampCache(): void {
    for (const key in this.txTimestampCache) {
      if (parseInt(key) + 1 < CycleChain.newest.counter) {
        // eslint-disable-next-line security/detect-object-injection
        delete this.txTimestampCache[key]
      }
    }
    if (logFlags.debug) this.mainLogger.debug(`Pruned tx timestamp cache.`)
  }

  async askTxnTimestampFromNode(
    tx: Shardus.OpaqueTransaction,
    txId: string
  ): Promise<Shardus.TimestampReceipt | null> {
    const homeNode = ShardFunctions.findHomeNode(
      Context.stateManager.currentCycleShardData.shardGlobals,
      txId,
      Context.stateManager.currentCycleShardData.parititionShardDataMap
    )
    const cycleMarker = CycleChain.computeCycleMarker(CycleChain.newest)
    const cycleCounter = CycleChain.newest.counter
    /* prettier-ignore */ if (logFlags.verbose) this.mainLogger.debug('Asking timestamp from node', homeNode.node)
    if (homeNode.node.id === Self.id) {
      // we generate the tx timestamp by ourselves
      return this.generateTimestampReceipt(txId, cycleMarker, cycleCounter)
    } else {
      const timestampReceipt = await Comms.ask(homeNode.node, 'get_tx_timestamp', {
        cycleMarker,
        cycleCounter,
        txId,
        tx,
      })
      if (!timestampReceipt) {
        if (logFlags.error) this.mainLogger.error('Unable to get timestamp receipt from home node')
        return null
      }

      delete timestampReceipt.isResponse
      const isValid = this.crypto.verify(timestampReceipt, homeNode.node.publicKey)
      if (isValid) {
        /* prettier-ignore */ if (logFlags.debug) this.mainLogger.debug(`Timestamp receipt received from home node. TxId: ${txId} isValid: ${isValid}, timestampReceipt: ${JSON.stringify(timestampReceipt)}`)
        return timestampReceipt
      } else {
        /* prettier-ignore */ if (logFlags.fatal) this.mainLogger.fatal(`Timestamp receipt received from home node ${homeNode.node.publicKey} is not valid. ${utils.stringifyReduce(timestampReceipt)}`)
        return null
      }
    }
  }

  /**
   * shareAppliedReceipt
   * gossip the appliedReceipt to the transaction group
   * @param queueEntry
   */
  async shareAppliedReceipt(queueEntry: QueueEntry): Promise<void> {
    /* prettier-ignore */ if (logFlags.verbose) if (logFlags.playback) this.logger.playbackLogNote('shrd_shareAppliedReceipt', `${queueEntry.logID}`, `qId: ${queueEntry.entryID} `)

    if (queueEntry.appliedReceipt2 == null) {
      //take no action
      /* prettier-ignore */ nestedCountersInstance.countEvent('transactionQueue', 'shareAppliedReceipt-skipped appliedReceipt2 == null')
      return
    }

    // share the appliedReceipt.
    const sender = null
    const gossipGroup = this.stateManager.transactionQueue.queueEntryGetTransactionGroup(queueEntry)

    // todo only recalc if cycle boundry?
    // let updatedGroup = this.stateManager.transactionQueue.queueEntryGetTransactionGroup(queueEntry, true)

    if (gossipGroup.length > 1) {
      if (queueEntry.ourNodeInTransactionGroup === false) {
        return
      }

      // This code tried to optimize things by not having every node share a receipt.

      // //look at our index in the consensus.
      // //only have certain nodes sharde gossip the receipt.
      // let ourIndex = queueEntry.ourTXGroupIndex
      // let groupLength = gossipGroup.length
      // if(this.stateManager.transactionQueue.executeInOneShard){
      //   //we have to use different inputs if executeInOneShard is true
      //   ourIndex = queueEntry.ourExGroupIndex
      //   groupLength = queueEntry.executionGroup.length
      // }

      // if(ourIndex > 0){
      //   let everyN = Math.max(1,Math.floor(groupLength * 0.4))
      //   let nonce = parseInt('0x' + queueEntry.acceptedTx.txId.substr(0,2))
      //   let idxPlusNonce = ourIndex + nonce
      //   let idxModEveryN = idxPlusNonce % everyN
      //   if(idxModEveryN > 0){
      //     nestedCountersInstance.countEvent('transactionQueue', 'shareAppliedReceipt-skipped')
      //     /* prettier-ignore */ if (logFlags.verbose) if (logFlags.playback) this.logger.playbackLogNote('shareAppliedReceipt-skipped', `${queueEntry.acceptedTx.txId}`, `ourIndex:${ourIndex} groupLength:${ourIndex} `)
      //     return
      //   }
      // }

      nestedCountersInstance.countEvent('transactionQueue', 'shareAppliedReceipt-notSkipped')
      // should consider only forwarding in some cases?
      this.stateManager.debugNodeGroup(
        queueEntry.acceptedTx.txId,
        queueEntry.acceptedTx.timestamp,
        `share appliedReceipt to neighbors`,
        gossipGroup
      )

      const payload = queueEntry.appliedReceipt2
      //let payload = queueEntry.recievedAppliedReceipt2 ?? queueEntry.appliedReceipt2
      this.p2p.sendGossipIn('spread_appliedReceipt2', payload, '', sender, gossipGroup, true)
    }
  }

  /**
   * hasAppliedReceiptMatchingPreApply
   * check if our data matches our vote
   * If the vote was for an appliable, on failed result then check if our local data
   * that is ready to be committed will match the receipt
   *
   * @param queueEntry
   */
  hasAppliedReceiptMatchingPreApply(queueEntry: QueueEntry, appliedReceipt: AppliedReceipt): boolean {
    // This is much easier than the old way
    if (queueEntry.ourVote) {
      const receipt = queueEntry.appliedReceipt2 ?? queueEntry.recievedAppliedReceipt2
      if (receipt != null && queueEntry.ourVoteHash != null) {
        const receiptVoteHash = this.calculateVoteHash(receipt.appliedVote)
        if (receiptVoteHash === queueEntry.ourVoteHash) {
          return true
        } else {
          /* prettier-ignore */ if (logFlags.debug) this.mainLogger.debug(`hasAppliedReceiptMatchingPreApply  ${queueEntry.logID} voteHashes do not match, ${receiptVoteHash} != ${queueEntry.ourVoteHash} `)
          return false
        }
      }
      return false
    }

    if (appliedReceipt == null) {
      return false
    }

    if (queueEntry.ourVote == null) {
      /* prettier-ignore */ if (logFlags.debug) this.mainLogger.debug(`hasAppliedReceiptMatchingPreApply  ${queueEntry.logID} ourVote == null`)
      return false
    }

    if (appliedReceipt != null) {
      if (appliedReceipt.result !== queueEntry.ourVote.transaction_result) {
        /* prettier-ignore */ if (logFlags.debug) this.mainLogger.debug(`hasAppliedReceiptMatchingPreApply  ${queueEntry.logID} ${appliedReceipt.result}, ${queueEntry.ourVote.transaction_result} appliedReceipt.result !== queueEntry.ourVote.transaction_result`)
        return false
      }
      if (appliedReceipt.txid !== queueEntry.ourVote.txid) {
        /* prettier-ignore */ if (logFlags.debug) this.mainLogger.debug(`hasAppliedReceiptMatchingPreApply  ${queueEntry.logID} appliedReceipt.txid !== queueEntry.ourVote.txid`)
        return false
      }
      if (appliedReceipt.appliedVotes.length === 0) {
        /* prettier-ignore */ if (logFlags.debug) this.mainLogger.debug(`hasAppliedReceiptMatchingPreApply  ${queueEntry.logID} appliedReceipt.appliedVotes.length == 0`)
        return false
      }

      if (appliedReceipt.appliedVotes[0].cant_apply === true) {
        // TODO STATESHARDING4 NEGATIVECASE    need to figure out what to do here
        /* prettier-ignore */ if (logFlags.debug) this.mainLogger.debug(`hasAppliedReceiptMatchingPreApply  ${queueEntry.logID} appliedReceipt.appliedVotes[0].cant_apply === true`)
        //If the network votes for cant_apply then we wouldn't need to patch.  We return true here
        //but outside logic will have to know to check cant_apply flag and make sure to not commit data
        return true
      }

      //we return true for a false receipt because there is no need to repair our data to match the receipt
      //it is already checked above if we matched the result
      if (appliedReceipt.result === false) {
        /* prettier-ignore */ if (logFlags.debug) this.mainLogger.debug(`hasAppliedReceiptMatchingPreApply  ${queueEntry.logID} result===false Good Match`)
        return true
      }

      //test our data against a winning vote in the receipt
      let wrappedStates = this.stateManager.useAccountWritesOnly ? {} : queueEntry.collectedData

      let wrappedStateKeys = Object.keys(queueEntry.collectedData)
      const vote = appliedReceipt.appliedVotes[0] //all votes are equivalent, so grab the first

      // Iff we have accountWrites, then overwrite the keys and wrapped data
      const appOrderedKeys = []
      const writtenAccountsMap: WrappedResponses = {}
      const applyResponse = queueEntry?.preApplyTXResult?.applyResponse
      if (applyResponse.accountWrites != null && applyResponse.accountWrites.length > 0) {
        for (const wrappedAccount of applyResponse.accountWrites) {
          appOrderedKeys.push(wrappedAccount.accountId)
          writtenAccountsMap[wrappedAccount.accountId] = wrappedAccount.data
        }
        wrappedStateKeys = appOrderedKeys
        //override wrapped states with writtenAccountsMap which should be more complete if it included
        wrappedStates = writtenAccountsMap
      }

      // Not sure if we should keep this.  it may only come up in error cases that would not be using final data in the repair?
      //If we are not in the execution home then use data that was sent to us for the commit
      // if(queueEntry.globalModification === false && this.stateManager.transactionQueue.executeInOneShard && queueEntry.isInExecutionHome === false){
      //   wrappedStates = {}
      //   let timestamp = queueEntry.acceptedTx.timestamp
      //   for(let key of Object.keys(queueEntry.collectedFinalData)){
      //     let finalAccount = queueEntry.collectedFinalData[key]
      //     let accountId = finalAccount.accountId
      //     let prevStateCalc = wrappedStates[accountId] ? wrappedStates[accountId].stateId : ''
      //     /* prettier-ignore */ if (logFlags.verbose) this.mainLogger.debug(`hasAppliedReceiptMatchingPreApply collectedFinalData tx:${queueEntry.logID} ts:${timestamp} ${utils.makeShortHash(finalAccount)} preveStateID: ${finalAccount.prevStateId } vs expected: ${prevStateCalc}`)

      //     wrappedStates[key] = finalAccount
      //   }
      //   /* prettier-ignore */ if (logFlags.verbose) this.mainLogger.debug(`hasAppliedReceiptMatchingPreApply collectedFinalData tx:${queueEntry.logID} ts:${timestamp} accounts: ${utils.stringifyReduce(Object.keys(wrappedStates))}  `)
      // }

      for (let j = 0; j < vote.account_id.length; j++) {
        /* eslint-disable security/detect-object-injection */
        const id = vote.account_id[j]
        const hash = vote.account_state_hash_after[j]
        let found = false
        for (const key of wrappedStateKeys) {
          const wrappedState = wrappedStates[key]
          if (wrappedState.accountId === id) {
            found = true
            // I don't believe this leaks timing info over the net
            // eslint-disable-next-line security/detect-possible-timing-attacks
            if (wrappedState.stateId !== hash) {
              /* prettier-ignore */ if (logFlags.debug) this.mainLogger.debug(`hasAppliedReceiptMatchingPreApply  ${queueEntry.logID} state does not match id:${utils.stringifyReduce(id)} hash:${utils.stringifyReduce(wrappedState.stateId)} votehash:${utils.stringifyReduce(hash)}`)
              return false
            }
          }
        }
        if (found === false) {
          /* prettier-ignore */ if (logFlags.debug) this.mainLogger.debug(`hasAppliedReceiptMatchingPreApply  ${queueEntry.logID} state does not match missing id:${utils.stringifyReduce(id)} `)
          /* prettier-ignore */ if (logFlags.debug) this.mainLogger.debug(`hasAppliedReceiptMatchingPreApply  ${queueEntry.logID} collectedData:${utils.stringifyReduce(Object.keys(queueEntry.collectedData))} `)

          return false
        }
        /* eslint-enable security/detect-object-injection */
      }

      /* prettier-ignore */ if (logFlags.debug) this.mainLogger.debug(`hasAppliedReceiptMatchingPreApply  ${queueEntry.logID} Good Match`)
      /* prettier-ignore */ if (logFlags.playback) this.logger.playbackLogNote('hasAppliedReceiptMatchingPreApply', `${queueEntry.logID}`, `  Good Match`)
    }

    return true
  }

  /**
   * tryProduceReceipt
   * try to produce an AppliedReceipt
   * if we can't do that yet return null
   *
   * @param queueEntry
   */
  async tryProduceReceipt(queueEntry: QueueEntry): Promise<AppliedReceipt> {
    this.profiler.profileSectionStart('tryProduceReceipt')
    if (logFlags.profiling_verbose) this.profiler.scopedProfileSectionStart('tryProduceReceipt')
    try {
      if (queueEntry.waitForReceiptOnly === true) {
        if (logFlags.debug)
          this.mainLogger.debug(`tryProduceReceipt ${queueEntry.logID} waitForReceiptOnly === true`)
        nestedCountersInstance.countEvent(`consensus`, 'tryProduceReceipt waitForReceiptOnly === true')
        return null
      }

      // TEMP hack.. allow any node to try and make a receipt
      // if (this.stateManager.transactionQueue.executeInOneShard && queueEntry.isInExecutionHome === false) {
      //   return null
      // }

      if (queueEntry.appliedReceipt != null) {
        nestedCountersInstance.countEvent(`consensus`, 'tryProduceReceipt appliedReceipt != null')
        return queueEntry.appliedReceipt
      }

      if (queueEntry.queryingRobustConfirmOrChallenge === true) {
        nestedCountersInstance.countEvent(
          `consensus`,
          'tryProduceReceipt in the middle of robust query confirm or challenge'
        )
        return null
      }

      // Design TODO:  should this be the full transaction group or just the consensus group?
      let votingGroup

      if (
        this.stateManager.transactionQueue.executeInOneShard &&
        this.stateManager.transactionQueue.useNewPOQ === false
      ) {
        //use execuiton group instead of full transaciton group, since only the execution group will run the transaction
        votingGroup = queueEntry.executionGroup
      } else {
        votingGroup = this.stateManager.transactionQueue.queueEntryGetTransactionGroup(queueEntry)
      }

      if (this.stateManager.transactionQueue.useNewPOQ === false) {
        const requiredVotes = Math.round(votingGroup.length * (2 / 3.0)) //hacky for now.  debug code:

        if (queueEntry.debug.loggedStats1 == null) {
          queueEntry.debug.loggedStats1 = true
          nestedCountersInstance.countEvent('transactionStats', ` votingGroup:${votingGroup.length}`)
        }

        const numVotes = queueEntry.collectedVoteHashes.length

        if (numVotes < requiredVotes) {
          // we need more votes
          return null
        }

        // be smart an only recalculate votes when we see a new vote show up.
        if (queueEntry.newVotes === false) {
          return null
        }
        queueEntry.newVotes = false
        let mostVotes = 0
        let winningVoteHash: string
        const hashCounts: Map<string, number> = new Map()

        for (let i = 0; i < numVotes; i++) {
          // eslint-disable-next-line security/detect-object-injection
          const currentVote = queueEntry.collectedVoteHashes[i]
          const voteCount = hashCounts.get(currentVote.voteHash)
          let updatedVoteCount: number
          if (voteCount === undefined) {
            updatedVoteCount = 1
          } else {
            updatedVoteCount = voteCount + 1
          }
          hashCounts.set(currentVote.voteHash, updatedVoteCount)
          if (updatedVoteCount > mostVotes) {
            mostVotes = updatedVoteCount
            winningVoteHash = currentVote.voteHash
          }
        }

        if (mostVotes < requiredVotes) {
          return null
        }

        if (winningVoteHash != undefined) {
          //make the new receipt.
          const appliedReceipt2: AppliedReceipt2 = {
            txid: queueEntry.acceptedTx.txId,
            result: undefined,
            appliedVote: undefined,
            confirmOrChallenge: null,
            signatures: [],
            app_data_hash: '',
            // transaction_result: false //this was missing before..
          }
          for (let i = 0; i < numVotes; i++) {
            // eslint-disable-next-line security/detect-object-injection
            const currentVote = queueEntry.collectedVoteHashes[i]
            if (currentVote.voteHash === winningVoteHash) {
              appliedReceipt2.signatures.push(currentVote.sign)
            }
          }
          //result and appliedVote must be set using a winning vote..
          //we may not have this yet

          if (queueEntry.ourVote != null && queueEntry.ourVoteHash === winningVoteHash) {
            appliedReceipt2.result = queueEntry.ourVote.transaction_result
            appliedReceipt2.appliedVote = queueEntry.ourVote
            // now send it !!!

            queueEntry.appliedReceipt2 = appliedReceipt2

            for (let i = 0; i < queueEntry.ourVote.account_id.length; i++) {
              /* eslint-disable security/detect-object-injection */
              if (queueEntry.ourVote.account_id[i] === 'app_data_hash') {
                appliedReceipt2.app_data_hash = queueEntry.ourVote.account_state_hash_after[i]
                break
              }
              /* eslint-enable security/detect-object-injection */
            }

            //this is a temporary hack to reduce the ammount of refactor needed.
            const appliedReceipt: AppliedReceipt = {
              txid: queueEntry.acceptedTx.txId,
              result: queueEntry.ourVote.transaction_result,
              appliedVotes: [queueEntry.ourVote],
              confirmOrChallenge: [],
              app_data_hash: appliedReceipt2.app_data_hash,
            }
            queueEntry.appliedReceipt = appliedReceipt

            return appliedReceipt
          }
        }
      } else {
        if (queueEntry.completedConfirmedOrChallenge === false) {
          nestedCountersInstance.countEvent('consensus', 'tryProduceReceipt still in confirm/challenge stage')
          return
        }
        const now = shardusGetTime()
        const timeSinceLastConfirmOrChallenge =
          queueEntry.lastConfirmOrChallengeTimestamp > 0
            ? now - queueEntry.lastConfirmOrChallengeTimestamp
            : 0
        const timeSinceFirstMessage =
          queueEntry.firstConfirmOrChallengeTimestamp > 0
            ? now - queueEntry.firstConfirmOrChallengeTimestamp
            : 0
        const hasWaitedLongEnough =
          timeSinceLastConfirmOrChallenge >= this.config.stateManager.waitTimeBeforeReceipt
        const hasWaitLimitReached =
          timeSinceFirstMessage >= this.config.stateManager.waitLimitAfterFirstMessage
        if (logFlags.debug)
          this.mainLogger.debug(
            `tryProduceReceipt: ${queueEntry.logID} hasWaitedLongEnough: ${hasWaitedLongEnough}, hasWaitLimitReached: ${hasWaitLimitReached}, timeSinceLastConfirmOrChallenge: ${timeSinceLastConfirmOrChallenge} ms, timeSinceFirstMessage: ${timeSinceFirstMessage} ms`
          )
        // check if last vote confirm/challenge received is waitTimeBeforeReceipt ago
        if (timeSinceLastConfirmOrChallenge >= this.config.stateManager.waitTimeBeforeReceipt) {
          // stop accepting the vote messages, confirm or challenge for this tx
          queueEntry.acceptConfirmOrChallenge = false
          nestedCountersInstance.countEvent('consensus', 'tryProduceReceipt hasWaitedLongEnough: true')
          if (logFlags.debug)
            this.mainLogger.debug(
              `tryProduceReceipt: ${queueEntry.logID} stopped accepting confirm/challenge messages`
            )

          if (logFlags.debug) {
            this.mainLogger.debug(
              `tryProduceReceipt: ${
                queueEntry.logID
              } ready to decide final receipt. bestReceivedChallenge: ${utils.stringifyReduce(
                queueEntry.receivedBestChallenge
              )}, bestReceivedConfirmation: ${utils.stringifyReduce(
                queueEntry.receivedBestConfirmation
              )}, receivedBestConfirmedNode: ${utils.stringifyReduce(queueEntry.receivedBestConfirmedNode)}`
            )
          }

          if (this.stateManager.consensusLog) {
            this.mainLogger.debug(`tryProduceReceipt: ${queueEntry.logID} ready to decide final receipt.`)
            this.mainLogger.debug(
              `tryProduceReceipt: ${queueEntry.logID} uniqueChallengesCount: ${queueEntry.uniqueChallengesCount}`
            )
          }

          // we have received challenge message, produce failed receipt
          if (
            queueEntry.receivedBestChallenge &&
            queueEntry.receivedBestChallenger &&
            queueEntry.uniqueChallengesCount >= this.config.stateManager.minRequiredChallenges
          ) {
            const appliedReceipt: AppliedReceipt = {
              txid: queueEntry.receivedBestChallenge.appliedVote.txid,
              result: false,
              appliedVotes: [queueEntry.receivedBestChallenge.appliedVote],
              confirmOrChallenge: [queueEntry.receivedBestChallenge],
              app_data_hash: queueEntry.receivedBestChallenge.appliedVote.app_data_hash,
            }
            const appliedReceipt2: AppliedReceipt2 = {
              txid: queueEntry.receivedBestChallenge.appliedVote.txid,
              result: false,
              appliedVote: queueEntry.receivedBestChallenge.appliedVote,
              confirmOrChallenge: queueEntry.receivedBestChallenge,
              app_data_hash: queueEntry.receivedBestChallenge.appliedVote.app_data_hash,
              signatures: [queueEntry.receivedBestChallenge.appliedVote.sign],
            }
            if (logFlags.debug)
              this.mainLogger.debug(
                `tryProduceReceipt: ${
                  queueEntry.logID
                } producing a fail receipt based on received challenge message. appliedReceipt: ${utils.stringifyReduce(
                  appliedReceipt2
                )}`
              )

            const robustQueryResult = await this.robustQueryConfirmOrChallenge(queueEntry)
            const robustConfirmOrChallenge = robustQueryResult?.result
            const robustUniqueCount = robustQueryResult?.uniqueCount
            if (this.stateManager.consensusLog) {
              this.mainLogger.debug(
                `tryProduceReceipt: ${queueEntry.logID} robustChallenge: ${utils.stringifyReduce(
                  robustConfirmOrChallenge
                )}, robustUniqueCount: ${robustUniqueCount}`
              )
            }
            if (robustConfirmOrChallenge == null) {
              nestedCountersInstance.countEvent(
                'consensus',
                'tryProduceReceipt robustQueryConfirmOrChallenge challenge failed'
              )
              if (logFlags.debug)
                this.mainLogger.debug(
                  `tryProduceReceipt: ${queueEntry.logID} failed to query robust confirm/challenge`
                )
              return
            }

            // Received a confrim receipt. We have a challenge receipt which is better.
            if (robustConfirmOrChallenge && robustConfirmOrChallenge.message === 'confirm') {
              if (logFlags.debug)
                this.mainLogger.debug(
                  `tryProduceReceipt: ${queueEntry.logID} received a confirm message. We have enough challenge messages which is better`
                )
              queueEntry.appliedReceipt = appliedReceipt
              queueEntry.appliedReceipt2 = appliedReceipt2
              return appliedReceipt
            }

            // Received another challenge receipt. Compare ranks
            let bestNodeFromRobustQuery: Shardus.NodeWithRank
            if (queueEntry.executionGroupMap.has(robustConfirmOrChallenge.appliedVote.node_id)) {
              bestNodeFromRobustQuery = queueEntry.executionGroupMap.get(
                robustConfirmOrChallenge.appliedVote.node_id
              ) as Shardus.NodeWithRank
            }
            const isRobustQueryNodeBetter =
              bestNodeFromRobustQuery.rank < queueEntry.receivedBestChallenger.rank
            if (
              isRobustQueryNodeBetter &&
              robustUniqueCount >= this.config.stateManager.minRequiredChallenges
            ) {
              nestedCountersInstance.countEvent(
                'consensus',
                'tryProduceReceipt robustQueryConfirmOrChallenge is better'
              )
              if (logFlags.debug)
                this.mainLogger.debug(
                  `tryProduceReceipt: ${
                    queueEntry.logID
                  } challenge from robust query is better than our challenge. robustQueryConfirmOrChallenge: ${utils.stringify(
                    robustConfirmOrChallenge
                  )}`
                )
              const robustReceipt: AppliedReceipt = {
                txid: robustConfirmOrChallenge.appliedVote.txid,
                result: robustConfirmOrChallenge.appliedVote.transaction_result,
                appliedVotes: [robustConfirmOrChallenge.appliedVote],
                confirmOrChallenge: [robustConfirmOrChallenge],
                app_data_hash: robustConfirmOrChallenge.appliedVote.app_data_hash,
              }
              const robustReceipt2: AppliedReceipt2 = {
                txid: robustConfirmOrChallenge.appliedVote.txid,
                result: robustConfirmOrChallenge.appliedVote.transaction_result,
                appliedVote: robustConfirmOrChallenge.appliedVote,
                confirmOrChallenge: robustConfirmOrChallenge,
                app_data_hash: robustConfirmOrChallenge.appliedVote.app_data_hash,
                signatures: [robustConfirmOrChallenge.appliedVote.sign],
              }
              queueEntry.appliedReceipt = robustReceipt
              queueEntry.appliedReceipt2 = robustReceipt2
              return robustReceipt
            } else {
              nestedCountersInstance.countEvent(
                'consensus',
                'tryProduceReceipt robustQueryConfirmOrChallenge is NOT better'
              )
              queueEntry.appliedReceipt = appliedReceipt
              queueEntry.appliedReceipt2 = appliedReceipt2
              return appliedReceipt
            }
          }

          // create receipt
          // The receipt for the transactions is the lowest ranked challenge message or if there is no challenge the lowest ranked confirm message
          // loop through "confirm" messages and "challenge" messages to decide the final receipt
          if (queueEntry.receivedBestConfirmation && queueEntry.receivedBestConfirmedNode) {
            const winningVote = queueEntry.receivedBestConfirmation.appliedVote
            const appliedReceipt: AppliedReceipt = {
              txid: winningVote.txid,
              result: winningVote.transaction_result,
              appliedVotes: [winningVote],
              confirmOrChallenge: [queueEntry.receivedBestConfirmation],
              app_data_hash: winningVote.app_data_hash,
            }
            const appliedReceipt2: AppliedReceipt2 = {
              txid: winningVote.txid,
              result: winningVote.transaction_result,
              appliedVote: winningVote,
              confirmOrChallenge: queueEntry.receivedBestConfirmation,
              app_data_hash: winningVote.app_data_hash,
              signatures: [winningVote.sign],
            }
            if (logFlags.debug || this.stateManager.consensusLog)
              this.mainLogger.debug(
                `tryProduceReceipt: ${queueEntry.logID} producing a confirm receipt based on received confirmation message.`
              )
            for (let i = 0; i < winningVote.account_id.length; i++) {
              /* eslint-disable security/detect-object-injection */
              if (winningVote.account_id[i] === 'app_data_hash') {
                appliedReceipt.app_data_hash = winningVote.account_state_hash_after[i]
                appliedReceipt2.app_data_hash = winningVote.account_state_hash_after[i]
                break
              }
              /* eslint-enable security/detect-object-injection */
            }
            // do a robust query to confirm that we have the best receipt
            // (lower the rank of confirm message, the better the receipt is)
            const robustQueryResult = await this.robustQueryConfirmOrChallenge(queueEntry)
            const robustConfirmOrChallenge = robustQueryResult?.result

            if (this.stateManager.consensusLog) {
              this.mainLogger.debug(
                `tryProduceReceipt: ${queueEntry.logID} robustConfirmOrChallenge: ${utils.stringifyReduce(
                  robustConfirmOrChallenge
                )}`
              )
            }

            if (robustConfirmOrChallenge == null || robustConfirmOrChallenge.message == null) {
              nestedCountersInstance.countEvent(
                'consensus',
                'tryProduceReceipt robustQueryConfirmOrChallenge confirm failed'
              )
              if (logFlags.debug || this.stateManager.consensusLog)
                this.mainLogger.debug(
                  `tryProduceReceipt: ${queueEntry.logID} failed to query best challenge/message from robust query`
                )
              return // this will prevent OOS
            }

            // Received challenge receipt, we have confirm receipt which is not as strong as challenge receipt
            if (robustConfirmOrChallenge.message === 'challenge') {
              nestedCountersInstance.countEvent(
                'consensus',
                'tryProduceReceipt robustQueryConfirmOrChallenge is challenge, we have confirmation'
              )
              const robustReceipt: AppliedReceipt = {
                txid: robustConfirmOrChallenge.appliedVote.txid,
                result: robustConfirmOrChallenge.appliedVote.transaction_result,
                appliedVotes: [robustConfirmOrChallenge.appliedVote],
                confirmOrChallenge: [robustConfirmOrChallenge],
                app_data_hash: robustConfirmOrChallenge.appliedVote.app_data_hash,
              }
              const robustReceipt2: AppliedReceipt2 = {
                txid: robustConfirmOrChallenge.appliedVote.txid,
                result: robustConfirmOrChallenge.appliedVote.transaction_result,
                appliedVote: robustConfirmOrChallenge.appliedVote,
                confirmOrChallenge: robustConfirmOrChallenge,
                app_data_hash: robustConfirmOrChallenge.appliedVote.app_data_hash,
                signatures: [robustConfirmOrChallenge.appliedVote.sign],
              }
              queueEntry.appliedReceipt = robustReceipt
              queueEntry.appliedReceipt2 = robustReceipt2
              return robustReceipt
            }

            // Received another confirm receipt. Compare ranks
            let bestNodeFromRobustQuery: Shardus.NodeWithRank
            if (queueEntry.executionGroupMap.has(robustConfirmOrChallenge.appliedVote.node_id)) {
              bestNodeFromRobustQuery = queueEntry.executionGroupMap.get(
                robustConfirmOrChallenge.appliedVote.node_id
              ) as Shardus.NodeWithRank
            }

            const isRobustQueryNodeBetter = bestNodeFromRobustQuery.rank < queueEntry.receivedBestVoter.rank
            if (isRobustQueryNodeBetter) {
              nestedCountersInstance.countEvent(
                'consensus',
                'tryProduceReceipt robustQueryConfirmOrChallenge is better'
              )
              if (this.stateManager.consensusLog) {
                this.mainLogger.debug(
                  `tryProducedReceipt: ${
                    queueEntry.logID
                  } robust confirmation result is better. ${utils.stringifyReduce(robustConfirmOrChallenge)}`
                )
              }
              if (logFlags.debug)
                this.mainLogger.debug(
                  `tryProduceReceipt: ${
                    queueEntry.logID
                  } confirmation from robust query is better than our confirm. bestNodeFromRobust?Query: ${utils.stringify(
                    bestNodeFromRobustQuery
                  )}, queueEntry.receivedBestVoter: ${utils.stringify(
                    queueEntry.receivedBestVoter
                  )}, robustQueryConfirmOrChallenge: ${utils.stringify(robustConfirmOrChallenge)}`
                )
              const robustReceipt: AppliedReceipt = {
                txid: robustConfirmOrChallenge.appliedVote.txid,
                result: robustConfirmOrChallenge.appliedVote.transaction_result,
                appliedVotes: [robustConfirmOrChallenge.appliedVote],
                confirmOrChallenge: [robustConfirmOrChallenge],
                app_data_hash: robustConfirmOrChallenge.appliedVote.app_data_hash,
              }
              const robustReceipt2: AppliedReceipt2 = {
                txid: robustConfirmOrChallenge.appliedVote.txid,
                result: robustConfirmOrChallenge.appliedVote.transaction_result,
                appliedVote: robustConfirmOrChallenge.appliedVote,
                confirmOrChallenge: robustConfirmOrChallenge,
                app_data_hash: robustConfirmOrChallenge.appliedVote.app_data_hash,
                signatures: [robustConfirmOrChallenge.appliedVote.sign],
              }
              queueEntry.appliedReceipt = robustReceipt
              queueEntry.appliedReceipt2 = robustReceipt2
              return robustReceipt
            } else {
              if (this.stateManager.consensusLog) {
                this.mainLogger.debug(
                  `tryProducedReceipt: ${queueEntry.logID} robust challenge result is NOT better. Using our best received confirmation`
                )
              }
              queueEntry.appliedReceipt = appliedReceipt
              queueEntry.appliedReceipt2 = appliedReceipt2
              return queueEntry.appliedReceipt
            }
          } else {
            nestedCountersInstance.countEvent(
              'consensus',
              'tryProduceReceipt waitedEnough: true. no confirm or challenge received'
            )
            return null
          }
        } else {
          if (logFlags.debug)
            this.mainLogger.debug(
              `tryProduceReceipt: ${queueEntry.logID} not producing receipt yet because timeSinceLastConfirmOrChallenge is ${timeSinceLastConfirmOrChallenge} ms`
            )
        }
      }
      return null
    } catch (e) {
      this.mainLogger.error(`tryProduceReceipt: ${queueEntry.logID} error: ${e.message}`)
    } finally {
      if (logFlags.profiling_verbose) this.profiler.scopedProfileSectionEnd('tryProduceReceipt')
      this.profiler.profileSectionEnd('tryProduceReceipt')
    }
  }

  async robustQueryBestReceipt(queueEntry: QueueEntry): Promise<AppliedReceipt2> {
    this.profiler.profileSectionStart('robustQueryBestReceipt')
    this.profiler.scopedProfileSectionStart('robustQueryBestReceipt')
    try {
      const queryFn = async (node: Shardus.Node): Promise<RequestReceiptForTxResp> => {
        const ip = node.externalIp
        const port = node.externalPort
        // the queryFunction must return null if the given node is our own
        if (ip === Self.ip && port === Self.port) return null
        const message: RequestReceiptForTxReq = {
          txid: queueEntry.acceptedTx.txId,
          timestamp: queueEntry.acceptedTx.timestamp,
        }
        return await Comms.ask(node, 'request_receipt_for_tx', message)
      }
      const eqFn = (item1: RequestReceiptForTxResp, item2: RequestReceiptForTxResp): boolean => {
        const deepCompare = (obj1: any, obj2: any): boolean => {
          // If both are null or undefined or exactly the same value
          if (obj1 === obj2) {
            return true
          }

          // If only one is null or undefined
          if (obj1 === null || obj2 === null || typeof obj1 !== 'object' || typeof obj2 !== 'object') {
            return false
          }

          // Compare arrays
          if (Array.isArray(obj1) && Array.isArray(obj2)) {
            if (obj1.length !== obj2.length) {
              return false
            }
            for (let i = 0; i < obj1.length; i++) {
              if (!deepCompare(obj1[i], obj2[i])) {
                return false
              }
            }
            return true
          }

          // Compare objects
          const keys1 = Object.keys(obj1)
          const keys2 = Object.keys(obj2)

          if (keys1.length !== keys2.length) {
            return false
          }

          for (const key of keys1) {
            if (!keys2.includes(key)) {
              return false
            }
            if (!deepCompare(obj1[key], obj2[key])) {
              return false
            }
          }

          return true
        }
        try {
          // Deep compare item.receipt
          return deepCompare(item1.receipt, item2.receipt)
        } catch (err) {
          return false
        }
      }
      const redundancy = 3
      const { topResult: response } = await robustQuery(
        this.stateManager.transactionQueue.queueEntryGetTransactionGroup(queueEntry),
        queryFn,
        eqFn,
        redundancy,
        true
      )
      if (response && response.receipt) {
        return response.receipt
      }
    } catch (e) {
      this.mainLogger.error(`robustQueryBestReceipt: ${queueEntry.logID} error: ${e.message}`)
    } finally {
      this.profiler.scopedProfileSectionEnd('robustQueryBestReceipt')
      this.profiler.profileSectionEnd('robustQueryBestReceipt')
    }
  }

  async robustQueryBestVote(queueEntry: QueueEntry): Promise<AppliedVote> {
    profilerInstance.profileSectionStart('robustQueryBestVote')
    profilerInstance.scopedProfileSectionStart('robustQueryBestVote')
    try {
      queueEntry.queryingRobustVote = true
      if (this.stateManager.consensusLog) this.mainLogger.debug(`robustQueryBestVote: ${queueEntry.logID}`)
      const queryFn = async (node: Shardus.Node): Promise<AppliedVoteQueryResponse> => {
        const ip = node.externalIp
        const port = node.externalPort
        // the queryFunction must return null if the given node is our own
        if (ip === Self.ip && port === Self.port) return null
        const queryData: AppliedVoteQuery = { txId: queueEntry.acceptedTx.txId }
        return await Comms.ask(node, 'get_applied_vote', queryData)
      }
      const eqFn = (item1: AppliedVoteQueryResponse, item2: AppliedVoteQueryResponse): boolean => {
        try {
          if (item1.appliedVoteHash === item2.appliedVoteHash) return true
          return false
        } catch (err) {
          return false
        }
      }
      const redundancy = 3
      const { topResult: response } = await robustQuery(
        this.stateManager.transactionQueue.queueEntryGetTransactionGroup(queueEntry),
        queryFn,
        eqFn,
        redundancy,
        true,
        true,
        false,
        'robustQueryBestVote'
      )
      if (response && response.appliedVote) {
        return response.appliedVote
      }
    } catch (e) {
      this.mainLogger.error(`robustQueryBestVote: ${queueEntry.logID} error: ${e.message}`)
    } finally {
      queueEntry.queryingRobustVote = false
      profilerInstance.scopedProfileSectionEnd('robustQueryBestVote')
      profilerInstance.profileSectionEnd('robustQueryBestVote')
    }
  }

  async robustQueryConfirmOrChallenge(queueEntry: QueueEntry): Promise<ConfirmOrChallengeQueryResponse> {
    profilerInstance.profileSectionStart('robustQueryConfirmOrChallenge')
    profilerInstance.scopedProfileSectionStart('robustQueryConfirmOrChallenge')
    try {
      if (this.stateManager.consensusLog) {
        this.mainLogger.debug(`robustQueryConfirmOrChallenge: ${queueEntry.logID}`)
      }
      queueEntry.queryingRobustConfirmOrChallenge = true
      const queryFn = async (node: Shardus.Node): Promise<ConfirmOrChallengeQueryResponse> => {
        const ip = node.externalIp
        const port = node.externalPort
        // the queryFunction must return null if the given node is our own
        if (ip === Self.ip && port === Self.port) return null
        const queryData: ConfirmOrChallengeQuery = { txId: queueEntry.acceptedTx.txId }
        const result = await Comms.ask(node, 'get_confirm_or_challenge', queryData)
        return result
      }
      const eqFn = (
        item1: ConfirmOrChallengeQueryResponse,
        item2: ConfirmOrChallengeQueryResponse
      ): boolean => {
        try {
          if (item1 == null || item2 == null) return false
          if (item1.appliedVoteHash == null || item2.appliedVoteHash == null) return false
          if (item1.result == null || item2.result == null) return false

          const message1 =
            item1.appliedVoteHash + item1.result.message + item1.result.nodeId + item1.uniqueCount
          const message2 =
            item2.appliedVoteHash + item2.result.message + item2.result.nodeId + item2.uniqueCount
          if (message1 === message2) return true
          return false
        } catch (err) {
          return false
        } finally {
        }
      }
      const nodesToAsk = this.stateManager.transactionQueue.queueEntryGetTransactionGroup(queueEntry)
      const redundancy = 3
      const {
        topResult: response,
        isRobustResult,
        winningNodes,
      } = await robustQuery(
        this.stateManager.transactionQueue.queueEntryGetTransactionGroup(queueEntry),
        queryFn,
        eqFn,
        redundancy,
        true,
        true,
        false,
        'robustQueryConfirmOrChallenge'
      )
      nestedCountersInstance.countEvent('robustQueryConfirmOrChallenge', `isRobustResult:${isRobustResult}`)
      if (!isRobustResult) {
        return null
      }

      if (response && response.result) {
        nestedCountersInstance.countEvent('robustQueryConfirmOrChallenge', `result is NOT null`)
        return response
      } else {
        nestedCountersInstance.countEvent('robustQueryConfirmOrChallenge', `result is null`)
      }
    } catch (e) {
      this.mainLogger.error(`robustQueryConfirmOrChallenge: ${queueEntry.logID} error: ${e.message}`)
    } finally {
      queueEntry.queryingRobustConfirmOrChallenge = false
      profilerInstance.scopedProfileSectionEnd('robustQueryConfirmOrChallenge')
      profilerInstance.profileSectionEnd('robustQueryConfirmOrChallenge')
    }
  }

  async robustQueryAccountData(
    consensNodes: Shardus.Node[],
    accountId: string
  ): Promise<Shardus.WrappedData> {
    profilerInstance.profileSectionStart('robustQueryAccountData')
    const queryFn = async (node: Shardus.Node): Promise<GetAccountData3Resp> => {
      const ip = node.externalIp
      const port = node.externalPort
      // the queryFunction must return null if the given node is our own
      if (ip === Self.ip && port === Self.port) return null

      const message: GetAccountData3Req = {
        accountStart: accountId,
        accountEnd: accountId,
        tsStart: 0,
        maxRecords: this.config.stateManager.accountBucketSize,
        offset: 0,
        accountOffset: '',
      }
      const result = await Comms.ask(node, 'get_account_data3', message)
      return result
    }
    const eqFn = (item1: GetAccountData3Resp, item2: GetAccountData3Resp): boolean => {
      try {
        const account1 = item1.data.wrappedAccounts[0]
        const account2 = item1.data.wrappedAccounts[0]
        if (account1.stateId === account2.stateId) return true
        return false
      } catch (err) {
        return false
      }
    }
    const redundancy = 3
    const { topResult: response } = await robustQuery(consensNodes, queryFn, eqFn, redundancy, false)
    if (response && response.data) {
      const accountData = response.data.wrappedAccounts[0]
      profilerInstance.profileSectionEnd('robustQueryAccountData')
      return accountData
    }
    profilerInstance.profileSectionEnd('robustQueryAccountData')
  }

  async confirmOrChallenge(queueEntry: QueueEntry): Promise<void> {
    try {
      if (queueEntry.isInExecutionHome === false) {
        nestedCountersInstance.countEvent('confirmOrChallenge', 'not in execution home')
        return
      }
      if (queueEntry.ourVote == null) {
        nestedCountersInstance.countEvent('confirmOrChallenge', 'ourVote == null')
        return
      }
      if (queueEntry.completedConfirmedOrChallenge) {
        nestedCountersInstance.countEvent('confirmOrChallenge', 'already completedConfirmedOrChallenge')
        return
      }
      if (queueEntry.queryingRobustVote) {
        nestedCountersInstance.countEvent('confirmOrChallenge', 'in the middle of querying robust vote')
        return
      }
      if (queueEntry.queryingRobustAccountData) {
        nestedCountersInstance.countEvent(
          'confirmOrChallenge',
          'in the middle of querying robust account data'
        )
        return
      }
      if (logFlags.debug)
        this.mainLogger.debug(
          `confirmOrChallenge: ${queueEntry.logID}  receivedBestVote: ${JSON.stringify(
            queueEntry.receivedBestVote
          )}} `
        )

      this.profiler.profileSectionStart('confirmOrChallenge')
      if (logFlags.profiling_verbose) this.profiler.scopedProfileSectionStart('confirmOrChallenge')

      const now = shardusGetTime()
      //  if we are in lowest 10% of execution group and agrees with the highest ranked vote, send out a confirm msg
      const timeSinceLastVoteMessage =
        queueEntry.lastVoteReceivedTimestamp > 0 ? now - queueEntry.lastVoteReceivedTimestamp : 0
      const timeSinceFirstVote =
        queueEntry.firstVoteReceivedTimestamp > 0 ? now - queueEntry.firstVoteReceivedTimestamp : 0
      // check if last confirm/challenge received is 1s ago
      const hasWaitedLongEnough = timeSinceLastVoteMessage >= this.config.stateManager.waitTimeBeforeConfirm
      const hasWaitLimitReached = timeSinceFirstVote >= this.config.stateManager.waitLimitAfterFirstVote
      if (logFlags.debug)
        this.mainLogger.debug(
          `confirmOrChallenge: ${queueEntry.logID} hasWaitedLongEnough: ${hasWaitedLongEnough}, hasWaitLimitReached: ${hasWaitLimitReached}, timeSinceLastVoteMessage: ${timeSinceLastVoteMessage} ms, timeSinceFirstVote: ${timeSinceFirstVote} ms`
        )
      if (hasWaitedLongEnough || hasWaitLimitReached) {
        nestedCountersInstance.countEvent('confirmOrChallenge', 'hasWaitedLongEnough or hasWaitLimitReached')
        // stop accepting the vote messages for this tx
        queueEntry.acceptVoteMessage = false
        const eligibleToConfirm = queueEntry.eligibleNodeIdsToConfirm.has(Self.id)
        if (this.stateManager.consensusLog) {
          this.mainLogger.info(
            `confirmOrChallenge: ${queueEntry.logID} hasWaitedLongEnough: true. Now we will try to confirm or challenge. eligibleToConfirm: ${eligibleToConfirm}`
          )
        }

        // confirm that current vote is the winning highest ranked vote using robustQuery
        const voteFromRobustQuery = await this.robustQueryBestVote(queueEntry)
        if (voteFromRobustQuery == null) {
          // we cannot confirm the best vote from network
          this.mainLogger.error(`confirmOrChallenge: ${queueEntry.logID} We cannot get voteFromRobustQuery`)
          nestedCountersInstance.countEvent('confirmOrChallenge', 'cannot get robust vote from network')
          return
        }
        let bestVoterFromRobustQuery: Shardus.NodeWithRank
        for (let i = 0; i < queueEntry.executionGroup.length; i++) {
          const node = queueEntry.executionGroup[i]
          if (node.id === voteFromRobustQuery.node_id) {
            bestVoterFromRobustQuery = node as Shardus.NodeWithRank
            break
          }
        }
        if (bestVoterFromRobustQuery == null) {
          // we cannot confirm the best voter from network
          this.mainLogger.error(
            `confirmOrChallenge: ${queueEntry.logID} We cannot get bestVoter from robustQuery for tx ${queueEntry.logID}`
          )
          nestedCountersInstance.countEvent('confirmOrChallenge', 'cannot get robust voter from network')
          return
        }

        // if vote from robust is better than our received vote, use it as final vote
        const isRobustQueryVoteBetter = bestVoterFromRobustQuery.rank > queueEntry.receivedBestVoter.rank
        let finalVote = queueEntry.receivedBestVote
        let finalVoteHash = queueEntry.receivedBestVoteHash
        if (isRobustQueryVoteBetter) {
          nestedCountersInstance.countEvent('confirmOrChallenge', 'robust query vote is better')
          finalVote = voteFromRobustQuery
          finalVoteHash = this.calculateVoteHash(voteFromRobustQuery)
          queueEntry.receivedBestVote = voteFromRobustQuery
          queueEntry.receivedBestVoter = bestVoterFromRobustQuery
          queueEntry.receivedBestVoteHash = finalVoteHash
          if (this.stateManager.consensusLog) {
            this.mainLogger.info(`confirmOrChallenge: ${queueEntry.logID} robust query vote is better`)
          }
        } else {
          if (this.stateManager.consensusLog) {
            this.mainLogger.info(
              `confirmOrChallenge: ${
                queueEntry.logID
              } robust query vote is NOT better. ${utils.stringifyReduce(queueEntry.receivedBestVote)}`
            )
          }
        }
        const shouldChallenge = queueEntry.ourVoteHash !== finalVoteHash

        if (logFlags.debug)
          this.mainLogger.debug(
            `confirmOrChallenge: ${queueEntry.logID} isInExecutionSet: ${queueEntry.isInExecutionHome}, eligibleToConfirm: ${eligibleToConfirm}, shouldChallenge: ${shouldChallenge}`
          )
        if (this.produceBadChallenge || shouldChallenge) {
          if (!shouldChallenge && logFlags.debug) {
            this.mainLogger.debug(
              `confirmOrChallenge: ${queueEntry.logID} I'm a bad node producing a bad challenge`
            )
          }
          this.challengeVoteAndShare(queueEntry)
          return
        }

        if (eligibleToConfirm && queueEntry.ourVoteHash === finalVoteHash) {
          // queueEntry.eligibleNodesToConfirm is sorted highest to lowest rank
          const confirmNodeIds = Array.from(queueEntry.eligibleNodeIdsToConfirm).reverse()
          const ourRankIndex = confirmNodeIds.indexOf(Self.id)
          let delayBeforeConfirm = ourRankIndex * 50 // 50ms

          if (delayBeforeConfirm > 500) delayBeforeConfirm = 500 // we don't want to wait too long

          if (delayBeforeConfirm > 0) {
            await utils.sleep(delayBeforeConfirm)

            // Compare our rank with received rank before sharing our confirmation
            if (
              queueEntry.receivedBestConfirmedNode &&
              queueEntry.receivedBestConfirmedNode.rank < queueEntry.ourNodeRank
            ) {
              nestedCountersInstance.countEvent(
                'confirmOrChallenge',
                `isReceivedBetterConfirmation after ${delayBeforeConfirm}ms delay: true`
              )
              if (logFlags.debug)
                this.mainLogger.debug(
                  `confirmOrChallenge: ${
                    queueEntry.logID
                  } received better confirmation before we share ours, receivedBestConfirmation: ${utils.stringifyReduce(
                    queueEntry.receivedBestConfirmation
                  )}`
                )
              queueEntry.completedConfirmedOrChallenge = true
              return
            }
            nestedCountersInstance.countEvent(
              'confirmOrChallenge',
              `isReceivedBetterConfirmation after ${delayBeforeConfirm}ms delay: false`
            )
          }
          this.confirmVoteAndShare(queueEntry)
        } else if (eligibleToConfirm === false && queueEntry.ourVoteHash === finalVoteHash) {
          // we are not eligible to confirm
          queueEntry.completedConfirmedOrChallenge = true
        }
      } else {
        nestedCountersInstance.countEvent('confirmOrChallenge', 'still early for confirm or challenge')
        if (logFlags.debug)
          this.mainLogger.debug(
            `confirmOrChallenge: ${queueEntry.logID} not sending confirm or challenge yet because timeSinceLastVoteMessage is ${timeSinceLastVoteMessage} ms`
          )
      }
    } catch (e) {
      this.mainLogger.error(`confirmOrChallenge: ${queueEntry.logID} error: ${e.message}, ${e.stack}`)
    } finally {
      if (logFlags.profiling_verbose) this.profiler.scopedProfileSectionEnd('confirmOrChallenge')
      this.profiler.profileSectionEnd('confirmOrChallenge')
    }
  }

  sortByAccountId(first: Shardus.WrappedResponse, second: Shardus.WrappedResponse): Ordering {
    return utils.sortAscProp(first, second, 'accountId')
  }

  async confirmVoteAndShare(queueEntry: QueueEntry): Promise<void> {
    this.profiler.profileSectionStart('confirmVoteAndShare')
    try {
      /* prettier-ignore */
      if (logFlags.verbose) if (logFlags.playback) this.logger.playbackLogNote("shrd_confirmOrChallengeVote", `${queueEntry.acceptedTx.txId}`, `qId: ${queueEntry.entryID} `);

      // podA: POQ3 create confirm message and share to tx group
      const confirmMessage: ConfirmOrChallengeMessage = {
        message: 'confirm',
        nodeId: Self.id,
        appliedVote: queueEntry.receivedBestVote,
      }
      const signedConfirmMessage = this.crypto.sign(confirmMessage)
      if (this.stateManager.consensusLog) this.mainLogger.debug(`confirmVoteAndShare: ${queueEntry.logID}`)

      //Share message to tx group
      const gossipGroup = this.stateManager.transactionQueue.queueEntryGetTransactionGroup(queueEntry)
      Comms.sendGossip('spread_confirmOrChallenge', signedConfirmMessage, '', Self.id, gossipGroup, true, 10)
      this.tryAppendMessage(queueEntry, signedConfirmMessage)
      queueEntry.gossipedConfirmOrChallenge = true
      queueEntry.completedConfirmedOrChallenge = true
    } catch (e) {
      this.mainLogger.error(`confirmVoteAndShare: ${queueEntry.logID} error: ${e.message}`)
    } finally {
      this.profiler.profileSectionEnd('confirmVoteAndShare')
    }
  }

  async challengeVoteAndShare(queueEntry: QueueEntry): Promise<void> {
    this.profiler.profileSectionStart('challengeVoteAndShare')
    try {
      /* prettier-ignore */
      if (logFlags.verbose) if (logFlags.playback) this.logger.playbackLogNote("shrd_confirmOrChallengeVote", `${queueEntry.acceptedTx.txId}`, `qId: ${queueEntry.entryID} `);

      // Should check account integrity only when before states are different from best vote
      let doStatesMatch = true
      const voteBeforeStates = queueEntry.receivedBestVote.account_state_hash_before
      const ourBeforeStates = Object.values(queueEntry.collectedData)
      if (voteBeforeStates.length !== ourBeforeStates.length) {
        doStatesMatch = false
      }
      for (let i = 0; i < voteBeforeStates.length; i++) {
        if (voteBeforeStates[i] !== ourBeforeStates[i].stateId) {
          doStatesMatch = false
          nestedCountersInstance.countEvent(
            'confirmOrChallenge',
            'tryChallengeVoteAndShare states do not match'
          )
          break
        }
      }
      if (this.produceBadChallenge) doStatesMatch = false
      let isAccountIntegrityOk = false

      if (doStatesMatch) {
        isAccountIntegrityOk = true
      } else if (doStatesMatch === false && this.config.stateManager.integrityCheckBeforeChallenge === true) {
        isAccountIntegrityOk = await this.checkAccountIntegrity(queueEntry)
      } else {
        isAccountIntegrityOk = true
      }

      if (!isAccountIntegrityOk) {
        nestedCountersInstance.countEvent(
          'confirmOrChallenge',
          'tryChallengeVoteAndShare account integrity not ok.'
        )
        if (logFlags.verbose)
          this.mainLogger.debug(`challengeVoteAndShare: ${queueEntry.logID} account integrity is not ok`)
        // we should not challenge or confirm if account integrity is not ok
        queueEntry.completedConfirmedOrChallenge = true
        return
      }

      //podA: POQ4 create challenge message and share to tx group
      const challengeMessage: ConfirmOrChallengeMessage = {
        message: 'challenge',
        nodeId: queueEntry.ourVote.node_id,
        appliedVote: queueEntry.receivedBestVote,
      }
      const signedChallengeMessage = this.crypto.sign(challengeMessage)
      if (logFlags.debug)
        this.mainLogger.debug(
          `challengeVoteAndShare: ${queueEntry.logID}  ${JSON.stringify(signedChallengeMessage)}}`
        )

      //Share message to tx group
      const gossipGroup = this.stateManager.transactionQueue.queueEntryGetTransactionGroup(queueEntry)
      Comms.sendGossip('spread_confirmOrChallenge', signedChallengeMessage, '', null, gossipGroup, true, 10)
      this.tryAppendMessage(queueEntry, signedChallengeMessage)
      queueEntry.gossipedConfirmOrChallenge = true
      queueEntry.completedConfirmedOrChallenge = true
    } catch (e) {
      this.mainLogger.error(`challengeVoteAndShare: ${queueEntry.logID} error: ${e.message}`)
    } finally {
      this.profiler.profileSectionEnd('challengeVoteAndShare')
    }
  }

  async checkAccountIntegrity(queueEntry: QueueEntry): Promise<boolean> {
    this.profiler.profileSectionStart('checkAccountIntegrity')
    this.profiler.scopedProfileSectionStart('checkAccountIntegrity')
    queueEntry.queryingRobustAccountData = true
    let success = true

    for (const key of queueEntry.uniqueKeys) {
      const collectedAccountData = queueEntry.collectedData[key]
      if (collectedAccountData.accountCreated) {
        // we do not need to check this newly created account
        // todo: still possible that node has lost data for this account
        continue
      }
      const consensuGroupForAccount =
        this.stateManager.transactionQueue.queueEntryGetConsensusGroupForAccount(queueEntry, key)
      const promise = this.stateManager.transactionConsensus.robustQueryAccountData(
        consensuGroupForAccount,
        key
      )
      queueEntry.robustAccountDataPromises[key] = promise
    }

    if (
      queueEntry.robustAccountDataPromises &&
      Object.keys(queueEntry.robustAccountDataPromises).length > 0
    ) {
      const keys = Object.keys(queueEntry.robustAccountDataPromises)
      const promises = Object.values(queueEntry.robustAccountDataPromises)
      const results: Shardus.WrappedData[] = await Promise.all(promises)
      for (let i = 0; i < results.length; i++) {
        const key = keys[i]
        const collectedAccountData = queueEntry.collectedData[key]
        const robustQueryAccountData = results[i]
        if (
          robustQueryAccountData.stateId === collectedAccountData.stateId &&
          robustQueryAccountData.timestamp === collectedAccountData.timestamp
        ) {
          nestedCountersInstance.countEvent('checkAccountIntegrity', 'collected data and robust data match')
          if (logFlags.debug)
            this.mainLogger.debug(`checkAccountIntegrity: ${queueEntry.logID} key: ${key} ok`)
        } else {
          success = false
          nestedCountersInstance.countEvent(
            'checkAccountIntegrity',
            'collected data and robust data do not match'
          )
          if (logFlags.debug) {
            this.mainLogger.debug(
              `checkAccountIntegrity: ${
                queueEntry.logID
              } key: ${key} failed. collectedAccountData: ${utils.stringify(
                collectedAccountData
              )} robustAccountData: ${utils.stringify(robustQueryAccountData)}`
            )
          }
        }
      }
    } else {
      nestedCountersInstance.countEvent('checkAccountIntegrity', 'robustAccountDataPromises empty')
    }
    this.profiler.scopedProfileSectionEnd('checkAccountIntegrity')
    this.profiler.profileSectionEnd('checkAccountIntegrity')
    queueEntry.queryingRobustAccountData = false
    return success
  }
  /**
   * createAndShareVote
   * create an AppliedVote
   * gossip the AppliedVote
   * @param queueEntry
   */
  async createAndShareVote(queueEntry: QueueEntry): Promise<unknown> {
    /* prettier-ignore */ if (logFlags.verbose) if (logFlags.playback) this.logger.playbackLogNote('shrd_createAndShareVote', `${queueEntry.acceptedTx.txId}`, `qId: ${queueEntry.entryID} `)

    // TODO STATESHARDING4 CHECK VOTES PER CONSENSUS GROUP

    if (queueEntry.isInExecutionHome === false) {
      //we are not in the execution home, so we can't create or share a vote
      return
    }
    this.profiler.profileSectionStart('createAndShareVote')

    try {
      const ourNodeId = Self.id
      const isEligibleToShareVote = queueEntry.eligibleNodeIdsToVote.has(ourNodeId)
      let isReceivedBetterVote = false

      // create our vote (for later use) even if we have received a better vote
      let ourVote: AppliedVote = {
        txid: queueEntry.acceptedTx.txId,
        transaction_result: queueEntry.preApplyTXResult.passed,
        account_id: [],
        account_state_hash_after: [],
        account_state_hash_before: [],
        node_id: ourNodeId,
        cant_apply: queueEntry.preApplyTXResult.applied === false,
        app_data_hash: '',
      }

      // BAD NODE SIMULATION
      if (this.produceBadVote) {
        ourVote.transaction_result = !ourVote.transaction_result
      }

      ourVote.app_data_hash = queueEntry?.preApplyTXResult?.applyResponse.appReceiptDataHash

      if (queueEntry.debugFail_voteFlip === true) {
        /* prettier-ignore */ if (logFlags.verbose) if (logFlags.playback) this.logger.playbackLogNote('shrd_createAndShareVote_voteFlip', `${queueEntry.acceptedTx.txId}`, `qId: ${queueEntry.entryID} `)

        ourVote.transaction_result = !ourVote.transaction_result
      }

      let wrappedStates = this.stateManager.useAccountWritesOnly ? {} : queueEntry.collectedData

      const applyResponse = queueEntry?.preApplyTXResult?.applyResponse

      const stats = {
        usedApplyResponse: false,
        wrappedStateSet: 0,
        optimized: false,
      }
      //if we have values for accountWrites, then build a list wrappedStates from it and use this list instead
      //of the collected data list
      if (applyResponse != null) {
        const writtenAccountsMap: WrappedResponses = {}
        if (applyResponse.accountWrites != null && applyResponse.accountWrites.length > 0) {
          for (const writtenAccount of applyResponse.accountWrites) {
            writtenAccountsMap[writtenAccount.accountId] = writtenAccount.data
          }
          //override wrapped states with writtenAccountsMap which should be more complete if it included
          wrappedStates = writtenAccountsMap
        }

        stats.usedApplyResponse = true
        stats.wrappedStateSet = Object.keys(wrappedStates).length
        //Issue that could happen with sharded network:
        //Need to figure out where to put the logic that knows which nodes need final data forwarded to them
        //A receipt aline may not be enough, remote shards will need an updated copy of the data.
      }

      if (wrappedStates != null) {
        //we need to sort this list and doing it in place seems ok
        //applyResponse.stateTableResults.sort(this.sortByAccountId )

        stats.optimized = true
        //need to sort our parallel lists so that they are deterministic!!
        const wrappedStatesList = [...Object.values(wrappedStates)]

        //this sort is critical to a deterministic vote structure.. we need this if taking a hash
        wrappedStatesList.sort(this.sortByAccountId)

        for (const wrappedState of wrappedStatesList) {
          // note this is going to stomp the hash value for the account
          // this used to happen in dapp.updateAccountFull  we now have to save off prevStateId on the wrappedResponse
          //We have to update the hash now! Not sure if this is the greatest place but it needs to be done
          const updatedHash = this.app.calculateAccountHash(wrappedState.data)
          wrappedState.stateId = updatedHash

          // populate accountIds
          ourVote.account_id.push(wrappedState.accountId)
          // popoulate after state hashes
          ourVote.account_state_hash_after.push(wrappedState.stateId)

          if (this.stateManager.transactionQueue.useNewPOQ) {
            const wrappedResponse = queueEntry.collectedData[wrappedState.accountId]
            // populate before state hashes
            if (wrappedResponse != null) ourVote.account_state_hash_before.push(wrappedResponse.stateId)
          }
        }
      }

      let appliedVoteHash: AppliedVoteHash
      //let temp = ourVote.node_id
      // ourVote.node_id = '' //exclue this from hash
      ourVote = this.crypto.sign(ourVote)
      const voteHash = this.calculateVoteHash(ourVote)
      //ourVote.node_id = temp
      appliedVoteHash = {
        txid: ourVote.txid,
        voteHash,
      }
      queueEntry.ourVoteHash = voteHash

      if (logFlags.verbose || this.stateManager.consensusLog)
        this.mainLogger.debug(
          `createAndShareVote ${queueEntry.logID} created ourVote: ${utils.stringifyReduce(
            ourVote
          )},ourVoteHash: ${voteHash}, isEligibleToShareVote: ${isEligibleToShareVote}, isReceivedBetterVote: ${isReceivedBetterVote}`
        )

      //append our vote
      appliedVoteHash = this.crypto.sign(appliedVoteHash)
      if (this.stateManager.transactionQueue.useNewPOQ === false)
        this.tryAppendVoteHash(queueEntry, appliedVoteHash)

      // save our vote to our queueEntry
      queueEntry.ourVote = ourVote

      if (this.stateManager.transactionQueue.useNewPOQ) {
        if (isEligibleToShareVote === false) {
          nestedCountersInstance.countEvent(
            'transactionConsensus',
            'createAndShareVote isEligibleToShareVote:' + ' false'
          )
          return
        }
        const ourRankIndex = Array.from(queueEntry.eligibleNodeIdsToVote).indexOf(ourNodeId)
        let delayBeforeVote = ourRankIndex * 50 // 100ms

        if (delayBeforeVote > 500) {
          delayBeforeVote = 500
        }

        nestedCountersInstance.countEvent(
          'transactionConsensus',
          `createAndShareVote delayBeforeSharingVote: ${delayBeforeVote} ms`
        )

        if (delayBeforeVote > 0) {
          await utils.sleep(delayBeforeVote)

          // Compare our rank with received rank
          if (queueEntry.receivedBestVoter && queueEntry.receivedBestVoter.rank > queueEntry.ourNodeRank) {
            isReceivedBetterVote = true
          }

          if (isReceivedBetterVote) {
            nestedCountersInstance.countEvent(
              'transactionConsensus',
              'createAndShareVote isReceivedBetterVote: true'
            )
            return
          }
        }

        // tryAppend before sharing
        const appendWorked = this.tryAppendVote(queueEntry, ourVote)
        if (appendWorked === false) {
          nestedCountersInstance.countEvent('transactionConsensus', 'createAndShareVote appendFailed')
        }
      }

      let consensusGroup = []
      if (
        this.stateManager.transactionQueue.executeInOneShard === true &&
        this.stateManager.transactionQueue.useNewPOQ === false
      ) {
        //only share with the exection group
        consensusGroup = queueEntry.executionGroup
      } else {
        //sharing with the entire transaction group actually..
        consensusGroup = this.stateManager.transactionQueue.queueEntryGetTransactionGroup(queueEntry)
      }

      if (consensusGroup.length >= 1) {
        this.stateManager.debugNodeGroup(
          queueEntry.acceptedTx.txId,
          queueEntry.acceptedTx.timestamp,
          `share tx vote to neighbors`,
          consensusGroup
        )

        /* prettier-ignore */ if (logFlags.debug) this.mainLogger.debug(`createAndShareVote numNodes: ${consensusGroup.length} stats:${utils.stringifyReduce(stats)} ourVote: ${utils.stringifyReduce(ourVote)}`)
        /* prettier-ignore */ if (logFlags.playback) this.logger.playbackLogNote('createAndShareVote', `${queueEntry.acceptedTx.txId}`, `numNodes: ${consensusGroup.length} stats:${utils.stringifyReduce(stats)} ourVote: ${utils.stringifyReduce(ourVote)} `)

        // Filter nodes before we send tell()
        const filteredNodes = this.stateManager.filterValidNodesForInternalMessage(
          consensusGroup,
          'createAndShareVote',
          true,
          true
        )
        if (filteredNodes.length === 0) {
          /* prettier-ignore */ if (logFlags.error) this.mainLogger.error('createAndShareVote: filterValidNodesForInternalMessage no valid nodes left to try')
          return null
        }
        const filteredConsensusGroup = filteredNodes

        if (this.stateManager.transactionQueue.useNewPOQ) {
          // Gossip the vote to the entire consensus group
          Comms.sendGossip('gossip-applied-vote', ourVote, '', null, filteredConsensusGroup, true, 4)
        } else {
          this.profiler.profileSectionStart('createAndShareVote-tell')
          this.p2p.tell(filteredConsensusGroup, 'spread_appliedVoteHash', appliedVoteHash)
          this.profiler.profileSectionEnd('createAndShareVote-tell')
        }
      } else {
        nestedCountersInstance.countEvent('transactionQueue', 'createAndShareVote fail, no consensus group')
      }
    } catch (e) {
      this.mainLogger.error(`createAndShareVote: error ${e.message}`)
    } finally {
      this.profiler.profileSectionEnd('createAndShareVote')
    }
  }

  calculateVoteHash(vote: AppliedVote, removeSign = true): string {
    if (this.stateManager.transactionQueue.useNewPOQ) {
      const voteToHash = {
        txId: vote.txid,
        transaction_result: vote.transaction_result,
        account_id: vote.account_id,
        account_state_hash_after: vote.account_state_hash_after,
        account_state_hash_before: vote.account_state_hash_before,
        cant_apply: vote.cant_apply,
        app_data_hash: vote.app_data_hash,
      }
      return this.crypto.hash(voteToHash)
    } else {
      const voteToHash = Object.assign({}, vote)
      if (voteToHash.node_id != null) voteToHash.node_id = ''
      if (voteToHash.sign != null) delete voteToHash.sign
      return this.crypto.hash(voteToHash)
    }
  }

  /**
   * tryAppendMessage
   * if we have not seen this message yet search our list of votes and append it in
   * the correct spot sorted by signer's id
   * @param queueEntry
   * @param confirmOrChallenge
   */
  tryAppendMessage(queueEntry: QueueEntry, confirmOrChallenge: ConfirmOrChallengeMessage): boolean {
    if (queueEntry.acceptConfirmOrChallenge === false || queueEntry.appliedReceipt2 != null) {
      this.mainLogger.debug(
        `tryAppendMessage: ${
          queueEntry.logID
        } not accepting confirm or challenge. acceptConfirmOrChallenge: ${
          queueEntry.acceptConfirmOrChallenge
        }, appliedReceipt2: ${queueEntry.appliedReceipt2 == null}`
      )
      return false
    }

    /* prettier-ignore */
    if (logFlags.playback) this.logger.playbackLogNote("tryAppendMessage", `${queueEntry.logID}`, `collectedVotes: ${queueEntry.collectedVotes.length}`);
    /* prettier-ignore */
    if (logFlags.debug) this.mainLogger.debug(`tryAppendMessage: ${queueEntry.logID}   ${JSON.stringify(confirmOrChallenge)} `);
    // check if the node is in the execution group
    const isMessageFromExecutionNode = queueEntry.executionGroupMap.has(confirmOrChallenge.nodeId)

    if (!isMessageFromExecutionNode) {
      this.mainLogger.error(`tryAppendMessage: ${queueEntry.logID} Message is not from an execution node.`)
    }

    if (confirmOrChallenge.message === 'confirm') {
      const foundNode =
        queueEntry.eligibleNodeIdsToConfirm.has(confirmOrChallenge.nodeId) &&
        this.crypto.verify(
          confirmOrChallenge as SignedObject,
          queueEntry.executionGroupMap.get(confirmOrChallenge.nodeId).publicKey
        )

      if (!foundNode) {
        this.mainLogger.error(
          `tryAppendMessage: ${queueEntry.logID} Message signature does not match with any eligible nodes that can confirm.`
        )
        return false
      }
    }

    // todo: podA check if the message is valid
    const isMessageValid = true
    if (!isMessageValid) return false

    // Check if the previous phase is finalized and we have received best vote
    if (queueEntry.receivedBestVote == null) {
      this.mainLogger.error(
        `tryAppendMessage: ${queueEntry.logID} confirm/challenge is too early. Not finalized best vote yet`
      )
      return false
    }

    // verify that the vote part of the message is for the same vote that was finalized in the previous phase
    if (this.calculateVoteHash(confirmOrChallenge.appliedVote) !== queueEntry.receivedBestVoteHash) {
      this.mainLogger.error(
        `tryAppendMessage: ${
          queueEntry.logID
        } confirmOrChallenge is not for the same vote that was finalized in the previous phase, queueEntry.receivedBestVote: ${JSON.stringify(
          queueEntry.receivedBestVote
        )}`
      )
      return false
    }

    // record the timestamps
    const now = shardusGetTime()
    queueEntry.lastConfirmOrChallengeTimestamp = now
    if (queueEntry.firstConfirmOrChallengeTimestamp === 0) {
      queueEntry.firstConfirmOrChallengeTimestamp = now

      if (this.stateManager.consensusLog) {
        this.mainLogger.info(`tryAppendMessage: ${queueEntry.logID} first confirm or challenge`)
      }
    }

    if (confirmOrChallenge.message === 'confirm') {
      let isBetterThanCurrentConfirmation
      let receivedConfirmedNode: Shardus.NodeWithRank

      if (!queueEntry.receivedBestConfirmation) isBetterThanCurrentConfirmation = true
      else if (queueEntry.receivedBestConfirmation.nodeId === confirmOrChallenge.nodeId)
        isBetterThanCurrentConfirmation = false
      else {
        // Compare ranks
        if (queueEntry.executionGroupMap.has(confirmOrChallenge.nodeId)) {
          receivedConfirmedNode = queueEntry.executionGroupMap.get(
            confirmOrChallenge.nodeId
          ) as Shardus.NodeWithRank
        }

        isBetterThanCurrentConfirmation =
          receivedConfirmedNode.rank > queueEntry.receivedBestConfirmedNode.rank
      }

      if (!isBetterThanCurrentConfirmation) {
        if (logFlags.debug)
          this.mainLogger.debug(
            `tryAppendMessage: ${queueEntry.logID} confirmation is not better than current confirmation`
          )
        return false
      }

      if (this.stateManager.consensusLog)
        this.mainLogger.debug(
          `tryAppendMessage: ${queueEntry.logID} better confirmation received and switching to it`
        )

      queueEntry.receivedBestConfirmation = confirmOrChallenge

      if (receivedConfirmedNode) {
        queueEntry.receivedBestConfirmedNode = receivedConfirmedNode
        return true
      } else {
        if (queueEntry.executionGroupMap.has(confirmOrChallenge.nodeId)) {
          queueEntry.receivedBestConfirmedNode = queueEntry.executionGroupMap.get(
            confirmOrChallenge.nodeId
          ) as Shardus.NodeWithRank
        }
      }
    } else if (confirmOrChallenge.message === 'challenge') {
      let isBetterThanCurrentChallenge = false
      let receivedChallenger: Shardus.NodeWithRank

      // add the challenge to the queueEntry if it is from a unique node
      if (queueEntry.uniqueChallenges[confirmOrChallenge.sign.owner] == null) {
        queueEntry.uniqueChallenges[confirmOrChallenge.sign.owner] = confirmOrChallenge
        queueEntry.uniqueChallengesCount++
        if (this.stateManager.consensusLog)
          this.mainLogger.debug(
            `tryAppendMessage: ${queueEntry.logID} unique challenge added. ${JSON.stringify(
              queueEntry.uniqueChallenges
            )}`
          )
      }

      this.mainLogger.debug(
        `tryAppendMessage: ${
          queueEntry.logID
        } challenge received and processing. queueEntry.receivedBestChallenge: ${JSON.stringify(
          queueEntry.receivedBestChallenge
        )}`
      )
      if (!queueEntry.receivedBestChallenge) isBetterThanCurrentChallenge = true
      else if (queueEntry.receivedBestChallenge.nodeId === confirmOrChallenge.nodeId)
        isBetterThanCurrentChallenge = false
      else {
        // Compare ranks
        if (queueEntry.executionGroupMap.has(confirmOrChallenge.nodeId)) {
          receivedChallenger = queueEntry.executionGroupMap.get(
            confirmOrChallenge.nodeId
          ) as Shardus.NodeWithRank
        }
        isBetterThanCurrentChallenge = receivedChallenger.rank < queueEntry.receivedBestChallenger.rank
      }

      if (!isBetterThanCurrentChallenge) {
        if (logFlags.debug)
          this.mainLogger.debug(
            `tryAppendMessage: ${queueEntry.logID} challenge is not better than current challenge`
          )
        return false
      }

      queueEntry.receivedBestChallenge = confirmOrChallenge
      queueEntry.lastConfirmOrChallengeTimestamp = shardusGetTime()

      if (receivedChallenger) {
        queueEntry.receivedBestChallenger = receivedChallenger
      } else {
        if (queueEntry.executionGroupMap.has(confirmOrChallenge.nodeId)) {
          queueEntry.receivedBestChallenger = queueEntry.executionGroupMap.get(
            confirmOrChallenge.nodeId
          ) as Shardus.NodeWithRank
        }
      }
      if (logFlags.debug)
        this.mainLogger.debug(
          `tryAppendMessage: ${
            queueEntry.logID
          } challenge received and processed. queueEntry.receivedBestChallenge: ${JSON.stringify(
            queueEntry.receivedBestChallenge
          )}, receivedBestChallenger: ${queueEntry.receivedBestChallenger}`
        )
      return true
    }
  }

  /**
   * tryAppendVote
   * if we have not seen this vote yet search our list of votes and append it in
   * the correct spot sorted by signer's id
   * @param queueEntry
   * @param vote
   */
  tryAppendVote(queueEntry: QueueEntry, vote: AppliedVote): boolean {
    if (this.stateManager.transactionQueue.useNewPOQ === false) {
      const numVotes = queueEntry.collectedVotes.length

      /* prettier-ignore */ if (logFlags.playback) this.logger.playbackLogNote('tryAppendVote', `${queueEntry.logID}`, `vote: ${utils.stringifyReduce(vote)}`)
      /* prettier-ignore */ if (logFlags.debug) this.mainLogger.debug(`tryAppendVote collectedVotes: ${queueEntry.logID}   vote: ${utils.stringifyReduce(vote)}`)

      // just add the vote if we dont have any yet
      if (numVotes === 0) {
        queueEntry.collectedVotes.push(vote)
        queueEntry.newVotes = true
        if (this.stateManager.consensusLog)
          this.mainLogger.debug(`First vote appended for tx ${queueEntry.logID}}`)
        return true
      }

      //compare to existing votes.  keep going until we find that this vote is already in the list or our id is at the right spot to insert sorted
      for (let i = 0; i < numVotes; i++) {
        // eslint-disable-next-line security/detect-object-injection
        const currentVote = queueEntry.collectedVotes[i]

        if (currentVote.sign.owner === vote.sign.owner) {
          // already in our list so do nothing and return
          return false
        }
      }

      queueEntry.collectedVotes.push(vote)
      queueEntry.newVotes = true

      return true
    } else {
      if (queueEntry.acceptVoteMessage === false || queueEntry.appliedReceipt2 != null) return false
      /* prettier-ignore */ if (logFlags.playback) this.logger.playbackLogNote('tryAppendVote', `${queueEntry.logID}`, `vote: ${utils.stringifyReduce(vote)}`)
      /* prettier-ignore */ if (logFlags.debug) this.mainLogger.debug(`tryAppendVote collectedVotes: ${queueEntry.logID}   vote: ${utils.stringifyReduce(vote)}`)

      const isEligibleToVote =
        queueEntry.eligibleNodeIdsToVote.has(vote.node_id) &&
        this.crypto.verify(vote as SignedObject, queueEntry.executionGroupMap.get(vote.node_id).publicKey)

      if (!isEligibleToVote) {
        if (logFlags.debug) {
          this.mainLogger.debug(
            `tryAppendVote: logId:${
              queueEntry.logID
            } received node is not part of eligible nodes to vote, vote: ${utils.stringify(
              vote
            )}, eligibleNodesToVote: ${utils.stringify(queueEntry.eligibleNodeIdsToVote)}`
          )
        }
        return
      }

      // todo: podA check if the vote is valid
      const isVoteValid = true
      if (!isVoteValid) return

      // we will mark the last received vote timestamp
      const now = shardusGetTime()
      queueEntry.lastVoteReceivedTimestamp = now
      if (queueEntry.firstVoteReceivedTimestamp === 0) queueEntry.firstVoteReceivedTimestamp = now

      // Compare with existing vote. Skip we already have it or node rank is lower than ours
      let isBetterThanCurrentVote
      let receivedVoter: Shardus.NodeWithRank
      if (!queueEntry.receivedBestVote) isBetterThanCurrentVote = true
      else if (queueEntry.receivedBestVoteHash === this.calculateVoteHash(vote))
        isBetterThanCurrentVote = false
      else {
        // Compare ranks
        if (queueEntry.executionGroupMap.has(vote.node_id)) {
          receivedVoter = queueEntry.executionGroupMap.get(vote.node_id) as Shardus.NodeWithRank
        }
        isBetterThanCurrentVote = receivedVoter.rank > queueEntry.receivedBestVoter.rank
      }

      if (!isBetterThanCurrentVote) {
        if (logFlags.debug || this.stateManager.consensusLog) {
          this.mainLogger.debug(
            `tryAppendVote: ${queueEntry.logID} received vote is NOT better than current vote. lastReceivedVoteTimestamp: ${queueEntry.lastVoteReceivedTimestamp}`
          )
        }
        return false
      }

      queueEntry.receivedBestVote = vote
      queueEntry.receivedBestVoteHash = this.calculateVoteHash(vote)
      queueEntry.newVotes = true
      if (logFlags.debug || this.stateManager.consensusLog) {
        this.mainLogger.debug(
          `tryAppendVote: ${queueEntry.logID} received vote is better than current vote. lastReceivedVoteTimestamp: ${queueEntry.lastVoteReceivedTimestamp}`
        )
      }
      if (receivedVoter) {
        queueEntry.receivedBestVoter = receivedVoter
        return true
      } else {
        if (queueEntry.executionGroupMap.has(vote.node_id)) {
          queueEntry.receivedBestVoter = queueEntry.executionGroupMap.get(
            vote.node_id
          ) as Shardus.NodeWithRank
          return true
        }
      }
      // No need to forward the gossip here as it's being done in the gossip handler
    }
  }

  tryAppendVoteHash(queueEntry: QueueEntry, voteHash: AppliedVoteHash): boolean {
    const numVotes = queueEntry.collectedVotes.length

    /* prettier-ignore */ if (logFlags.playback) this.logger.playbackLogNote('tryAppendVoteHash', `${queueEntry.logID}`, `collectedVotes: ${queueEntry.collectedVoteHashes.length}`)
    /* prettier-ignore */ if (logFlags.debug) this.mainLogger.debug(`tryAppendVoteHash collectedVotes: ${queueEntry.logID}   ${queueEntry.collectedVoteHashes.length} `)

    // just add the vote if we dont have any yet
    if (numVotes === 0) {
      queueEntry.collectedVoteHashes.push(voteHash)
      queueEntry.newVotes = true
      return true
    }

    //compare to existing votes.  keep going until we find that this vote is already in the list or our id is at the right spot to insert sorted
    for (let i = 0; i < numVotes; i++) {
      // eslint-disable-next-line security/detect-object-injection
      const currentVote = queueEntry.collectedVoteHashes[i]

      if (currentVote.sign.owner === voteHash.sign.owner) {
        // already in our list so do nothing and return
        return false
      }
    }

    queueEntry.collectedVoteHashes.push(voteHash)
    queueEntry.newVotes = true

    return true
  }
}

export default TransactionConsenus
