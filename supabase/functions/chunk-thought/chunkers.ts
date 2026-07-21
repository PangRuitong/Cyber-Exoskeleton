export const DEFAULT_CHUNK_THRESHOLD = 1200;
export const DEFAULT_CHUNK_TARGET = 800;
export const DEFAULT_CHUNK_MAX = 1200;
export const DEFAULT_CHUNK_OVERLAP = 150;

export type Chunk = {
  chunk_index: number;
  content: string;
  chunker: string;
};

export type Chunker = {
  name: string;
  chunk(content: string): Chunk[];
};

export type ChunkingOptions = {
  threshold: number;
  target: number;
  max: number;
  overlap: number;
};

export type ChunkableDocument = { content: string };

function readPositiveInteger(name: string, fallback: number) {
  const value = Number.parseInt(Deno.env.get(name) ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function optionsFromEnvironment(): ChunkingOptions {
  const max = readPositiveInteger("CHUNK_MAX", DEFAULT_CHUNK_MAX);
  const target = Math.min(
    readPositiveInteger("CHUNK_TARGET", DEFAULT_CHUNK_TARGET),
    max,
  );
  const threshold = readPositiveInteger(
    "CHUNK_THRESHOLD",
    DEFAULT_CHUNK_THRESHOLD,
  );
  const overlap = Math.min(
    readPositiveInteger("CHUNK_OVERLAP", DEFAULT_CHUNK_OVERLAP),
    max - 1,
  );
  return { threshold, target, max, overlap };
}

function nonEmpty(parts: string[]) {
  return parts.filter((part) => part.length > 0);
}

function splitParagraphs(content: string) {
  return nonEmpty(content.match(/[\s\S]*?(?:\n\n|$)/g) ?? []);
}

function splitLines(content: string) {
  return nonEmpty(content.match(/[^\n]*(?:\n|$)/g) ?? []);
}

function splitSentences(content: string) {
  return nonEmpty(
    content.match(/[\s\S]*?[。！？.!?]+(?:\s+|$)|[\s\S]+$/g) ?? [],
  );
}

function forceSplit(content: string, max: number, overlap: number) {
  const parts: string[] = [];
  let start = 0;
  while (start < content.length) {
    const end = Math.min(start + max, content.length);
    parts.push(content.slice(start, end));
    if (end === content.length) break;
    start = end - overlap;
  }
  return parts;
}

function splitRecursively(
  content: string,
  max: number,
  overlap: number,
  level = 0,
): string[] {
  if (content.length <= max) return [content];
  const splitters = [splitParagraphs, splitLines, splitSentences];
  if (level >= splitters.length) return forceSplit(content, max, overlap);

  const pieces = splitters[level](content);
  if (pieces.length <= 1) {
    return splitRecursively(content, max, overlap, level + 1);
  }
  return pieces.flatMap((piece) =>
    splitRecursively(piece, max, overlap, level + 1)
  );
}

function assemble(pieces: string[], target: number, max: number) {
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current.length > 0 && current.length + piece.length > target) {
      chunks.push(current);
      current = "";
    }
    if (current.length + piece.length > max) {
      if (current) chunks.push(current);
      chunks.push(piece);
      current = "";
    } else {
      current += piece;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function passthrough(content: string): Chunk[] {
  return [{ chunk_index: 0, content, chunker: "passthrough" }];
}

export function structure(
  content: string,
  options = optionsFromEnvironment(),
): Chunk[] {
  const pieces = splitRecursively(content, options.max, options.overlap);
  return assemble(pieces, options.target, options.max).map((
    chunk,
    chunk_index,
  ) => ({
    chunk_index,
    content: chunk,
    chunker: "structure",
  }));
}

export function route(
  doc: ChunkableDocument,
  options = optionsFromEnvironment(),
): Chunker {
  return doc.content.length <= options.threshold
    ? { name: "passthrough", chunk: passthrough }
    : { name: "structure", chunk: (content) => structure(content, options) };
}

export function chunkDocument(
  doc: ChunkableDocument,
  options = optionsFromEnvironment(),
) {
  return route(doc, options).chunk(doc.content);
}
