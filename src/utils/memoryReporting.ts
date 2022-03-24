const NS_PER_SEC = 1e9;

import {Utils} from 'sequelize/types';
import * as Context from '../p2p/Context';
import * as utils from '../utils';
import Crypto from '../crypto';
import Shardus from '../shardus';
import StateManager from '../state-manager';
import * as CycleCreator from '../p2p/CycleCreator';
const os = require('os');
import {nestedCountersInstance} from '../utils/nestedCounters';
const process = require('process');
import {resourceUsage} from 'process';
import {isDebugModeMiddleware} from '../network/debugMiddleware';
import * as NodeList from '../p2p/NodeList';

// process.hrtime.bigint()

interface MemoryReporting {}

type CounterMap = Map<string, CounterNode>;
interface CounterNode {
  count: number;
  subCounters: CounterMap;
}

export let memoryReportingInstance: MemoryReporting;

type MemItem = {
  category: string;
  subcat: string;
  itemKey: string;
  count: number;
};

class MemoryReporting {

  crypto: Crypto
  report: MemItem[];
  shardus: Shardus;
  lastCPUTimes: any[];

  constructor(shardus: Shardus) {
    this.crypto = null;
    memoryReportingInstance = this;
    this.report = [];
    this.shardus = shardus;

    this.lastCPUTimes = this.getCPUTimes();
  }

  registerEndpoints() {
    Context.network.registerExternalGet(
      'memory',
      isDebugModeMiddleware,
      (req, res) => {
        const toMB = 1/1000000
        const report = process.memoryUsage()
        res.write(`System Memory Report.  Timestamp: ${Date.now()}\n`);
        res.write(`rss: ${(report.rss * toMB).toFixed(2)} MB\n`);
        res.write(`heapTotal: ${(report.heapTotal * toMB).toFixed(2)} MB\n`);
        res.write(`heapUsed: ${(report.heapUsed * toMB).toFixed(2)} MB\n`);
        res.write(`external: ${(report.external * toMB).toFixed(2)} MB\n`);
        res.write(
          `arrayBuffers: ${(report.arrayBuffers * toMB).toFixed(2)} MB\n\n\n`
        );

        this.gatherReport();
        this.reportToStream(this.report, res, 0);
        res.end();
      }
    );
    Context.network.registerExternalGet(
      'memory-short',
      isDebugModeMiddleware,
      (req, res) => {
        nestedCountersInstance.countRareEvent('test', `memory-short`); // only here to so we can test the rare event counter system

        let toMB = 1 / 1000000;
        let report = process.memoryUsage();
        res.write(`System Memory Report.  Timestamp: ${Date.now()}\n`);
        res.write(`rss: ${(report.rss * toMB).toFixed(2)} MB\n`);
        res.write(`heapTotal: ${(report.heapTotal * toMB).toFixed(2)} MB\n`);
        res.write(`heapUsed: ${(report.heapUsed * toMB).toFixed(2)} MB\n`);
        res.write(`external: ${(report.external * toMB).toFixed(2)} MB\n`);
        res.write(
          `arrayBuffers: ${(report.arrayBuffers * toMB).toFixed(2)} MB\n`
        );
        res.end();
      }
    );

    Context.network.registerExternalGet(
      'nodelist',
      isDebugModeMiddleware,
      (req, res) => {
        this.report = [];
        this.addNodesToReport();
        res.write('\n');
        this.reportToStream(this.report, res, 0);
        res.write('\n');
        res.end();
      }
    );

    Context.network.registerExternalGet(
      'netstats',
      isDebugModeMiddleware,
      (req, res) => {
        this.report = [];
        res.write('\n');
        this.addNetStatsToReport();
        this.reportToStream(this.report, res, 0);
        res.write('\n');
        res.end();
      }
    );

    Context.network.registerExternalGet(
      'memory-gc',
      isDebugModeMiddleware,
      (req, res) => {
        res.write(`System Memory Report.  Timestamp: ${Date.now()}\n`);
        try {
          if (global.gc) {
            global.gc();
            res.write('garbage collected!');
          } else {
            res.write('No access to global.gc.  run with node --expose-gc');
          }
        } catch (e) {
          res.write('ex:No access to global.gc.  run with node --expose-gc');
        }
        res.end();
      }
    );

    Context.network.registerExternalGet(
      'scaleFactor',
      isDebugModeMiddleware,
      (req, res) => {

      res.write(`Scale debug  Timestamp: ${Date.now()}\n`)
        try {
          res.write(`CycleAutoScale.  ${CycleCreator.scaleFactor}`);
        } catch (e) {
          res.write(JSON.stringify(e));
        }
        res.end();
      }
    );
  }

