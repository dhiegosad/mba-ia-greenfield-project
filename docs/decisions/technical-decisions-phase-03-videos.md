---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-07-21
scope_description: "Backend infrastructure for video upload, processing, and delivery: message queue selection, large-file upload strategy, FFmpeg-based processing, URL uniqueness and streaming, and video status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Videos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the video module (upload orchestration, processing job enqueue, streaming proxy, download), the video worker (FFmpeg processing container), and infrastructure (MinIO storage, Redis/BullMQ queue).
- `next-frontend/` — Frontend deferred: video watch page, upload UI, and player are out of scope for this phase. No open decision in this document for the frontend subproject.

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Servico de processamento em segundo plano (filas)

**Context:** The architecture diagram defines a Message Queue container (currently "TBD") that decouples the API from video processing. When a video upload completes, the API publishes a job; a separate worker consumes it, runs FFmpeg for metadata extraction and thumbnail generation, and updates the database. The queue technology choice affects infrastructure complexity, NestJS integration quality, job reliability, and operational overhead. PostgreSQL is already in the stack; adding a queue-specific dependency is acceptable if justified by features.

**Options:**

### Option A: BullMQ + Redis
- BullMQ is the de facto queue library for NestJS (maintained by the NestJS core team via `@nestjs/bullmq`). It uses Redis as the backend. The `@nestjs/bullmq` package provides decorator-based job registration (`@Processor`, `@Process`), `BullModule.forRootAsync` for configuration, and deep integration with NestJS DI (inject services into processors).
- **Pros:** First-class NestJS integration (`@nestjs/bullmq` v11, maintained by NestJS core team). Rich feature set: retries with exponential backoff, delayed jobs, priorities, job progress reporting, concurrency control, rate limiting, job deduplication. Redis is lightweight (~30MB container), trivial to add to Docker Compose, and the project has no infrastructure constraints against it. Large community and battle-tested at scale (iFood, Shopify). Separating processing state from the application database avoids polluting the operational DB with queue internals.
- **Cons:** Adds Redis as a new infrastructure dependency (one more container to manage). Redis is in-memory by default — job data is lost on restart unless Redis persistence (RDB/AOF) is configured. The `@nestjs/bullmq` v11 API has breaking changes vs v10 — must verify installed version. BullMQ requires `ioredis` as a peer dependency.

### Option B: RabbitMQ + amqplib
- RabbitMQ is a dedicated message broker implementing AMQP 0-9-1. NestJS provides `@nestjs/microservices` with a RabbitMQ transport. Exchanges and queues are configured declaratively; consumers bind to queues via routing keys.
- **Pros:** Mature, battle-tested broker with 15+ years of production use. Rich routing patterns (direct, topic, fanout, headers exchanges). Dead Letter Exchanges for failed message handling. Management UI built-in. No data loss risk — messages persisted to disk.
- **Cons:** Significantly more complex setup (Erlang runtime, management plugin configuration). NestJS integration is less polished than BullMQ — uses the generic `@nestjs/microservices` transport layer rather than a dedicated queue module. Heavier resource footprint (~200MB+ container). AMQP concepts (exchanges, bindings, routing keys) have a steeper learning curve. Overkill for a single-producer, single-consumer video processing pipeline — the routing power is unused.

### Option C: pg-boss (PostgreSQL-based)
- pg-boss is a job queue built entirely on PostgreSQL, using `SKIP LOCKED` and `FOR UPDATE` for job coordination. No additional infrastructure — reuses the existing PostgreSQL instance. NestJS community wrapper `nest-pg-boss` exists but is not officially maintained.
- **Pros:** Zero new infrastructure — reuses the PostgreSQL already in the stack. Atomic job operations within existing transactions. No separate process to monitor or maintain.
- **Cons:** No official NestJS package — community wrappers are sparsely maintained. PostgreSQL is not designed as a queue — high-throughput polling creates unnecessary DB load, and the `SKIP LOCKED` pattern has known visibility gaps under concurrent consumers. Missing features standard in BullMQ: no job progress reporting, no built-in rate limiting, weaker retry control. Mixing operational (queue) and domain (video metadata) data in the same DB complicates backups, replication, and monitoring. The video processing use case is CPU-bound, not I/O-bound — a dedicated queue that can handle backpressure is more appropriate than polling a relational DB.

