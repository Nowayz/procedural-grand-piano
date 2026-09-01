#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CORNER_STATE = Object.freeze({ TEXT: 0, CORNER: 1, RULE: 2 });

/** NFA-style scanner: every corner can open a span until a non-rule token. */
class CornerPairAutomaton {
  state = CORNER_STATE.TEXT;
  openings = [];
  segments = [];

  consume(character, column) {
    if (character === '+') {
      for (const opening of this.openings) {
        if (opening.hasRule) this.segments.push({ left: opening.left, right: column });
      }
      this.openings.push({ left: column, hasRule: false });
      this.state = CORNER_STATE.CORNER;
      return;
    }
    if ((character === '-' || character === '=') && this.openings.length > 0) {
      for (const opening of this.openings) opening.hasRule = true;
      this.state = CORNER_STATE.RULE;
      return;
    }
    this.openings = [];
    this.state = CORNER_STATE.TEXT;
  }

  scan(line) {
    for (let column = 0; column < line.length; column += 1) {
      this.consume(line[column], column);
    }
    return this.segments.sort((first, second) =>
      first.left - second.left || second.right - first.right);
  }
}

function horizontalSegments(line) {
  return new CornerPairAutomaton().scan(line);
}

const WALL_STATE = Object.freeze({ SEEK_LEFT: 0, SEEK_RIGHT: 1 });

/** Streaming best-pair recognizer for a row containing any number of walls. */
class WallPairAutomaton {
  state = WALL_STATE.SEEK_LEFT;
  leftCandidates = [];
  best;

  constructor(box) {
    this.box = box;
  }

  consume(character, column) {
    if (character !== '|') return;
    if (this.state === WALL_STATE.SEEK_RIGHT) {
      for (const left of this.leftCandidates) {
        const score = Math.abs(left - this.box.left) + Math.abs(column - this.box.right);
        if (!this.best || score < this.best.score) {
          this.best = { left, right: column, score };
        }
      }
    }
    this.leftCandidates.push(column);
    this.state = WALL_STATE.SEEK_RIGHT;
  }

  scan(line) {
    for (let column = 0; column < line.length; column += 1) {
      this.consume(line[column], column);
    }
    return this.best;
  }
}

function closestWallPair(line, box) {
  return new WallPairAutomaton(box).scan(line);
}

const BOX_STATE = Object.freeze({ CLOSED: 0, OPEN: 1 });

/** Row automaton pairing equal corner coordinates without changing their width. */
class BoxParserAutomaton {
  frames = new Map();
  boxes = [];

  constructor(lines) {
    this.lines = lines;
  }

  consume(span, row) {
    const key = `${span.left}:${span.right}`;
    const frame = this.frames.get(key) ?? { state: BOX_STATE.CLOSED };
    if (frame.state === BOX_STATE.OPEN && row >= frame.top + 2) {
      const box = { top: frame.top, bottom: row, left: span.left, right: span.right };
      const tolerance = Math.max(12, span.right - span.left);
      const hasWalls = this.lines
        .slice(frame.top + 1, row)
        .every((line) => (closestWallPair(line, box)?.score ?? Infinity) <= tolerance);
      if (hasWalls) this.boxes.push(box);
    }
    this.frames.set(key, { state: BOX_STATE.OPEN, top: row });
  }

  scan() {
    for (let row = 0; row < this.lines.length; row += 1) {
      for (const span of horizontalSegments(this.lines[row])) this.consume(span, row);
    }
    return this.boxes;
  }
}

/** Find rectangular ASCII boxes whose left wall is intact. */
export function findAsciiBoxes(lines) {
  return new BoxParserAutomaton(lines).scan();
}

function alignInteriorLine(line, boxes, lineNumber) {
  const characters = [...line];
  const edits = boxes.map((box) => {
    const walls = closestWallPair(line, box);
    if (!walls) throw new SyntaxError(`missing box walls on line ${lineNumber}`);

    const content = line.slice(walls.left + 1, walls.right).trimEnd();
    const available = box.right - box.left - 1;
    if (content.length > available) {
      throw new RangeError(
        `box content overflows by ${content.length - available} column(s) on line ${lineNumber}`,
      );
    }
    return { box, walls, content };
  });

  for (const { box, walls } of edits) {
    const affectedLeft = Math.min(walls.left, box.left);
    const affectedRight = Math.max(walls.right, box.right);
    for (let column = affectedLeft; column <= affectedRight; column += 1) {
      characters[column] = ' ';
    }
  }
  for (const { box, content } of edits) {
    characters[box.left] = '|';
    for (let column = 0; column < content.length; column += 1) {
      characters[box.left + 1 + column] = content[column];
    }
    characters[box.right] = '|';
  }

  return characters.join('').replace(/[ \t]+$/, '');
}