  private addNodesToReport() {
    if (NodeList.activeByIdOrder) {
      const allNodeIds = []
      const numActiveNodes = NodeList.activeByIdOrder.length
      for (const node of NodeList.activeByIdOrder) {
        allNodeIds.push(utils.makeShortHash(node.id));
      }
      this.addToReport(
        'P2P',
        'Nodelist',
        `${utils.stringifyReduce(allNodeIds)}`,
        1
      );
    }
  }

  getMemoryStringBasic() {
    const toMB = 1/1000000
    const report = process.memoryUsage() 
    let outStr = `rss: ${(report.rss * toMB).toFixed(2)} MB`;
    //todo integrate this into the main stats tsv
    if (this.shardus && this.shardus.stateManager) {
      const numActiveNodes = NodeList.activeByIdOrder.length
      const queueCount = this.shardus.stateManager.transactionQueue.newAcceptedTxQueue.length
      const archiveQueueCount = this.shardus.stateManager.transactionQueue.archivedQueueEntries.length  
      outStr += ` nds:${numActiveNodes} qCt:${queueCount} aAr:${archiveQueueCount}`;
    }
    outStr += '\n';
    return outStr;
  }

  addToReport(
    category: string,
    subcat: string,
    itemKey: string,
    count: number
  ) {
    const obj = {category, subcat, itemKey, count}
    this.report.push(obj);
  }

  reportToStream(report: MemItem[], stream, indent) {

    const indentText = '___'.repeat(indent)
    for (const item of report) {
      const {category, subcat, itemKey, count} = item
      const countStr = `${count}`
      stream.write(
        `${countStr.padStart(10)} ${category} ${subcat} ${itemKey}\n`
      );

      // if (subArray != null && subArray.length > 0) {
      //   this.printArrayReport(subArray, stream, indent + 1)
      // }
    }
  }

  gatherReport() {
    this.report = [];
    this.gatherStateManagerReport();
    this.systemProcessReport();
    this.addNetStatsToReport();
  }

