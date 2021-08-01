import bodyParser from 'body-parser'
import cors from 'cors'
import { EventEmitter } from 'events'
import express from 'express'
import Log4js from 'log4js'
import NatAPI = require('nat-api')
import * as net from 'net'
import { Sn } from 'shardus-net'
import { promisify } from 'util'

import Sntp from '@hapi/sntp'

import * as httpModule from '../http'
import Logger, { logFlags } from '../logger'
import {
  config,
  defaultConfigs,
  logger,
} from '../p2p/Context'
import { ShardusConfiguration } from '../shardus/shardus-types'
import * as utils from '../utils'
import { nestedCountersInstance } from '../utils/nestedCounters'
import { profilerInstance } from '../utils/profiler'

/** TYPES */
export interface IPInfo {
  internalPort: number
  internalIp: string
  externalPort: number
  externalIp: string
}

/** STATE */

let mainLogger: Log4js.Logger

let natClient: any

export let ipInfo: IPInfo

/** CLASS */

export class NetworkClass extends EventEmitter {
  app: any
  io: SocketIO.Server
  server: any
  sn: any
  logger: Logger
  mainLogger: Log4js.Logger
  netLogger: Log4js.Logger
  timeout: number
  internalRoutes: {}
  externalRoutes: any[]
  extServer: any
  intServer: any
  verboseLogsNet: boolean
  InternalTellCounter: number
  InternalAskCounter: number
  ipInfo: any
  externalCatchAll: any
  debugNetworkDelay: number
  constructor(config: ShardusConfiguration, logger: Logger) {
    super()
    this.app = express()
    this.sn = null
    this.logger = logger
    this.mainLogger = logger.getLogger('main')
    this.netLogger = logger.getLogger('net')
    this.timeout = config.network.timeout * 1000
    this.internalRoutes = {}
    this.externalRoutes = []
    this.extServer = null
    this.intServer = null

    this.InternalTellCounter = 1
    this.InternalAskCounter = 1
    this.debugNetworkDelay = 0

    if (config && config.debug && config.debug.fakeNetworkDelay) {
      this.debugNetworkDelay = config.debug.fakeNetworkDelay
    }

    nestedCountersInstance.countEvent('network', 'init')
  }

  // TODO: Allow for binding to a specified network interface
  private setupExternal() {
    return new Promise((resolve, reject) => {
      const self = this
      const storeRequests = function (req, res, next) {
        if (req.url !== '/test') {
          if (self.verboseLogsNet) {
            self.netLogger.debug(
              'External\t' +
                JSON.stringify({
                  url: req.url,
                  method: req.method,
                  body: req.body,
                })
            )
          }
        }
        next()
      }
      this.app.use(bodyParser.json({ limit: '50mb' }))
      this.app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }))
      this.app.use(cors())
      this.app.use(storeRequests)
      this.applyExternal()
      this.extServer = this.app.listen(this.ipInfo.externalPort, () => {
        const msg = `External server running on port ${this.ipInfo.externalPort}...`
        console.log(msg)
        this.mainLogger.info('Network: ' + msg)
      })

