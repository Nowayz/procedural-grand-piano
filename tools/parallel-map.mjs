import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import { parentPort, Worker } from 'node:worker_threads';

function availableLogicalProcessorCount() {
  // availableParallelism respects process affinity and container CPU quotas.
  // Keep the fallback for Node releases predating that API.
  return typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;
}

function parseCpuList(list) {
  return list.trim().split(',').flatMap((range) => {
    const [first, last = first] = range.split('-').map(Number);
    if (!Number.isInteger(first) || !Number.isInteger(last) || last < first) return [];
    return Array.from({ length: last - first + 1 }, (_, index) => first + index);
  });
}

function availablePhysicalProcessorCount() {
  if (process.platform !== 'linux') return undefined;
  try {
    const status = readFileSync('/proc/self/status', 'utf8');
    const allowedList = /^Cpus_allowed_list:\s*(.+)$/m.exec(status)?.[1];
    if (!allowedList) return undefined;
    const physicalCores = new Set();
    for (const cpu of parseCpuList(allowedList)) {
      const topology = `/sys/devices/system/cpu/cpu${cpu}/topology`;
      const packageId = readFileSync(`${topology}/physical_package_id`, 'utf8').trim();
      const coreId = readFileSync(`${topology}/core_id`, 'utf8').trim();
      physicalCores.add(`${packageId}:${coreId}`);
    }
    return physicalCores.size || undefined;
  } catch {
    return undefined;
  }
}

function automaticProcessorCount() {
  const logical = Math.max(1, availableLogicalProcessorCount());
  const physical = availablePhysicalProcessorCount();
  return physical === undefined ? logical : Math.max(1, Math.min(logical, physical));
}

/**
 * Resolve `--jobs=N` or `--jobs N`, clamped to the amount of work available.
 * By default CPU-heavy comparisons use every physical core available to this
 * process. This saturates execution resources without the SMT contention that
 * makes these FFT workloads slower. An explicit job count remains available.
 */
export function comparisonWorkerCount(
  argumentsList,
  itemCount,
  maximumWorkers = Number.POSITIVE_INFINITY,
) {
  let requested;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument.startsWith('--jobs=')) {
      requested = argument.slice('--jobs='.length);
      break;
    }
    if (argument === '--jobs') {
      if (index + 1 >= argumentsList.length) {
        throw new RangeError('--jobs must be followed by a positive integer');
      }
      requested = argumentsList[index + 1];
      break;
    }
  }

  const automatic = Math.min(
    maximumWorkers,
    automaticProcessorCount(),
  );
  const parsed = requested === undefined ? automatic : Number(requested);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new RangeError('--jobs must be a positive integer');
  }
  return Math.max(1, Math.min(itemCount, parsed));
}

function partitionJobs(items, workerCount) {
  const partitions = Array.from({ length: workerCount }, () => []);
  items.forEach((item, index) => {
    // Round-robin distribution balances the more expensive low-register FFTs.
    partitions[index % workerCount].push({ index, item });
  });
  return partitions.filter((partition) => partition.length > 0);
}

/**
 * Deterministic indexed map. Worker completion order is intentionally ignored:
 * every result is placed back at its original input index.
 */
export async function parallelMap({
  items,
  moduleUrl,
  task,
  workerCount,
  localMapper,
  onProgress = () => {},
}) {
  if (items.length === 0) return [];
  if (workerCount === 1) {
    const results = new Array(items.length);
    for (let index = 0; index < items.length; index += 1) {
      results[index] = await localMapper(items[index], index);
      onProgress(index + 1);
    }
    return results;
  }

  const results = new Array(items.length);
  const workers = [];
  let completed = 0;
  const runPartition = (jobs) => new Promise((resolve, reject) => {
    const worker = new Worker(moduleUrl, { workerData: { task, jobs } });
    workers.push(worker);
    let done = false;

    worker.on('message', (message) => {
      if (message?.type === 'batch') {
        for (const [index, value] of message.entries) results[index] = value;
        completed += message.entries.length;
        onProgress(completed);
      } else if (message?.type === 'done') {
        done = true;
        resolve();
      }
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`comparison worker exited with code ${code}`));
      else if (!done) reject(new Error('comparison worker exited before reporting completion'));
    });
  });

  try {
    await Promise.all(partitionJobs(items, workerCount).map(runPartition));
  } catch (error) {
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
    throw error;
  }
  return results;
}

/** Run inside a worker module and send compact result batches to its parent. */
export async function serveParallelMap(jobs, mapper, batchSize = 4) {
  if (!parentPort) throw new Error('serveParallelMap must run in a worker thread');
  let entries = [];
  for (const { index, item } of jobs) {
    entries.push([index, await mapper(item, index)]);
    if (entries.length >= batchSize) {
      parentPort.postMessage({ type: 'batch', entries });
      entries = [];
    }
  }
  if (entries.length > 0) parentPort.postMessage({ type: 'batch', entries });
  parentPort.postMessage({ type: 'done' });
}
