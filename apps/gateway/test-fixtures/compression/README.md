# Compression evaluation set (card 13.3)

Every `*.json` file in this folder is a conversation in DiRouter's **canonical** request shape
(`CanonicalRequest` from `@dirouter/contracts`). `apps/gateway/src/compress.test.ts` runs the
compressor over each file and checks that

- no message is added, removed or reordered;
- every `tool_call` and `tool_result` keeps its id and position (the pairing is identical);
- no message ends up empty;
- the reported savings equal the real difference in characters.

It also prints the saving ratio per file.

## Adding real samples

`synthetic-claude-code.json` is hand-written in the shape Claude Code produces (Bash/Read/Grep
tools, long repeated outputs, a `git diff`). It is **not** a captured session. To evaluate on real
traffic, capture a request with `logBodies` enabled in a development environment, convert it to
canonical form, remove anything private, and drop the JSON file here. The test picks it up
automatically; no code change is needed.