/**
 * Align closing walls to corner-pair widths. Horizontal edges are never changed.
 * Text is padded, never cut. The function is deterministic and preserves the
 * input's final-newline style.
 */
export function alignAsciiBoxes(source) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const hasFinalNewline = /\r?\n$/.test(source);
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  if (hasFinalNewline) lines.pop();

  const boxes = findAsciiBoxes(lines);
  const output = [...lines];

  for (let row = 0; row < lines.length; row += 1) {
    const candidates = boxes
      .filter((box) => box.top < row && row < box.bottom)
      .sort((first, second) =>
        (second.right - second.left) - (first.right - first.left));
    const active = [];
    for (const candidate of candidates) {
      const overlaps = active.some((box) =>
        candidate.left < box.right && candidate.right > box.left);
      if (!overlaps) active.push(candidate);
    }
    active.sort((first, second) => first.left - second.left);
    if (active.length > 0) output[row] = alignInteriorLine(lines[row], active, row + 1);
  }

  return output.join(newline) + (hasFinalNewline ? newline : '');
}

const TRACK_STATE = Object.freeze({ SEEK_ANCHOR: 0, ALIGN_TRACK: 1 });

/**
 * Cellular automaton for free-standing vertical connector tracks. A column is
 * an anchor only when the rows immediately above and below both continue it.
 * Nearby pipes may move into that column, but text and horizontal edges cannot.
 */
class VerticalTrackAutomaton {
  state = TRACK_STATE.SEEK_ANCHOR;

  constructor(lines, tolerance = 2) {
    this.lines = lines;
    this.tolerance = tolerance;
  }

  static connectorColumns(line) {
    const columns = new Set();
    for (let column = 0; column < line.length; column += 1) {
      if ('|+vV^'.includes(line[column])) columns.add(column);
    }
    return columns;
  }

  consume(row) {
    const above = VerticalTrackAutomaton.connectorColumns(this.lines[row - 1]);
    const below = VerticalTrackAutomaton.connectorColumns(this.lines[row + 1]);
    const anchors = [...above].filter((column) => below.has(column));
    if (anchors.length === 0) {
      this.state = TRACK_STATE.SEEK_ANCHOR;
      return;
    }

    this.state = TRACK_STATE.ALIGN_TRACK;
    const characters = [...this.lines[row]];
    const used = new Set();
    for (const anchor of anchors) {
      if ('|+vV^'.includes(characters[anchor])) continue;
      let source;
      for (let distance = 1; distance <= this.tolerance && source === undefined; distance += 1) {
        for (const candidate of [anchor - distance, anchor + distance]) {
          if (characters[candidate] === '|' && !used.has(candidate)) source = candidate;
        }
      }
      if (source === undefined) continue;
      const between = characters.slice(
        Math.min(source, anchor) + 1,
        Math.max(source, anchor) + 1,
      );
      if (between.some((character) => character !== ' ' && character !== undefined)) continue;
      characters[source] = ' ';
      characters[anchor] = '|';
      used.add(source);
    }
    this.lines[row] = characters.join('').replace(/[ \t]+$/, '');
  }

  scan() {
    for (let row = 1; row < this.lines.length - 1; row += 1) this.consume(row);
    return this.lines;
  }
}

/** Align one- or two-column drift in connector tracks outside box frames. */
export function alignVerticalConnectors(source) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const hasFinalNewline = /\r?\n$/.test(source);
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  if (hasFinalNewline) lines.pop();
  const output = new VerticalTrackAutomaton(lines).scan().join(newline);
  return output + (hasFinalNewline ? newline : '');
}

const JUNCTIONS = new Map([
  [1, '─'], [2, '╵'], [3, '┘'], [4, '─'], [5, '─'],
  [6, '└'], [7, '┴'], [8, '╷'], [9, '┐'], [10, '│'],
  [11, '┤'], [12, '┌'], [13, '┬'], [14, '├'], [15, '┼'],
]);

function gridFromSource(source) {
  const hasFinalNewline = /\r?\n$/.test(source);
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  if (hasFinalNewline) lines.pop();
  const width = Math.max(0, ...lines.map((line) => line.length));
  return {
    lines,
    grid: lines.map((line) => [...line.padEnd(width)]),
    width,
    hasFinalNewline,
    newline: source.includes('\r\n') ? '\r\n' : '\n',
  };
}