**Recommendation:** **Option A (BullMQ + Redis)** — BullMQ provides the best NestJS integration with minimal infrastructure overhead. Redis is lightweight, trivially added to Docker Compose, and separates processing state from the domain database. The feature set (retries, progress reporting, concurrency control) directly supports the video processing requirements. The "new dependency" cost is low: one container, one `@nestjs/bullmq` package, and `ioredis` peer dependency.

**Decision:** A (BullMQ + Redis)

**Libraries:** `@nestjs/bullmq@^11.x`, `bullmq@^5.x`, `ioredis@^5.x`

---

## TD-02: Upload Strategy for Large Files (up to 10 GB)

**Scope:** Backend

**Capability:** Upload de videos com suporte a arquivos de ate 10GB sem impacto na performance

**Context:** The project plan requires support for video uploads up to 10 GB without degrading system performance. Passing a 10 GB file through the NestJS API (multipart/form-data via Express) would consume memory, block the event loop, and impose HTTP timeouts — this is a non-starter. The upload must bypass the API entirely, going directly from the client to object storage (MinIO). The API's role is to orchestrate: pre-cadastro do video, geraao de URLs pre-assinadas, and notification of completion.

**Options:**

### Option A: Pre-signed PUT URL (single-shot)
- The client requests an upload URL from the API. The API generates a MinIO pre-signed PUT URL valid for a configurable TTL (e.g., 10-60 minutes) and returns it along with a video ID. The client uploads the entire file in a single HTTP PUT directly to MinIO. After completion, the client notifies the API, which enqueues the processing job.
- **Pros:** Simplest implementation — single round-trip to get the URL, single PUT to upload. No multipart orchestration. MinIO SDK has built-in `presignedPutObject()`. Works well for files up to a few GB on stable connections.
- **Cons:** Single PUT for 10 GB is fragile — any network interruption forces a full restart. No progress visibility during upload. No built-in integrity verification beyond HTTP. MinIO pre-signed URLs have a maximum expiration of 7 days by default (configurable). Single-threaded upload — cannot leverage parallel connections for speed.

### Option B: Multipart upload with pre-signed URLs per part
- The API initiates a MinIO multipart upload session, returns an upload ID. For each part the client wants to upload (typically 5 MB to 5 GB per part, up to 10,000 parts), it requests a pre-signed URL from the API (or the API returns all part URLs upfront). The client uploads parts in parallel, then calls the API to complete the multipart session, which concatenates the parts into the final object.
- **Pros:** Resumable — only failed parts need retry. Parallel upload — saturate the client's bandwidth for faster transfers. Industry standard (S3 multipart upload). MinIO supports it natively via `createMultipartUpload`, `presignedUrl` per part, `completeMultipartUpload`. Built-in integrity via ETag per part and final MD5 checksum on completion. Progress can be tracked per-part by the client.
- **Cons:** More API surface to implement (initiate, presign per part, complete, abort). Client must implement multipart logic (but S3 SDKs handle this). More complex error handling (cleanup of incomplete multipart uploads via lifecycle policies).

### Option C: TUS protocol (resumable uploads)
- TUS is an open protocol for resumable file uploads. The client sends PATCH requests with `Upload-Offset` headers; the server stores the uploaded bytes. A TUS server sits in front of MinIO (or the NestJS API implements the TUS protocol). After the TUS upload completes, the file is transferred to MinIO.
- **Pros:** Resumable by design — survives connection loss and browser restarts. Standard protocol with client libraries for browsers and mobile. Infinite pause/resume. Built-in checksum verification.
- **Cons:** Requires a TUS server (e.g., `tus-node-server`, or a separate tusd container) in front of MinIO — adds infrastructure complexity. The file passes through the TUS server, then must be transferred to MinIO — doubling the I/O. TUS protocol adds HTTP verbosity (multiple PATCH requests with offset tracking). For a video platform where uploads are typically one-shot (not long-pause-resume workflows), the protocol overhead is disproportionate. The `tus-node-server` package has breaking changes between versions and variable NestJS compatibility.

