import { cpus } from 'node:os';
import { parentPort, Worker } from 'node:worker_threads';

const DEFAULT_MAXIMUM_WORKERS = 8;

/**
 * Resolve `--jobs=N` or `--jobs N`, clamped to the amount of work available.
 * The default deliberately caps the pool so FFT buffers do not multiply
 * without bound on high-core-count machines.
 */
export function comparisonWorkerCount(
  argumentsList,
  itemCount,
  maximumWorkers = DEFAULT_MAXIMUM_WORKERS,
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

  const automatic = Math.min(maximumWorkers, Math.max(1, cpus().length));
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