const STROKE_STATE = Object.freeze({ TEXT: 0, RULE: 1 });

/** Marks only rule runs attached to a corner or horizontal pointer. */
class StrokeRunAutomaton {
  state = STROKE_STATE.TEXT;
  start = -1;

  constructor(row, mask, leftArrow, rightArrow) {
    this.row = row;
    this.mask = mask;
    this.leftArrow = leftArrow;
    this.rightArrow = rightArrow;
  }

  close(end, terminator) {
    if (this.state !== STROKE_STATE.RULE) return;
    const before = this.row[this.start - 1];
    const attachedLeft = before === '+' || before === '<' || before === '←';
    const attachedRight = terminator === '+' || terminator === '>' || terminator === '→';
    if (attachedLeft || attachedRight) {
      this.mask.fill(1, this.start, end);
      if (before === '<' || before === '←') this.leftArrow[this.start - 1] = 1;
      if (terminator === '>' || terminator === '→') this.rightArrow[end] = 1;
    }
    this.state = STROKE_STATE.TEXT;
    this.start = -1;
  }

  consume(character, column) {
    const isRule = character === '-' || character === '=';
    if (this.state === STROKE_STATE.TEXT && isRule) {
      this.state = STROKE_STATE.RULE;
      this.start = column;
    } else if (this.state === STROKE_STATE.RULE && !isRule) {
      this.close(column, character);
    }
  }

  scan() {
    for (let column = 0; column < this.row.length; column += 1) {
      this.consume(this.row[column], column);
    }
    this.close(this.row.length, undefined);
  }
}

/** Convert structural ASCII strokes and arrowheads to Unicode glyphs. */
export function unicodeBoxDrawing(source) {
  const { lines, grid, width, hasFinalNewline, newline } = gridFromSource(source);
  const height = grid.length;
  const horizontal = Array.from({ length: height }, () => new Uint8Array(width));
  const vertical = Array.from({ length: height }, () => new Uint8Array(width));
  const node = Array.from({ length: height }, () => new Uint8Array(width));
  const rightArrow = Array.from({ length: height }, () => new Uint8Array(width));
  const leftArrow = Array.from({ length: height }, () => new Uint8Array(width));

  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      if (grid[row][column] === '|') vertical[row][column] = 1;
    }

    new StrokeRunAutomaton(
      grid[row],
      horizontal[row],
      leftArrow[row],
      rightArrow[row],
    ).scan();
  }

  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      if (grid[row][column] !== '+') continue;
      const touchesHorizontal =
        Boolean(horizontal[row][column - 1]) || Boolean(horizontal[row][column + 1]);
      const touchesVertical =
        grid[row - 1]?.[column] === '|' || grid[row + 1]?.[column] === '|';
      if (touchesHorizontal || touchesVertical) node[row][column] = 1;
    }
  }

  const connected = (row, column, direction) => {
    if (row < 0 || row >= height || column < 0 || column >= width) return false;
    return direction === 'horizontal'
      ? Boolean(horizontal[row][column] || node[row][column] ||
          leftArrow[row][column] || rightArrow[row][column])
      : Boolean(vertical[row][column] || node[row][column]);
  };

  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      if (horizontal[row][column]) {
        const mask =
          (connected(row, column - 1, 'horizontal') ? 1 : 0) |
          (connected(row - 1, column, 'vertical') ? 2 : 0) |
          (connected(row, column + 1, 'horizontal') ? 4 : 0) |
          (connected(row + 1, column, 'vertical') ? 8 : 0);
        grid[row][column] = JUNCTIONS.get(mask) ?? '─';
      }
      if (vertical[row][column]) grid[row][column] = '│';
      if (leftArrow[row][column]) grid[row][column] = '◂';
      if (rightArrow[row][column]) grid[row][column] = '▸';
      if (node[row][column]) {
        const mask =
          (connected(row, column - 1, 'horizontal') ? 1 : 0) |
          (connected(row - 1, column, 'vertical') ? 2 : 0) |
          (connected(row, column + 1, 'horizontal') ? 4 : 0) |
          (connected(row + 1, column, 'vertical') ? 8 : 0);
        grid[row][column] = JUNCTIONS.get(mask) ?? '+';
      }
    }
  }

  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const connectedAbove = connected(row - 1, column, 'vertical');
      const connectedBelow = connected(row + 1, column, 'vertical');
      if ('vV'.includes(grid[row][column]) && connectedAbove) grid[row][column] = '▼';
      if (grid[row][column] === '^' && connectedBelow) grid[row][column] = '▲';
    }
  }

  const output = grid.map((row) => row.join('').replace(/[ \t]+$/, '')).join(newline);
  return output + (hasFinalNewline ? newline : '');
}