**Recommendation:** **Option B (Multipart upload with pre-signed URLs per part)** — Resumability and parallel upload directly address the 10 GB requirement. MinIO's native S3 multipart API provides this without additional infrastructure. The API surface increase (initiate, presign per part, complete, abort) is manageable — roughly four endpoints. Client-side complexity is handled by the S3 SDK, which already implements multipart with configurable part size and concurrency. This is the same pattern used by YouTube, Vimeo, and AWS S3 itself for large object uploads.

**Decision:** B (Multipart upload with pre-signed URLs per part)

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

---

## TD-03: Video Processing — FFmpeg Worker Architecture

**Scope:** Backend

**Capability:** Processamento automatico do video apos upload (extracao de duracao e metadados), Geracao automatica de thumbnail a partir de um frame do video

**Context:** After upload completes, the video must be processed: extract metadata (duration, resolution, codec, bitrate) and generate a thumbnail from a frame (default: 10 seconds in, or 30% of duration). This is CPU-intensive work and cannot run in the API process. FFmpeg is the de facto standard for video processing — the architecture diagram already names it as the worker. The decision here is how to structure the worker, what FFmpeg commands to use, and how the worker communicates results back to the API.

**Options:**

### Option A: Standalone Node.js worker process with fluent-ffmpeg
- A separate Node.js process (not NestJS) that consumes BullMQ jobs, shells out to `ffprobe` for metadata and `ffmpeg` for thumbnail generation. Uses the `fluent-ffmpeg` npm package for a programmatic API over the CLI tools. Runs in its own Docker container with FFmpeg installed. On completion, it writes results directly to the database (via TypeORM) and updates the video status.
- **Pros:** Full control over FFmpeg invocation — parameterized commands for thumbnail timestamp, resolution, format. `fluent-ffmpeg` handles stream parsing and progress events. Direct DB access avoids API round-trips for status updates. Process isolation — CPU-intensive FFmpeg work never touches the API's event loop.
- **Cons:** Database access from the worker duplicates the connection configuration and TypeORM entity knowledge (though the entities can be shared). Worker must have access to DB credentials. Node.js worker with `fluent-ffmpeg` pulls in the full FFmpeg binary (~80 MB Docker layer).

### Option B: NestJS standalone app as worker (same codebase, different entry point)
- The worker is a NestJS application using the same codebase but a different `main.ts` entry point (e.g., `main.worker.ts`). It imports only the modules it needs (BullMQ processor, TypeORM for the Video entity, Config). The `VideosModule` is shared between API and worker — the processor lives inside `VideosModule` and is only activated in the worker entry point.
- **Pros:** Shared TypeORM entities, config, and modules — no duplication. Same dependency injection, same repository pattern, same migration pipeline. NestJS `@nestjs/bullmq` processors can live in the same module tree and are only registered when `BullModule.registerQueue()` is imported. Single `tsconfig.json`, single `package.json`. Type-safety across the API-worker boundary for shared interfaces (job payload types).
- **Cons:** Worker container must include the entire NestJS codebase, not just the processing code — larger image. Slightly more complex Docker setup (two services from the same build, different entry commands).

### Option C: Shell script worker with ffprobe/ffmpeg directly
- The worker is a minimal shell script that polls the queue (or a simpler mechanism like a PostgreSQL jobs table), runs `ffprobe` and `ffmpeg` commands, and writes results via `psql` or a simple HTTP callback to the API.
- **Pros:** Minimal runtime dependencies — just `ffmpeg`, `curl`, and `psql`. Smallest Docker image. No Node.js overhead. Easy to debug with shell commands.
- **Cons:** No type safety. Error handling is primitive (shell exit codes). Schema changes require updating both the shell script and the API. No structured logging or observability. Inconsistent with the project's TypeScript/NestJS stack — different language, different tooling, different testing strategy.