      this.io = require('socket.io')(this.extServer)
      resolve(this.io)
    })
  }

  // TODO: Allow for binding to a specified network interface
  private async setupInternal() {
    this.sn = Sn({
      port: this.ipInfo.internalPort,
    })
    this.intServer = await this.sn.listen(async (data, remote, respond) => {
      let routeName
      try {
        if (!data) throw new Error('No data provided in request...')
        const { route, payload } = data

        routeName = route
        if (!route && payload && payload.isResponse) {
          if (logFlags.debug)
            this.mainLogger.debug(
              'Received response data without any specified route',
              payload
            )
          return
        }
        if (!route) {
          if (logFlags.debug)
            this.mainLogger.debug(
              'Network: ' +
                `Unable to read request, payload of received message: ${JSON.stringify(
                  data
                )}`
            )
          throw new Error('Unable to read request, no route specified.')
        }
        if (!this.internalRoutes[route])
          throw new Error('Unable to handle request, invalid route.')

        if (this.debugNetworkDelay > 0) {
          await utils.sleep(this.debugNetworkDelay)
        }
        profilerInstance.profileSectionStart('net-internl')
        profilerInstance.profileSectionStart(`net-internl-${route}`)

        const handler = this.internalRoutes[route]
        if (!payload) {
          await handler(null, respond)
          return
        }
        await handler(payload, respond)
        if (logFlags.net_trace) {
          this.netLogger.debug(
            'Internal\t' +
              JSON.stringify({
                url: route,
                body: payload,
              })
          )
        }
      } catch (err) {
        if (logFlags.error)
          this.mainLogger.error('Network: setupInternal: ', err)
        if (logFlags.error)
          this.mainLogger.error(
            'DBG',
            'Network: setupInternal > sn.listen > callback > data',
            data
          )
        if (logFlags.error)
          this.mainLogger.error(
            'DBG',
            'Network: setupInternal > sn.listen > callback > remote',
            remote
          )
      } finally {
        profilerInstance.profileSectionEnd('net-internl')
        profilerInstance.profileSectionEnd(`net-internl-${routeName}`)
      }
    })
    console.log(
      `Internal server running on port ${this.ipInfo.internalPort}...`
    )
  }

  async tell(nodes, route, message, logged = false) {
    const data = { route, payload: message }
    const promises = []
    let id = ''
    if (message.tracker) {
      id = message.tracker
    }
    for (const node of nodes) {
      if (!logged)
        this.logger.playbackLog(
          'self',
          node,
          'InternalTell',
          route,
          id,
          message
        )
      this.InternalTellCounter++
      const promise = this.sn.send(node.internalPort, node.internalIp, data)
      promise.catch((err) => {
        if (logFlags.error) this.mainLogger.error('Network: ' + err)
        if (logFlags.error) this.mainLogger.error(err.stack)
        this.emit('error', node)
      })
      promises.push(promise)
    }
    try {
      await Promise.all(promises)
    } catch (err) {
      if (logFlags.error) this.mainLogger.error('Network: ' + err)
    }
  }

  ask(node, route, message, logged = false) {
    return new Promise(async (resolve, reject) => {
      this.InternalAskCounter++
      let id = ''
      if (message.tracker) {
        id = message.tracker
      }

      try {
        if (this.debugNetworkDelay > 0) {
          await utils.sleep(this.debugNetworkDelay)
        }
        profilerInstance.profileSectionStart('net-ask')
        profilerInstance.profileSectionStart(`net-ask-${route}`)

        const data = { route, payload: message }
        const onRes = (res) => {
          if (!logged)
            this.logger.playbackLog(
              'self',
              node,
              'InternalAskResp',
              route,
              id,
              res
            )
          resolve(res)
        }
        const onTimeout = () => {
          nestedCountersInstance.countEvent('network', 'timeout')
          const err = new Error(
            `Request timed out. ${utils.stringifyReduce(id)}`
          )
          if (logFlags.error) this.mainLogger.error('Network: ' + err)
          if (logFlags.error) this.mainLogger.error(err.stack)
          this.emit('timeout', node)
          reject(err)
        }
        if (!logged)
          this.logger.playbackLog(
            'self',
            node,
            'InternalAsk',
            route,
            id,
            message
          )
        try {
          await this.sn.send(
            node.internalPort,
            node.internalIp,
            data,
            this.timeout,
            onRes,
            onTimeout
          )
        } catch (err) {
          if (logFlags.error) this.mainLogger.error('Network: ' + err)
          this.emit('error', node)
        }
      } finally {
        profilerInstance.profileSectionEnd('net-ask')
        profilerInstance.profileSectionEnd(`net-ask-${route}`)
      }
    })
  }

  async setup(ipInfo: IPInfo) {
    if (!ipInfo.externalIp)
      throw new Error('Fatal: network module requires externalIp')
    if (!ipInfo.externalPort)
      throw new Error('Fatal: network module requires externalPort')
    if (!ipInfo.internalIp)
      throw new Error('Fatal: network module requires internalIp')
    if (!ipInfo.internalPort)
      throw new Error('Fatal: network module requires internalPort')

    this.ipInfo = ipInfo

    this.logger.setPlaybackIPInfo(ipInfo)

    this.setupInternal()
    return await this.setupExternal()
  }

  async shutdown() {
    try {
      const promises = []
      if (this.extServer) promises.push(closeServer(this.extServer))
      // [TODO] - need to see why it is taking minutes for stopListening promises to return; for now Omar decided to comment this out
      //      if (this.sn) promises.push(this.sn.stopListening(this.intServer))
      if (natClient) promises.push(natClient.es6.destroy())
      await Promise.all(promises)
    } catch (e) {
      if (e.code !== 'ERR_SERVER_NOT_RUNNING') throw e
    }
  }

  private registerExternal(method, route, handler) {
    const formattedRoute = `/${route}`

    const self = this
    let wrappedHandler = handler
    if (logFlags.playback) {
      wrappedHandler = function (req, res) {
        self.logger.playbackLog(
          req.hostname,
          'self',
          'ExternalHttpReq',
          formattedRoute,
          '',
          { params: req.params, body: req.body }
        )
        return handler(req, res)
      }
    }
    wrappedHandler = async function (req, res) {
      await handler(req, res)
      profilerInstance.profileSectionEnd('net-externl', false)
      profilerInstance.profileSectionEnd(`net-externl-${route}`, false)
    }

    const startProfiler = (req, res, next) => {
      profilerInstance.profileSectionStart('net-externl', false)
      profilerInstance.profileSectionStart(`net-externl-${route}`, false)
      next()
    }
    switch (method) {
      case 'GET':
        this.externalRoutes.push((app) => {
          app.get(formattedRoute, startProfiler, wrappedHandler)
        })
        break
      case 'POST':
        this.externalRoutes.push((app) => {
          app.post(formattedRoute, startProfiler, wrappedHandler)
        })
        break
      case 'PUT':
        this.externalRoutes.push((app) => {
          app.put(formattedRoute, wrappedHandler)
        })
        break
      case 'DELETE':
        this.externalRoutes.push((app) => {
          app.delete(formattedRoute, wrappedHandler)
        })
        break
      case 'PATCH':
        this.externalRoutes.push((app) => {
          app.patch(formattedRoute, wrappedHandler)
        })
        break
      default:
        throw new Error('Fatal: Invalid HTTP method for handler.')
    }

    if (this.extServer && this.extServer.listening) {
      this.applyExternal()
    }
  }

  private applyExternal() {
    while (this.externalRoutes.length > 0) {
      const routeFn = this.externalRoutes.pop()
      routeFn(this.app)
    }
  }

  setExternalCatchAll(handler) {
    this.externalCatchAll = handler
  }

  registerExternalGet(route, handler) {
    this.registerExternal('GET', route, handler)
  }

  registerExternalPost(route, handler) {
    this.registerExternal('POST', route, handler)
  }

  registerExternalPut(route, handler) {
    this.registerExternal('PUT', route, handler)
  }

  registerExternalDelete(route, handler) {
    this.registerExternal('DELETE', route, handler)
  }

  registerExternalPatch(route, handler) {
    this.registerExternal('PATCH', route, handler)
  }

  registerInternal(route, handler) {
    if (this.internalRoutes[route])
      throw Error('Handler already exists for specified internal route.')
    this.internalRoutes[route] = handler
  }

  unregisterInternal(route) {
    if (this.internalRoutes[route]) {
      delete this.internalRoutes[route]
    }
  }
}

