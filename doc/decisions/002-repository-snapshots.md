# Decision 002: public GitHub snapshots

## Status

Accepted for TASK-005; implementation and offline tests are reviewable. A fixed-SHA archive was fetched from the public codeload host and processed; a real provider run remains unauthorized and unverified.

## Decision

- Accept only a public GitHub HTTPS owner/repository URL with an optional validated ref.
- Resolve branch/tag refs using GitHub's repository and commit endpoints. When the caller already supplies a full 40-character lowercase commit SHA, treat it as immutable and request only the archive for that SHA; this avoids an unnecessary mutable-ref lookup and works when unauthenticated API quota is exhausted.
- Fetch the source archive from codeload.github.com by the resolved full SHA. Do not follow redirects.
- Enforce compressed bytes while reading the response and expanded bytes, regular-file count, path structure and allowed entry type while streaming tar-gzip extraction.
- Reject traversal, links, special files, duplicate paths and structural PAX overrides. The codeload tar uses one global PAX comment field containing the commit SHA; only that harmless metadata field is accepted and ignored. Per-entry PAX overrides and unknown global keys are rejected.
- Expose the extracted snapshot to PI through only list, bounded text read, text search and evidence registration tools. Repository content, including any AGENTS.md, is untrusted data. No shell, arbitrary network, write, install or repository-code execution tool is provided.
- Validate model-produced report claims against the existing versioned report protocol and re-read every cited source range before publishing artifacts.
- Delegate per-run time, model-call, tool-call, token and cost enforcement to the existing PI runtime budget ledger. A cancelled result retains its explicit limit reason; no subsequent model or tool call is admitted.

## Evidence and remaining limits

- Fixed public sample: sindresorhus/slugify, tag v3.0.0, commit 7c318bd1aa4b4affab29761f15a9604323fe2a3b, MIT license.
- A codeload archive at the fixed SHA was fetched and safely extracted in this environment. The source tree contains 13 files; 8,057 compressed bytes expanded to 50,688 tar bytes.
- GitHub API branch/tag resolution returned an unauthenticated rate-limit response in this environment. The ref-to-SHA route is covered by controlled HTTP tests; the real sample run uses the known full SHA and skips mutable-ref resolution.
- A faux provider produced a schema-validated report from the real fixed snapshot. This verifies the retrieval and artifact pipeline without representing model quality.
- No real model was invoked. Real semantic accuracy, recall, citation support and online cost remain unverified.
- Archive compatibility is intentionally conservative: unknown PAX semantics, links, special files, large repositories, private repositories, LFS and submodules are unsupported.
