import { chunkDocument, passthrough } from "./chunkers.ts";

const options = { threshold: 12, target: 20, max: 30, overlap: 5 };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("short text uses one passthrough chunk", () => {
  const chunks = chunkDocument({ content: "short text" }, options);
  assert(
    JSON.stringify(chunks) === JSON.stringify(passthrough("short text")),
    "short text must pass through",
  );
});

Deno.test("long bilingual text is bounded and indexed continuously", () => {
  const content = "第一句。第二句！Third sentence. Fourth sentence?\n\n".repeat(
    8,
  );
  const chunks = chunkDocument({ content }, options);
  assert(chunks.length > 1, "long text must split");
  chunks.forEach((chunk, index) => {
    assert(chunk.content.length <= options.max, "chunk exceeds hard max");
    assert(chunk.chunk_index === index, "chunk indexes must be continuous");
  });
});

Deno.test("chunking is deterministic", () => {
  const content = "一个很长的段落，没有合适的断点".repeat(10);
  assert(
    JSON.stringify(chunkDocument({ content }, options)) ===
      JSON.stringify(chunkDocument({ content }, options)),
    "same input must produce same output",
  );
});

Deno.test("empty and whitespace inputs do not throw", () => {
  for (const content of ["", "   ", "\n\n", "边界。".repeat(4)]) {
    const chunks = chunkDocument({ content }, options);
    assert(chunks.length >= 1, "input must produce a stable chunk result");
  }
});
