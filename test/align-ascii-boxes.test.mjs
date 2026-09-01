import assert from 'node:assert/strict';
import test from 'node:test';
import {
  alignAsciiBoxes,
  alignVerticalConnectors,
  asciiDiagramProjection,
  findAsciiBoxes,
  formatAsciiDiagram,
  unicodeBoxDrawing,
} from '../tools/align-ascii-boxes.mjs';

test('finds side-by-side ASCII boxes', () => {
  const lines = [
    '+-------+  +-----+',
    '| left  |  | x   |',
    '+-------+  +-----+',
  ];
  assert.deepEqual(
    findAsciiBoxes(lines).map(({ top, bottom, left, right }) => ({
      top, bottom, left, right,
    })),
    [
      { top: 0, bottom: 2, left: 0, right: 8 },
      { top: 0, bottom: 2, left: 11, right: 17 },
    ],
  );
});

test('aligns early and late right walls without moving neighboring boxes', () => {
  const input = [
    '+-------+  +-----+',
    '| one |    | x |',
    '| longer | | yy    |',
    '+-------+  +-----+',
    '',
  ].join('\n');
  const expected = [
    '+-------+  +-----+',
    '| one   |  | x   |',
    '| longer|  | yy  |',
    '+-------+  +-----+',
    '',
  ].join('\n');
  assert.equal(alignAsciiBoxes(input), expected);
  assert.equal(alignAsciiBoxes(expected), expected);
});

test('aligns both walls to their detected corner pair without resizing it', () => {
  const input = '  +-----+\n | x   |\n  +-----+\n';
  const expected = '  +-----+\n  | x   |\n  +-----+\n';
  assert.equal(alignAsciiBoxes(input), expected);
});

test('infers width from matching corners and preserves an internal edge junction', () => {
  const input = '+-------+\n| body |\n+---+---+\n';
  const expected = '+-------+\n| body  |\n+---+---+\n';
  assert.equal(alignAsciiBoxes(input), expected);
});

test('does not resize unmatched horizontal edges', () => {
  const input = '+-------+\n| body |\n+---------+\n';
  assert.equal(alignAsciiBoxes(input), input);
});

test('refuses to truncate overflowing content', () => {
  const input = '+---+\n| too long |\n+---+\n';
  assert.throws(
    () => alignAsciiBoxes(input),
    /overflows by 6 column\(s\) on line 2/,
  );
});

test('preserves CRLF and missing final newlines', () => {
  assert.equal(
    alignAsciiBoxes('+---+\r\n| x|\r\n+---+\r\n'),
    '+---+\r\n| x |\r\n+---+\r\n',
  );
  assert.equal(alignAsciiBoxes('+---+\n| x|\n+---+'), '+---+\n| x |\n+---+');
});

test('converts box corners, walls, rules, and vertical pointers to Unicode', () => {
  const input = '+---+\n| x |\n+---+\n  |\n  v\n';
  const expected = '┌───┐\n│ x │\n└─┬─┘\n  │\n  ▼\n';
  assert.equal(unicodeBoxDrawing(input), expected);
});

test('derives tees, crossings, and horizontal pointers from connectivity', () => {
  const input = '  |\n--+-->\n  |\n  v';
  const expected = '  │\n──┼──▸\n  │\n  ▼';
  assert.equal(unicodeBoxDrawing(input), expected);
});

test('formats misaligned ASCII as an aligned Unicode diagram by default', () => {
  assert.equal(
    formatAsciiDiagram('+-----+\n| x |\n+-----+\n'),
    '┌─────┐\n│ x   │\n└─────┘\n',
  );
  assert.equal(
    formatAsciiDiagram('+-----+\n| x |\n+-----+\n', { unicode: false }),
    '+-----+\n| x   |\n+-----+\n',
  );
});

test('realigns an existing Unicode box and preserves its one-column geometry', () => {
  const input = [
    '┌────────────┐',
    '│ • losses │',
    '│ resonances   │',
    '└────────────┘',
    '',
  ].join('\n');
  const expected = [
    '┌────────────┐',
    '│ • losses   │',
    '│ resonances │',
    '└────────────┘',
    '',
  ].join('\n');
  assert.equal(formatAsciiDiagram(input), expected);
  assert.equal(formatAsciiDiagram(expected), expected);
});

test('projects Unicode strokes and pointers without changing column count', () => {
  const unicode = '┌─┬─┐ →\n│ ▼ │ ←\n└─┴─┘';
  const projected = '+-+-+ →\n| v | ←\n+-+-+';
  assert.equal(asciiDiagramProjection(unicode), projected);
  assert.equal([...unicode].length, [...projected].length);
});

test('converts multiple connected downward pointers on one row', () => {
  const input = '|    |\nv    v';
  assert.equal(unicodeBoxDrawing(input), '│    │\n▼    ▼');
});

test('does not interpret a literal plus in box text as a structural junction', () => {
  const input = '+------------------+\n| frequency + speed|\n+------------------+\n';
  const expected = '┌──────────────────┐\n│ frequency + speed│\n└──────────────────┘\n';
  assert.equal(formatAsciiDiagram(input), expected);
});

test('distinguishes inline text arrows from structural pointer lines', () => {
  const input = [
    '+------------------+',
    '| input -> output |',
    '+------------------+',
    '         |',
    '---------+---->',
    '',
  ].join('\n');
  const expected = [
    '┌──────────────────┐',
    '│ input → output   │',
    '└────────┬─────────┘',
    '         │',
    '─────────┴────▸',
    '',
  ].join('\n');
  assert.equal(formatAsciiDiagram(input), expected);
});

test('vertical-track automaton repairs a one-column drift beside text', () => {
  const input = [
    '              |',
    ' seeded noise|',
    '       |      |',
    '',
  ].join('\n');
  const expected = [
    '              |',
    ' seeded noise |',
    '       |      |',
    '',
  ].join('\n');
  assert.equal(alignVerticalConnectors(input), expected);
});
