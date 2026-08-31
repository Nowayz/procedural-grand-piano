import assert from 'node:assert/strict';
import test from 'node:test';
import {
  comparisonWorkerCount,
  parallelMap,
} from '../tools/parallel-map.mjs';

test('comparison worker count accepts both argument forms and clamps to work', () => {
  assert.equal(comparisonWorkerCount(['--jobs=4'], 480), 4);
  assert.equal(comparisonWorkerCount(['--jobs', '3'], 480), 3);
  assert.equal(comparisonWorkerCount(['--jobs=99'], 7), 7);
  assert.throws(() => comparisonWorkerCount(['--jobs=0'], 480), RangeError);
  assert.throws(() => comparisonWorkerCount(['--jobs=nope'], 480), RangeError);
  assert.throws(() => comparisonWorkerCount(['--jobs'], 480), RangeError);
  const automatic = comparisonWorkerCount([], 480);
  assert.ok(automatic >= 1 && automatic <= 8);
});

test('single-job parallel map preserves deterministic input order', async () => {
  const completed = [];
  const result = await parallelMap({
    items: [5, 2, 9, 1],
    moduleUrl: import.meta.url,
    task: 'unused-local-task',
    workerCount: 1,
    localMapper: async (value, index) => `${index}:${value * value}`,
    onProgress: (count) => completed.push(count),
  });
  assert.deepEqual(result, ['0:25', '1:4', '2:81', '3:1']);
  assert.deepEqual(completed, [1, 2, 3, 4]);
});
