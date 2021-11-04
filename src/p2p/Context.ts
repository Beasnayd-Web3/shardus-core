import { EventEmitter } from 'events'
import {p2p as P2P} from './Wrapper'
import Crypto from '../crypto'
import Logger, {logFlags} from '../logger'
import { NetworkClass } from '../network'
import Shardus from '../shardus'
import * as ShardusTypes from '../shardus/shardus-types'
import StateManager from '../state-manager'
import Storage from '../storage'
import Reporter from '../reporter'

export type P2PModuleContext = typeof P2P

export let p2p: P2PModuleContext
export let logger: Logger
export let crypto: Crypto
export let network: NetworkClass
export let shardus: Shardus
export let stateManager: StateManager
export let storage: Storage
export let io
export let perf
export let config: ShardusTypes.ShardusConfiguration
export let defaultConfigs: {
  server: ShardusTypes.ShardusConfiguration
  logs: ShardusTypes.LogsConfiguration
  storage: ShardusTypes.StorageConfiguration
}
export let reporter: Reporter

export function setP2pContext(context: P2PModuleContext) {
  p2p = context
}

export function setLoggerContext(context) {
  logger = context
}

export function setCryptoContext(context) {
  crypto = context
}

export function setNetworkContext(context) {
  network = context
}

export function setShardusContext(context) {
  shardus = context
}

export function setStateManagerContext(context) {
  stateManager = context
}

export function setStorageContext(context) {
  storage = context
}

export function setIOContext(context) {
  io = context
}

export function setReporterContext(context) {
  reporter = context
}

export function setConfig(conf: ShardusTypes.ShardusConfiguration) {
  config = conf
}

export function setPerf(context) {
  console.log("Setting perf", context)
  perf = context
}

export function setDefaultConfigs(conf) {
  defaultConfigs = conf
}