const UNICODE_TO_ASCII = new Map([
  ...[...'─━═╌╍┄┅┈┉'].map((character) => [character, '-']),
  ...[...'│┃║╎╏┆┇┊┋'].map((character) => [character, '|']),
  ...[...'┌┐└┘├┤┬┴┼╴╵╶╷'].map((character) => [character, '+']),
  ['◀', '<'], ['▶', '>'], ['◂', '<'], ['▸', '>'],
  ['↓', 'v'], ['▼', 'v'], ['↑', '^'], ['▲', '^'],
]);

/** Project Unicode diagram strokes onto an equal-width ASCII parsing grid. */
export function asciiDiagramProjection(source) {
  return [...source].map((character) => UNICODE_TO_ASCII.get(character) ?? character).join('');
}

const ARROW_STATE = Object.freeze({ TEXT: 0, DASHES: 1, LEFT_DASHES: 2 });

/** Finite-state transducer for short prose arrows versus drawn pointer lines. */
class InlineArrowAutomaton {
  state = ARROW_STATE.TEXT;
  dashCount = 0;
  output = '';

  flushDashes() {
    if (this.state === ARROW_STATE.LEFT_DASHES) {
      this.output += this.dashCount === 1 ? '←' : `<${'-'.repeat(this.dashCount)}`;
    } else if (this.state === ARROW_STATE.DASHES) {
      this.output += '-'.repeat(this.dashCount);
    }
    this.state = ARROW_STATE.TEXT;
    this.dashCount = 0;
  }

  consume(character) {
    if (this.state === ARROW_STATE.TEXT) {
      if (character === '-') {
        this.state = ARROW_STATE.DASHES;
        this.dashCount = 1;
      } else if (character === '<') {
        this.state = ARROW_STATE.LEFT_DASHES;
        this.dashCount = 0;
      } else {
        this.output += character;
      }
      return;
    }

    if (character === '-') {
      this.dashCount += 1;
      return;
    }
    if (
      this.state === ARROW_STATE.DASHES &&
      this.dashCount === 1 &&
      character === '>'
    ) {
      this.output += '→';
      this.state = ARROW_STATE.TEXT;
      this.dashCount = 0;
      return;
    }
    this.flushDashes();
    this.consume(character);
  }

  scan(source) {
    for (const character of source) this.consume(character);
    this.flushDashes();
    return this.output;
  }
}

function normalizeInlineArrows(source) {
  return new InlineArrowAutomaton().scan(source);
}

/** Align an ASCII or Unicode diagram and optionally render it as Unicode. */
export function formatAsciiDiagram(source, { unicode = true } = {}) {
  const aligned = alignVerticalConnectors(
    alignAsciiBoxes(asciiDiagramProjection(source)),
  );
  if (!unicode) return aligned;

  // A short arrow embedded in prose is semantic text, not a drawn line. The
  // second alignment pass restores corner-defined walls after its width drops
  // from two columns to one. Longer dashed connectors remain structural.
  const withTextArrows = normalizeInlineArrows(aligned);
  return unicodeBoxDrawing(alignVerticalConnectors(alignAsciiBoxes(withTextArrows)));
}

function usage() {
  return `Usage: node <formatter-script> [--write | --check] [--ascii] [file]

With no file, reads stdin and writes the aligned Unicode diagram to stdout.
--write updates the named file in place.
--check exits with status 1 when the named file or stdin needs formatting.
--ascii aligns the diagram without converting box strokes and pointers.`;
}

function run(argumentsList) {
  if (argumentsList.includes('--help') || argumentsList.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const write = argumentsList.includes('--write');
  const check = argumentsList.includes('--check');
  const unicode = !argumentsList.includes('--ascii');
  const files = argumentsList.filter((argument) => !argument.startsWith('-'));
  if (files.length > 1 || (write && check) || (write && files.length !== 1)) {
    throw new TypeError(usage());
  }

  const file = files[0];
  const source = readFileSync(file ?? 0, 'utf8');
  const aligned = formatAsciiDiagram(source, { unicode });

  if (check) {
    if (aligned !== source) {
      process.stderr.write(`${file ?? 'stdin'}: ASCII boxes are not aligned\n`);
      process.exitCode = 1;
    }
  } else if (write) {
    writeFileSync(file, aligned);
  } else {
    process.stdout.write(aligned);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