**Recommendation:** **Option B (NestJS standalone app as worker)** — Sharing the codebase eliminates entity/config duplication, keeps the stack uniform (TypeScript/NestJS end-to-end), and lets `@nestjs/bullmq` processors leverage the same DI and repository patterns as the API. The larger image is acceptable — both the API and worker containers build from the same Dockerfile, just with different `CMD` directives. For FFmpeg specifics: `ffprobe -v quiet -print_format json -show_format -show_streams <file>` for metadata, `ffmpeg -i <file> -ss 00:00:10 -vframes 1 -q:v 2 <thumbnail.jpg>` for thumbnail at 10s.

**Decision:** B (NestJS standalone app as worker)

**Libraries:** `fluent-ffmpeg@^2.x` (Node.js wrapper for ffprobe/ffmpeg CLI)

---

## TD-04: Video URL Uniqueness and Streaming Strategy

**Scope:** Backend

**Capability:** URL unica por video, sem conflito com outros videos, Reproducao via streaming (sem necessidade de download completo), Download do video pelo usuario

**Context:** Each video needs a unique URL. Users must be able to stream (play without full download) and download the video. The URL serves as both the public identifier and the storage key. Streaming requires HTTP Range request support (206 Partial Content) so browsers and video players can seek without downloading the entire file. The decision covers: how to generate unique IDs, how to serve streaming, and whether streaming goes through the API or directly from MinIO.

**Options:**

### Option A: nanoid + API proxy for streaming
- Generate a short unique ID with `nanoid` (e.g., 11 chars, URL-safe). The video's public URL is `/videos/:id`. For streaming, the API acts as a reverse proxy — it receives Range requests, fetches the corresponding byte range from MinIO via `getObject()` with `Range` header, and streams the response back to the client with `Content-Range` and `Accept-Ranges` headers.
- **Pros:** Short, clean URLs. API controls access — can enforce visibility (public/unlisted/private in the future), count views, apply rate limiting. No direct MinIO exposure to clients. `nanoid` has zero collisions at 11 chars for millions of IDs (collision probability ~1% at 1 billion years with 1000 IDs/hour). Full control over response headers (Content-Type, Content-Disposition for download).
- **Cons:** Every byte of streaming passes through the API — increases API bandwidth and CPU usage proportional to video traffic. For popular videos, the API becomes a bottleneck. Range request proxying requires careful streaming implementation (pipe with backpressure, handle multi-range requests, handle conditional requests). The API's Docker container network bandwidth is shared with other API operations.

### Option B: nanoid + direct MinIO streaming (pre-signed GET URLs)
- Generate a unique ID with `nanoid`. The API returns a pre-signed MinIO GET URL (short-lived, e.g., 1-6 hours for streaming, 5 minutes for download). The client streams/downloads directly from MinIO. The API is only involved in generating the URL and tracking metadata.
- **Pros:** Zero API bandwidth cost for streaming — MinIO handles all data transfer. Scales independently — API traffic does not increase with video popularity. Simpler API implementation — just generate the pre-signed URL. MinIO has built-in Range request support and proper Content-Type handling.
- **Cons:** Pre-signed URLs are temporary — frontend must refresh them when they expire (adds complexity for long viewing sessions). Access control is coarse — the URL is valid for anyone who has it during its TTL (though TTL is short). Cannot count views server-side from the streaming request (would need a separate "view started" event from the frontend). Public video URLs resolve to pre-signed URLs, not to the clean `/videos/:id` path in the browser.

### Option C: UUID + direct MinIO streaming with proxy fallback
- Use UUIDv4 (or ULID) for video IDs. Serve streaming via pre-signed MinIO URLs for the actual data, but keep the API endpoint `/videos/:id` as a redirect — accessing it returns 302 to a fresh pre-signed URL for streaming, or sets Content-Disposition for download.
- **Pros:** Clean `/videos/:id` URLs in the browser, with backend control over access. Streaming bandwidth goes to MinIO, not the API. UUIDv4 is collision-free and natively supported (PostgreSQL `uuid` type). View counting is possible (the API processes the initial request). Separates metadata (API) from file data (MinIO).
- **Cons:** UUID is 36 characters — longer URLs. 302 redirect adds one HTTP round-trip before streaming starts. Pre-signed URL TTL management — short TTL means frequent refreshes for long videos; long TTL weakens access control. The frontend must handle redirects and token expiry.

