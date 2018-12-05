const { before, test } = require('tap')// eslint-disable-line
const path = require('path')
const fs = require('fs')
const axios = require('axios')

let confStorage = module.require(`../../../config/storage.json`)
const { getInstances } = module.require('../../includes/utils-class')
const { clearTestDb } = module.require('../../includes/utils-storage')
const { readLogFile } = require('../../includes/utils-log')
const { isValidHex } = require('../../includes/utils')
const { sleep } = require('../../../src/utils')
const startUtils = require('../../../tools/server-start-utils/index')('../../../', './instances')
// let storage, logger, crypto, newConfStorage
let p2p
let config = module.require(path.join(__dirname, '../../../config/server.json'))

async function init (loggerConf = null, externalPort = null) {
  const instances = await getInstances(loggerConf, externalPort)
  p2p = instances.p2p
}

test('Testing milestone-5 join procedure', { timeout: 100000, skip: false }, async t => {
  await startUtils.startServer(9001) // start seed Node
  await startUtils.startServer(9002) // start second Node
  await sleep(config.cycleDuration * 2.0 * 1000)

  let receivedRequests = await startUtils.getRequests(9001)
  let joinRequest = receivedRequests.find(r => r.url === '/join' && r.method === 'POST')
  let secondNodeId = joinRequest.body.nodeInfo.address

  await sleep(config.cycleDuration * 1.0 * 1000)
  let stateOfSeedNode = await startUtils.getState(9001)

  t.equal(joinRequest.body.nodeInfo.externalPort, 9002, 'Should seedNode receive join request made by second node')
  t.notEqual(stateOfSeedNode.nodes.current[secondNodeId], undefined, 'Should have second node Id in the current node list of seedNode')
  await startUtils.deleteAllServers()
  t.end()
})

test('Testing /join API endpoint in shardus class', { timeout: 100000, skip: false }, async t => {
  await startUtils.startServer(9001)
  await init(null, 9002)
  let joinRequest = await p2p._createJoinRequest()
  let response = await axios.post(`http://127.0.0.1:9001/join`, joinRequest)
  const log = readLogFile('main', '../integration/shardus/instances/shardus-server-9001/logs')
  await startUtils.deleteAllServers()
  t.equal(response.data.success, true, 'Should return success: true for a valid join request')
  t.notEqual(log.indexOf(`Join request received: ${JSON.stringify(joinRequest)}`), -1, 'Should enter recieved join request into main.log')
  if (confStorage) {
    confStorage.options.storage = 'db/db.sqlite'
    fs.writeFileSync(path.join(__dirname, `../../../config/storage.json`), JSON.stringify(confStorage, null, 2))
    clearTestDb()
  }
  t.end()
})

test('Testing /cyclemarker API endpoint', { timeout: 100000, skip: false }, async t => {
  await startUtils.startServer(9001)
  await sleep(config.cycleDuration * 2.5 * 1000)
  const response = await axios.get(`http://127.0.0.1:9001/cyclemarker`)
  const cyclemarker = response.data
  t.equal(isValidHex(cyclemarker.currentCycleMarker), true, 'current cycle marker should be a valid hex')
  t.equal(Number.isInteger(cyclemarker.cycleCounter), true, 'cycle counter should be an integer')
  t.equal(Number.isInteger(cyclemarker.cycleDuration), true, 'cycle duration should be an integer')
  t.equal(isNaN(Number(cyclemarker.cycleStart * 1000)), false, 'the cycle start should be a valid time value')
  t.equal(isNaN(Number(cyclemarker.currentTime * 1000)), false, 'current should be a valid time value')
  t.equal(Array.isArray(cyclemarker.nodesJoined), true, 'nodesJoined should be an array')
  await startUtils.deleteAllServers()
  if (confStorage) {
    confStorage.options.storage = 'db/db.sqlite'
    fs.writeFileSync(path.join(__dirname, `../../../config/storage.json`), JSON.stringify(confStorage, null, 2))
    clearTestDb()
  }
  t.end()
})

test('Testing /cyclechain API endpoint', { timeout: 100000, skip: false }, async t => {
  await startUtils.startServer(9001)
  await sleep(config.cycleDuration * 2.5 * 1000)
  const response = await axios.get(`http://127.0.0.1:9001/cyclechain`)
  const cycleChain = response.data.cycleChain
  t.equal(Array.isArray(cycleChain), true, 'nodesJoined should be an array')
  t.equal(cycleChain.length > 0, true, 'should have at least one item in cycle chain')
  await startUtils.deleteAllServers()
  if (confStorage) {
    confStorage.options.storage = 'db/db.sqlite'
    fs.writeFileSync(path.join(__dirname, `../../../config/storage.json`), JSON.stringify(confStorage, null, 2))
    clearTestDb()
  }
  t.end()
})