/** FUNCTIONS */

// export async function init() {
//   mainLogger = logger.getLogger('main')

//   // Make sure we know our IP configuration
//   ipInfo = {
//     externalIp:
//       config.ip.externalIp || (await discoverExternalIp(config.p2p.ipServer)),
//     externalPort: config.ip.externalPort,
//     internalIp: config.ip.internalIp,
//     internalPort: config.ip.internalPort,
//   }
// }

export async function init() {
  // Get main logger
  mainLogger = logger.getLogger('main')

  // Get default values for IP config
  const defaults = defaultConfigs['server']['ip'] as IPInfo

  // Set ipInfo to passed config, automtically if passed 'auto', or to default
  const externalIp =
    (config.ip.externalIp === 'auto'
      ? await getExternalIp()
      : config.ip.externalIp) || defaults['externalIp']

  const externalPort =
    (config.ip.externalPort === 'auto'
      ? await getNextExternalPort(externalIp)
      : config.ip.externalPort) || defaults['externalPort']

  const internalIp =
    (config.ip.internalIp === 'auto' ? externalIp : config.ip.internalIp) ||
    defaults['internalIp']

  const internalPort =
    (config.ip.internalPort === 'auto'
      ? await getNextExternalPort(internalIp)
      : config.ip.internalPort) || defaults['internalPort']

  ipInfo = {
    externalIp,
    externalPort,
    internalIp,
    internalPort,
  }

  if (logFlags.info) {
    mainLogger.info('This nodes ipInfo:')
    mainLogger.info(JSON.stringify(ipInfo, null, 2))
  }
}