**Recommendation:** **Option B (nanoid + direct MinIO streaming with pre-signed GET URLs)** — For Phase 03, direct MinIO streaming is the pragmatic choice: it keeps the API focused on metadata and offloads the heavy data transfer to MinIO, which is purpose-built for it. The pre-signed URL expiry is acceptable — 6-hour TTL covers most viewing sessions, and the frontend can silently refresh the URL if needed (handled in a future frontend phase). `nanoid` at 11 characters gives short, readable, collision-free URL-safe IDs. For download, the API returns a short-lived (5-minute) pre-signed URL with `Content-Disposition: attachment`. View counting is deferred to Phase 05 (video watch page) and will use a separate "playback started" event from the frontend.

**Decision:** B (nanoid + direct MinIO streaming with pre-signed GET URLs)

**Libraries:** `nanoid@^5.x`

---

## TD-05: Video Status Lifecycle

**Scope:** Backend

**Capability:** Pre-cadastro automatico do video como rascunho ao iniciar o upload

**Context:** The video goes through several states from initial registration to availability. The status lifecycle drives the upload flow, the processing pipeline, and the API's behavior (which videos appear in listings, which are streamable). The status must be stored in the database and transition atomically. The lifecycle must handle failure gracefully — a video stuck in "processing" forever is a worse user experience than an explicit error state allowing retry.

**Options:**

### Option A: Linear status enum (Draft → Processing → Ready / Error)
- A simple enum on the Video entity: `draft`, `uploading`, `processing`, `ready`, `error`. Transitions are sequential: draft → uploading (when upload begins), uploading → processing (when upload completes), processing → ready (on success), processing → error (on failure). From error, the video can be re-submitted for processing (error → processing).
- **Pros:** Simple, easy to understand, easy to query. Covers the essential flow. Minimal code — a single `status` column updated at each step. Matches the project plan's described flow exactly.
- **Cons:** Cannot distinguish between "never uploaded" and "upload failed" — both are `error` after upload. No retry count tracking — cannot implement exponential backoff or max retries without a separate column. Lost granularity: cannot tell if a video in "error" failed during metadata extraction or thumbnail generation.

### Option B: Status + substatus (richer state machine)
- A primary status enum (`draft`, `uploading`, `processing`, `ready`, `error`) plus a `processing_step` field (`metadata`, `thumbnail`) that tracks which step the worker is on. An `error_retries` counter allows automatic retry up to a configured maximum. A `status_message` field stores the last error message for debugging.
- **Pros:** Granular failure visibility — know exactly which step failed. Automatic retry with configurable max attempts. Better operability — `status_message` provides debugging context without querying logs. The `processing_step` field enables future progress reporting (e.g., "Extracting metadata..." in the UI).
- **Cons:** Slightly more complex schema (2 extra columns). More state transitions to test. The `processing_step` is only meaningful during the `processing` status — a nullable column that is mostly null.

### Option C: Event-sourced status (separate status_history table)
- The video's current status is derived from the latest event in a `video_events` table. Each event records a status transition with a timestamp and optional metadata. The current status is materialized on the video row (denormalized for fast queries) and updated atomically on each event insertion.
- **Pros:** Full audit trail — every status transition is recorded with timestamp and context. Enables analytics (how long does processing take on average?). Supports complex workflows (status cannot go backwards, specific transitions only from specific states). The event log can drive UI notifications.
- **Cons:** Significant schema and code complexity for Phase 03. Querying the event table requires joins or separate queries. Over-engineered for a 5-state lifecycle with simple transitions. The project plan has no requirement for status audit trail or transition analytics.

**Recommendation:** **Option B (Status + substatus)** — The richer state machine adds meaningful value (error granularity, automatic retry) with minimal schema complexity (2 extra columns, one of which is nullable). The `processing_step` and `status_message` fields provide immediate debugging value during development and future operability in production. The project plan's status flow (draft → processing → ready/error) is preserved as the primary status; the substatus adds granularity without changing the fundamental model. Retry: max 3 attempts with 30-second delay between retries (configurable).