  gatherStateManagerReport() {
    if (this.shardus && this.shardus.stateManager) {
      if (NodeList.activeByIdOrder) {
        const numActiveNodes = NodeList.activeByIdOrder.length
        this.addToReport('P2P', 'Nodelist', 'numActiveNodes', numActiveNodes);
      }

      let cacheDbg = this.shardus.stateManager.accountCache.getDebugStats()
      //let cacheCount = this.shardus.stateManager.accountCache.accountsHashCache3.workingHistoryList.accountIDs.length
      this.addToReport('StateManager','AccountsCache', 'workingAccounts', cacheDbg[0] )
      //let cacheCount2 = this.shardus.stateManager.accountCache.accountsHashCache3.accountHashMap.size
      this.addToReport('StateManager','AccountsCache', 'mainMap', cacheDbg[1] )
      
      const queueCount = this.shardus.stateManager.transactionQueue.newAcceptedTxQueue.length
      this.addToReport('StateManager', 'TXQueue', 'queueCount', queueCount);
      const pendingQueueCount = this.shardus.stateManager.transactionQueue.newAcceptedTxQueueTempInjest.length
      this.addToReport(
        'StateManager',
        'TXQueue',
        'pendingQueueCount',
        pendingQueueCount
      );
      const archiveQueueCount = this.shardus.stateManager.transactionQueue.archivedQueueEntries.length
      this.addToReport(
        'StateManager',
        'TXQueue',
        'archiveQueueCount',
        archiveQueueCount

      for (let syncTracker of this.shardus.stateManager.accountSync
        .syncTrackers) {
        const partition = `${utils.stringifyReduce(syncTracker.range.low)} - ${utils.stringifyReduce(syncTracker.range.high)}`
        this.addToReport(
          'StateManager',
          'SyncTracker',
          `isGlobal:${syncTracker.isGlobalSyncTracker} started:${syncTracker.syncStarted} finished:${syncTracker.syncFinished} partition:${partition}`,
          1
        );
      }

      const inSync = !this.shardus.stateManager.accountPatcher.failedLastTrieSync
      this.addToReport('Patcher', 'insync', `${inSync}`, 1);
      this.addToReport(
        'Patcher',
        'history',
        JSON.stringify(
          this.shardus.stateManager.accountPatcher.syncFailHistory
        ),
        1
      );

      this.addToReport('Patcher', 'insync', `${inSync}`, 1);

      //too much data moved to to /nodelist endpoint
      //this.addNodesToReport()
    }
  }

  getCPUTimes() {
    const cpus = os.cpus();
    const times = []

    for (let cpu of cpus) {
      const timeObj = {}
      let total = 0;
      for (const [key, value] of Object.entries(cpu.times)) {
        const time = Number(value)
        total += time;
        timeObj[key] = value;
      }
      timeObj['total'] = total;

      times.push(timeObj);
    }
    return times;
  }

  cpuPercent() {
    const currentTimes = this.getCPUTimes()

    const deltaTimes = []
    const percentTimes = []

    let percentTotal = 0;

    for (let i = 0; i < currentTimes.length; i++) {
      const currentTimeEntry = currentTimes[i];
      const lastTimeEntry = this.lastCPUTimes[i];
      const deltaTimeObj = {}
      for (const [key, value] of Object.entries(currentTimeEntry)) {
        deltaTimeObj[key] = currentTimeEntry[key] - lastTimeEntry[key];
      }
      deltaTimes.push(deltaTimeObj);

      for (const [key, value] of Object.entries(currentTimeEntry)) {
        percentTimes[key] = deltaTimeObj[key] / deltaTimeObj['total'];
      }

      percentTotal += percentTimes['user'] || 0;
      percentTotal += percentTimes['nice'] || 0;
      percentTotal += percentTimes['sys'] || 0;
    }

    this.lastCPUTimes = currentTimes;
    const percentUsed = percentTotal / currentTimes.length

    // const usage = process.cpuUsage();
    // const currentCPUUsage = (usage.user + usage.system) * 1000; //micro seconds to ms
    // const percentUsed = currentCPUUsage / total * 100

    return percentUsed;
  }

  roundTo3decimals(num) {
    return Math.round((num + Number.EPSILON) * 1000) / 1000;
  }

  systemProcessReport() {
    this.addToReport(
      'Process',
      'CPU',
      'cpuPercent',
      this.roundTo3decimals(this.cpuPercent() * 100)
    );

    const avgCPU = this.shardus.statistics.getAverage('cpuPercent')
    this.addToReport(
      'Process',
      'CPU',
      'cpuAVGPercent',
      this.roundTo3decimals(avgCPU * 100)
    );
    const multiStats = this.shardus.statistics.getMultiStatReport('cpuPercent')

    multiStats.allVals.forEach((val, index) => {
      multiStats.allVals[index] = Math.round(val * 100);
    });
    multiStats.min = this.roundTo3decimals(multiStats.min * 100);
    multiStats.max = this.roundTo3decimals(multiStats.max * 100);
    multiStats.avg = this.roundTo3decimals(multiStats.avg * 100);

    this.addToReport('Process', 'CPU', `cpu: ${JSON.stringify(multiStats)}`, 1);

    const report = resourceUsage()
    for (const [key, value] of Object.entries(report)) {
      this.addToReport('Process', 'Details', key, value);
    }
  }

  getShardusNetReport() {
    if (
      this.shardus == null ||
      this.shardus.network == null ||
      this.shardus.network.sn == null
    ) {
      return null;
    }
    if (this.shardus.network.sn.stats != null) {
      const stats = this.shardus.network.sn.stats()
      return stats;
    }
    return null;
  }

  addNetStatsToReport() {
    const stats = this.getShardusNetReport()
    if (stats != null) {
      this.addToReport(
        'NetStats',
        'stats',
        'stats',
        (JSON.stringify(stats, null, 4), 1)
      );
    }
  }
}

export default MemoryReporting;