function initNatClient() {
  // Initialize 'nat-api' client if not initialized
  if (!natClient) {
    natClient = new NatAPI()
    natClient['es6'] = {}
    natClient['es6']['externalIp'] = promisify(
      natClient.externalIp.bind(natClient)
    )
    natClient['es6']['map'] = promisify(natClient.map.bind(natClient))
    natClient['es6']['destroy'] = promisify(natClient.destroy.bind(natClient))
  }
}

async function getExternalIp() {
  initNatClient()

  try {
    const ip = await natClient.es6.externalIp()
    return ip
  } catch (err) {
    mainLogger.warn(
      'Failed to get external IP from gateway:',
      err.message ? err.message : err
    )

    try {
      const ip = await discoverExternalIp(config.p2p.ipServer)
      return ip
    } catch (err) {
      mainLogger.warn(
        'Failed to get external IP from IP server:',
        err.message ? err.message : err
      )
    }
  }
}

async function getNextExternalPort(ip: string) {
  initNatClient()

  // Get the next available port from the OS and test it
  let [reachable, port] = await wrapTest(new ConnectTest(ip))

  // If port is unreachable attempt to forward it with UPnP, then PMP
  if (reachable === false) {
    const attempts = [{ enablePMP: false }, { enablePMP: true }]

    for (const opts of attempts) {
      if (logFlags.info)
        mainLogger.info(
          `Forwarding ${port} via ${opts.enablePMP ? 'PMP' : 'UPnP'}...`
        )

      try {
        await natClient.es6.map(
          Object.assign(
            { publicPort: port, privatePort: port, protocol: 'TCP' },
            opts
          )
        )
        if (logFlags.info) mainLogger.info('  Success!')
        break
      } catch (err) {
        if (logFlags.info) mainLogger.info('  Error:', err.message)
      }
    }
  }

  // Test it again
  ;[reachable] = await wrapTest(new ConnectTest(ip, port))
  if (reachable) {
    return port
  } else {
    mainLogger.warn('Failed to get next external port')
  }
}

async function wrapTest(test: ConnectTest) {
  if (logFlags.info) mainLogger.info(`Testing ${test.ip}...`)

  test.once('port', (port) => {
    if (logFlags.info) mainLogger.info(`  Listening on ${port}. Connecting...`)
  })

  let result: [boolean, number]

  try {
    const success = await test.start()
    result = [success, test.port]
    if (logFlags.info) mainLogger.info('  Success!')
  } catch (err) {
    if (logFlags.info)
      mainLogger.info('  Failed:', err.message ? err.message : err)
    result = [false, test.port]
  }

  return result
}

class ConnectTest extends EventEmitter {
  ip: string
  port: number
  constructor(ip: string, port?: number) {
    super()
    this.ip = ip
    this.port = port || -1
  }
  start() {
    return new Promise<true>((resolve, reject) => {
      // Open a port on 0.0.0.0 (any IP)
      const server = net.createServer(() => {})
      server.unref()
      server.on('error', reject)
      const listenPort = this.port > -1 ? this.port : 0
      server.listen(listenPort, () => {
        // Get opened port
        const address = server.address() as net.AddressInfo
        this.port = address.port
        this.emit('port', this.port)

        // Try to connect to given IP at opened port
        const socket = net.createConnection(this.port, this.ip, () => {
          socket.destroy()
          server.close(() => resolve(true))
        })
        socket.unref()
        socket.setTimeout(2000)
        socket.on('error', (err) => {
          socket.destroy()
          server.close()
          reject(err)
        })
        socket.on('timeout', () => {
          socket.destroy()
          server.close()
          reject('Connection timed out')
        })
      })
    })
  }
}

export async function checkTimeSynced(timeServers) {
  for (const host of timeServers) {
    try {
      const time = await Sntp.time({
        host,
        timeout: 10000,
      })
      return time.t <= config.p2p.syncLimit
    } catch (e) {
      mainLogger.warn(`Couldn't fetch ntp time from server at ${host}`)
    }
  }
  throw Error('Unable to check local time against time servers.')
}

async function discoverExternalIp(server: string) {
  // Figure out if we're behind a NAT

  // Attempt NAT traversal with UPnP

  //

  try {
    const { ip }: { ip: string } = await httpModule.get(server)
    return ip
  } catch (err) {
    throw Error(
      `p2p/Self:discoverExternalIp: Could not discover IP from external IP server ${server}: ` +
        err.message
    )
  }
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close()
    server.unref()
    resolve()
  })
}