**Decision:** B (Status + substatus with retry)

---

## TD-06: Object Storage Organization (Buckets and Key Structure)

**Scope:** Backend

**Capability:** Servico de armazenamento de arquivos (videos e thumbnails)

**Context:** MinIO will be used as the S3-compatible object storage (the project plan already names S3/MinIO; this is not a choice to reopen). The decision here is about organization: how to structure buckets and object keys for videos and thumbnails. The key structure affects URL uniqueness, storage management, and future migration to AWS S3. The architecture diagram shows the Object Storage container connected to both the API (for uploads) and the Worker (for reads/saves).

**Options:**

### Option A: Single bucket, flat keys with video ID
- One bucket (e.g., `streamtube`). Video files stored as `videos/{videoId}/original.{ext}` and thumbnails as `videos/{videoId}/thumbnail.jpg`. The video ID is the `nanoid` unique identifier. The original extension is preserved from the uploaded file.
- **Pros:** Simplest setup — one bucket, one set of credentials. Easy to reason about — the video ID is the key prefix. Migrating to AWS S3 means creating one bucket and copying objects. Direct mapping between URL and storage key.
- **Cons:** Single bucket mixes raw uploads and processed thumbnails — lifecycle policies (e.g., expire incomplete multipart uploads) apply to everything. Harder to apply different access policies to different object types without path-based rules. All objects share the same bucket quota and metrics.

### Option B: Separate buckets for videos and thumbnails
- Two buckets: `streamtube-videos` for video files, `streamtube-thumbnails` for thumbnail images. Video key: `{videoId}/original.{ext}`. Thumbnail key: `{videoId}/thumbnail.jpg`. Each bucket has its own lifecycle policy, access rules, and quotas.
- **Pros:** Clean separation of concerns — video lifecycle policies (multipart abort, versioning) are independent of thumbnails (public-read, CDN caching). Thumbnails can be made public-read while videos require pre-signed URLs. Easier cost tracking per storage class. Industry standard pattern (YouTube, Vimeo use separate storage for thumbnails).
- **Cons:** Two buckets to manage, two sets of IAM policies (in production). MinIO setup is slightly more complex (two bucket creation calls in the init script).

### Option C: Single bucket, type-based prefix with separate folders
- One bucket with strict folder hierarchy: `videos/original/{videoId}.{ext}`, `videos/thumbnail/{videoId}.jpg`, `videos/hls/{videoId}/` (for future HLS segments). MinIO bucket policies use path-based rules to differentiate access.
- **Pros:** Single bucket with path-based access control — simpler than two buckets but with the access control granularity of separate buckets. Natural extension point for future features (HLS segments, multiple resolutions). Prefix-based lifecycle rules are well-supported in S3/MinIO.
- **Cons:** Slightly longer keys. Path-based policy rules are more complex to write and test than bucket-level policies. The prefix `videos/original/` is redundant — the bucket is already for videos.

**Recommendation:** **Option A (Single bucket, flat keys)** — For Phase 03, a single `streamtube` bucket with `videos/{videoId}/` prefix is the pragmatic choice. It's simple to set up, easy to migrate, and the access pattern is uniform (everything behind pre-signed URLs — no public-read objects needed yet). When public thumbnails become a requirement (Phase 05), the thumbnail prefix can be made public-read via a MinIO bucket policy without restructuring. This defers the multi-bucket decision to when it's actually needed.

**Decision:** A (Single bucket, flat keys with video ID)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Message Queue Technology | BullMQ + Redis | A |
| TD-02 | Backend | Upload Strategy (10 GB) | Multipart + pre-signed URLs | B |
| TD-03 | Backend | Worker Architecture (FFmpeg) | NestJS standalone app | B |
| TD-04 | Backend | URL Uniqueness + Streaming | nanoid + direct MinIO streaming | B |
| TD-05 | Backend | Video Status Lifecycle | Status + substatus with retry | B |
| TD-06 | Backend | Object Storage Organization | Single bucket, flat keys | A |
