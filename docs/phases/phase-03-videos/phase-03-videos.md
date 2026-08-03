---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-07-21T12:00:00-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-21T12:00:00-03:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-07-21T12:00:00-03:00"
---

# Phase 03 — Upload e Processamento de Videos

## Objective

Deliver the complete video upload and processing pipeline — object storage (MinIO), message queue (BullMQ + Redis), video worker (FFmpeg), multipart upload with pre-signed URLs for files up to 10 GB, automatic metadata extraction and thumbnail generation, unique video URLs, streaming, and download.

---

## Step Implementations

### SI-03.1 — Dependencies, Configuration Namespaces, and Docker Compose

**Description:** Install all Phase 03 production dependencies, create `storage` and `queue` config namespaces following the `registerAs` pattern from Phase 01, extend the Joi validation schema, and add MinIO, Redis, and Video Worker services to Docker Compose.

**Technical actions:**

- Install production dependencies: `@nestjs/bullmq@^11.x`, `bullmq@^5.x`, `ioredis@^5.x`, `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`, `fluent-ffmpeg@^2.x`, `nanoid@^5.x`
- Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading `STORAGE_ENDPOINT` (string, default `'minio'`), `STORAGE_PORT` (number, default `9000`), `STORAGE_ACCESS_KEY` (string, default `'minioadmin'`), `STORAGE_SECRET_KEY` (string, default `'minioadmin'`), `STORAGE_BUCKET` (string, default `'streamtube'`), `STORAGE_USE_SSL` (boolean, default `false`)
- Create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading `REDIS_HOST` (string, default `'redis'`), `REDIS_PORT` (number, default `6379`), `REDIS_PASSWORD` (string, optional, default `''`)
- Update `src/config/env.validation.ts` — add all new environment variables. STORAGE_* and REDIS_* all have defaults (dev-ready), no new required variables
- Add to `nestjs-project/compose.yaml`:
  - MinIO service: image `minio/minio`, ports `9000:9000` (API) + `9001:9001` (Console), command `server /data --console-address ":9001"`, env `MINIO_ROOT_USER=minioadmin`, `MINIO_ROOT_PASSWORD=minioadmin`, healthcheck on `:9000/minio/health/live`
  - MinIO bucket init: one-shot container that runs `mc mb` and exits, depends on MinIO healthy
  - Redis service: image `redis:7-alpine`, port `6379`, healthcheck `redis-cli ping`
  - Video Worker service: same build as `nestjs-api` but with different `CMD` (entry point for worker), depends on db, redis, minio
- Update `Dockerfile.dev` to install FFmpeg: `RUN apk add --no-cache ffmpeg`
- Add worker entry point: `src/worker.ts` — standalone NestJS app that imports only `WorkerModule` (which wraps `VideosModule` processing pipeline + `BullModule`)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/config/storage.config.spec.ts` | Unit | Config namespace resolves with defaults and overrides |
| `src/config/queue.config.spec.ts` | Unit | Config namespace resolves with defaults and overrides |
| `src/database/migrations.integration-spec.ts` | Integration | Existing migration test still passes after new services added |

**Dependencies:** None

**Acceptance criteria:**

- Application starts without errors — existing E2E test (`GET /` returns 200) still passes
- `docker compose up -d` brings up all 6 services: nestjs-api, db, mailpit, minio, redis, video-worker
- MinIO Console is reachable at `http://localhost:9001`
- Redis responds to `docker compose exec redis redis-cli ping` with `PONG`
- MinIO bucket `streamtube` is created on startup
- `docker compose exec nestjs-api npx tsc --noEmit` exits with code 0 after new dependencies installed

---

### SI-03.2 — Video Entity and Migration

**Description:** Create the `Video` entity with the status lifecycle (draft → uploading → processing → ready / error), processing metadata substatus, and relation to the Channel entity. Generate the migration.

**Technical actions:**

- Create `src/videos/entities/video.entity.ts` — `@Entity('videos')` with columns:
  - `id` (uuid, PK, generated)
  - `title` (varchar, default `'Untitled'`)
  - `public_id` (varchar(11), unique, not null) — nanoid, the URL slug
  - `status` (enum: `draft`, `uploading`, `processing`, `ready`, `error`, default `draft`)
  - `processing_step` (enum, nullable: `metadata`, `thumbnail`) — current step during processing
  - `status_message` (text, nullable) — error description or processing info
  - `error_retries` (integer, default `0`) — number of processing retries attempted
  - `original_filename` (varchar, not null)
  - `original_extension` (varchar(10), not null)
  - `file_size` (bigint, nullable) — in bytes
  - `duration` (integer, nullable) — in seconds
  - `resolution_width` (integer, nullable)
  - `resolution_height` (integer, nullable)
  - `codec` (varchar(50), nullable)
  - `bitrate` (integer, nullable) — in bps
  - `upload_id` (varchar, nullable) — S3 multipart upload ID during upload
  - `channel_id` (uuid, FK → channels.id, not null)
  - `created_at` (CreateDateColumn)
  - `updated_at` (UpdateDateColumn)
- Define `@ManyToOne(() => Channel)` relation with `@JoinColumn({ name: 'channel_id' })`
- Generate migration via `npm run migration:generate -- src/database/migrations/CreateVideos`
- Create `src/videos/videos.module.ts` — `VideosModule` importing `TypeOrmModule.forFeature([Video])`, `ChannelsModule`, exports `TypeOrmModule` and `VideosService`
- Register the `Video` entity in `data-source.ts` entities array

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | Unique public_id constraint, status enum values, channel relation, nullable fields for processing metadata |
| `src/videos/videos.module.spec.ts` | Unit | Module compiles with TypeOrmModule.forFeature([Video]) and ChannelsModule import |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` creates the `videos` table with all columns, constraints, and indexes (unique on `public_id`, FK on `channel_id`)
- Inserting a video with a duplicate `public_id` fails with a unique constraint violation
- The status column accepts only `draft`, `uploading`, `processing`, `ready`, `error` — other values are rejected by the enum constraint
- A video is linked to a channel via `channel_id` — deleting the channel cascades or fails (decided by FK constraint)

---

### SI-03.3 — Object Storage Service (MinIO/S3)

**Description:** Create a `StorageService` wrapping the `@aws-sdk/client-s3` for MinIO operations: create bucket if not exists, generate pre-signed PUT URLs for multipart uploads, generate pre-signed GET URLs for streaming and download, delete objects, and manage multipart upload sessions.

**Technical actions:**

- Create `src/videos/storage.service.ts` — `StorageService` injecting `storageConfig`:
  - `onModuleInit()` — ensure bucket exists via `CreateBucketCommand` (idempotent — MinIO returns success if bucket already exists)
  - `createMultipartUpload(videoId: string, filename: string, mimeType: string): Promise<string>` — calls `CreateMultipartUploadCommand`, returns `uploadId`
  - `presignUploadPart(videoId: string, uploadId: string, partNumber: number, expiresIn?: number): Promise<string>` — generates pre-signed URL for one part via `getSignedUrl` with `UploadPartCommand`, returns URL
  - `completeMultipartUpload(videoId: string, uploadId: string, parts: { PartNumber: number; ETag: string }[]): Promise<void>` — calls `CompleteMultipartUploadCommand`
  - `abortMultipartUpload(videoId: string, uploadId: string): Promise<void>` — calls `AbortMultipartUploadCommand`
  - `presignGetUrl(key: string, expiresIn: number, downloadFilename?: string): Promise<string>` — generates pre-signed GET URL via `getSignedUrl` with `GetObjectCommand`, optionally sets `Content-Disposition: attachment; filename="..."` for download
  - `deleteObject(key: string): Promise<void>` — calls `DeleteObjectCommand`
  - Build object key helper: `getVideoKey(videoId: string, extension: string): string` → `videos/${videoId}/original.${extension}`, `getThumbnailKey(videoId: string): string` → `videos/${videoId}/thumbnail.jpg`
- Create `src/videos/storage.module.ts` — `StorageModule` with `ConfigModule.forFeature(storageConfig)`, provider `StorageService`, exports `StorageService`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/storage.service.spec.ts` | Unit | Methods dispatch correct S3 commands; key generation produces valid paths |
| `src/videos/storage.service.integration-spec.ts` | Integration | Bucket is created on init; multipart upload lifecycle (create → complete) works against real MinIO; pre-signed GET URL is valid and fetches object; deleteObject removes object |
| `src/videos/storage.module.spec.ts` | Unit | Module compiles with ConfigModule.forFeature and StorageService |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `StorageService.onModuleInit()` creates the `streamtube` bucket in MinIO if it doesn't exist
- `createMultipartUpload` returns a valid upload ID from MinIO
- `presignUploadPart` returns a URL that accepts a PUT with the part data
- `completeMultipartUpload` with valid parts succeeds — the object is assembled in MinIO
- `presignGetUrl` returns a URL that fetches the object content when accessed
- `presignGetUrl` with a `downloadFilename` parameter sets `Content-Disposition: attachment`

---

### SI-03.4 — VideosService — Draft Creation and Core Logic

**Description:** Implement `VideosService` with the core lifecycle methods: create a draft video (pre-cadastro), update status with optimistic locking, and retrieve videos by public ID. This SI establishes the service layer before the upload controller and worker processor are wired.

**Technical actions:**

- Create `src/videos/videos.service.ts` — `VideosService` injecting `@InjectRepository(Video)`, `StorageService`, and `@InjectQueue('videos')`:
  - `createDraft(channelId: string, filename: string): Promise<Video>` — generates `public_id` via `nanoid(11)`, extracts extension from filename, creates `Video` entity with status `draft` and `original_filename`/`original_extension`, saves, returns the video
  - `findByPublicId(publicId: string): Promise<Video | null>` — looks up video by `public_id` with channel relation loaded
  - `findByChannel(channelId: string): Promise<Video[]>` — lists videos for a channel (future Phase 04 will add pagination)
  - `updateStatus(videoId: string, status: VideoStatus, extra?: { processingStep?: ProcessingStep; statusMessage?: string; incrementRetries?: boolean }): Promise<void>` — atomic status update using `repository.update()`
  - `setVideoMetadata(videoId: string, metadata: { duration: number; width: number; height: number; codec: string; bitrate: number; fileSize: number }): Promise<void>` — updates processing metadata columns
- Create `src/videos/videos.controller.ts` — `VideosController` with route prefix `'videos'`:
  - `@Get(':publicId')` — returns public video info (title, duration, resolution, status, public_id) — `@Public()` for anonymous access
  - `@Post('drafts')` — authenticated, calls `videosService.createDraft(currentUser.sub, body.filename)`, returns 201 with `{ id, public_id, status }`
  - `@Get('channel/mine')` — authenticated, lists videos for the current user's channel
- Create `src/videos/dto/create-draft.dto.ts` — `CreateDraftDto` with `@IsString() @IsNotEmpty()` filename
- Register `VideosController` in `VideosModule`
- Register BullMQ queue: `BullModule.registerQueue({ name: 'videos' })` in `VideosModule` imports

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `createDraft` generates nanoid, saves video with draft status; `findByPublicId` returns video; `updateStatus` updates atomically; `setVideoMetadata` updates all processing columns |
| `src/videos/videos.service.integration-spec.ts` | Integration | Draft persisted with unique public_id; status transitions reflected in DB; metadata columns persist correctly; video linked to channel |
| `src/videos/videos.controller.spec.ts` | Unit | Controller endpoints use VideosService correctly; authentication decorators applied |
| `test/videos.e2e-spec.ts` | E2E | `POST /videos/drafts` returns 201 with public_id; `GET /videos/:publicId` returns 200 with video info; `GET /videos/channel/mine` returns list |

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**

- `POST /videos/drafts` with authenticated user returns 201 with `{ id, public_id, status: 'draft' }` — the video is linked to the user's channel
- `POST /videos/drafts` without authentication returns 401
- `GET /videos/:publicId` returns 200 with video info (including channel name) for any user (anonymous access)
- `GET /videos/:publicId` with a non-existent `public_id` returns 404
- The `public_id` is 11 characters, URL-safe, and unique across all videos
- The `upload_id` field is null for a fresh draft (no upload started yet)

---

### SI-03.5 — Upload Endpoints — Multipart Orchestration

**Description:** Implement the upload orchestration endpoints that the client calls to upload a video file via S3 multipart: initiate multipart upload, get pre-signed URLs for each part, complete the upload (triggering processing), and abort. The file never passes through the API.

**Technical actions:**

- Add to `VideosController`:
  - `@Post(':publicId/uploads/initiate')` — authenticated + owns video. Validates video status is `draft` or `uploading`. Calls `storageService.createMultipartUpload()` with the video's public_id and extension. Saves the returned S3 `uploadId` on the video entity. Sets status to `uploading`. Returns `{ upload_id, max_parts: 10000, min_part_size: 5242880 }` (5 MB min part size)
  - `@Post(':publicId/uploads/parts')` — authenticated + owns video. Body: `{ part_numbers: number[] }`. Validates video status is `uploading`. Calls `storageService.presignUploadPart()` for each part number. Returns `{ parts: [{ part_number, upload_url }] }` (the pre-signed PUT URLs)
  - `@Post(':publicId/uploads/complete')` — authenticated + owns video. Body: `{ parts: [{ PartNumber, ETag }] }`. Calls `storageService.completeMultipartUpload()`. Updates video status to `processing`. Enqueues a `process-video` job on the `videos` queue with payload `{ videoId: video.id }`. Returns 200 with `{ status: 'processing' }`
  - `@Post(':publicId/uploads/abort')` — authenticated + owns video. Calls `storageService.abortMultipartUpload()`. Resets video status to `draft`, clears `upload_id`. Returns 204
- Create `src/videos/dto/initiate-upload.dto.ts` — empty body (all info from route params)
- Create `src/videos/dto/upload-parts.dto.ts` — `UploadPartsDto` with `@IsArray() @ArrayMinSize(1) @ArrayMaxSize(50)` part_numbers (array of positive integers)
- Create `src/videos/dto/complete-upload.dto.ts` — `CompleteUploadDto` with `@IsArray() @ArrayMinSize(1)` parts array of `{ PartNumber: number, ETag: string }`
- Create `src/videos/guards/video-owner.guard.ts` — `VideoOwnerGuard` implementing `CanActivate`. Injects `VideosService`. Resolves `:publicId` param to video, checks `video.channel.user_id === request.user.sub`. Attaches video to `request.video` for downstream use. Throws 403 if not the owner, 404 if video not found

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Upload initiation updates status to uploading and stores S3 upload_id; completion enqueues BullMQ job |
| `src/videos/videos.service.integration-spec.ts` | Integration | Full upload flow: initiate → presign parts → complete; job appears in BullMQ queue; abort resets status to draft |
| `src/videos/guards/video-owner.guard.spec.ts` | Unit | Guard allows owner, blocks non-owner with 403, returns 404 for non-existent video |
| `test/videos.e2e-spec.ts` | E2E | `POST /videos/:publicId/uploads/initiate` returns upload_id; parts endpoint returns valid pre-signed URLs; complete enqueues processing; abort resets state; non-owner blocked |

**Dependencies:** SI-03.4

**Acceptance criteria:**

- `POST /videos/:publicId/uploads/initiate` creates a multipart upload in MinIO, stores the `uploadId`, and sets status to `uploading`
- `POST /videos/:publicId/uploads/parts` with `part_numbers: [1, 2, 3]` returns 3 pre-signed URLs — each URL accepts a PUT of the corresponding part
- `POST /videos/:publicId/uploads/complete` with valid parts assembles the file in MinIO, sets status to `processing`, and enqueues a BullMQ `process-video` job
- `POST /videos/:publicId/uploads/abort` cancels the MinIO multipart upload, sets status back to `draft`, and clears `upload_id`
- Upload endpoints return 403 when a different user tries to operate on another user's video
- Upload endpoints return 404 when `public_id` does not exist
- Upload endpoints return 409 when the video is not in an uploadable state (e.g., already `processing` or `ready`)

---

### SI-03.6 — Video Worker — FFmpeg Processing

**Description:** Create the BullMQ processor that consumes `process-video` jobs from the `videos` queue. The processor downloads the video from MinIO, runs `ffprobe` for metadata extraction, runs `ffmpeg` to generate a thumbnail from the 10-second mark, uploads the thumbnail to MinIO, and updates the video entity with metadata and status.

**Technical actions:**

- Create `src/videos/video-processor.ts` — class decorated with `@Processor('videos')`:
  - `@Process('process-video')` method `async handleProcessVideo(job: Job<{ videoId: string }>)`:
    1. Update video status to `processing`, step `metadata`
    2. Download video from MinIO to a temp file via `storageService.presignGetUrl()` + `fetch`
    3. Run `ffprobe` on the temp file: extract `format.duration`, first video stream's `width`, `height`, `codec_name`, `bit_rate`, `format.size`
    4. Update video metadata via `videosService.setVideoMetadata()`
    5. Update processing step to `thumbnail`
    6. Run `ffmpeg -i <input> -ss 00:00:10 -vframes 1 -q:v 2 <thumbnail.jpg>` to extract a frame at 10s (or at 30% of duration if video is shorter than 10s)
    7. Upload thumbnail to MinIO via `PutObjectCommand` (or pre-signed PUT) at key `videos/{videoId}/thumbnail.jpg`
    8. Update video status to `ready`, clear `processing_step`
  - On error: increment `error_retries`. If retries < 3: set status back to `processing` and throw (BullMQ will retry with exponential backoff). If retries >= 3: set status to `error`, store `status_message` with the error message, and do not throw (job completes as "failed" but video is marked as error)
- Create `src/videos/worker.module.ts` — `WorkerModule` importing `VideosModule` (for `VideosService`, `StorageService`), `BullModule.forRootAsync` (connects to Redis), `BullModule.registerQueue({ name: 'videos' })`, and providing `VideoProcessor`
- Create `src/worker.ts` — standalone NestJS application entry point:
  ```typescript
  import { NestFactory } from '@nestjs/core';
  import { WorkerModule } from './videos/worker.module';
  async function bootstrap() {
    const app = await NestFactory.createApplicationContext(WorkerModule);
    // Application context — no HTTP, just processors
  }
  bootstrap();
  ```
- Update `Dockerfile.dev` — install FFmpeg: `RUN apk add --no-cache ffmpeg`
- Add `package.json` script: `"start:worker": "nest start --entryFile worker"`
- Update `compose.yaml` video-worker service `command` to `npm run start:worker`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/video-processor.spec.ts` | Unit | Processor updates status step-by-step; ffprobe metadata mapped correctly; ffmpeg thumbnail command formed correctly; on success, status → ready; on failure, retries incremented; max retries → error status |
| `src/videos/video-processor.integration-spec.ts` | Integration | Full processing cycle: download from MinIO → ffprobe → ffmpeg thumbnail → upload thumbnail → DB updated with metadata and status ready; error path: mock ffprobe failure, verify retries and final error status |
| `src/videos/worker.module.spec.ts` | Unit | Module compiles with BullModule and VideoProcessor wiring |

**Dependencies:** SI-03.3, SI-03.4

**Acceptance criteria:**

- A `process-video` job in the queue is consumed by the worker and results in the video's status becoming `ready`
- The video's `duration`, `resolution_width`, `resolution_height`, `codec`, `bitrate`, and `file_size` columns are populated from ffprobe data
- A thumbnail image exists in MinIO at `videos/{videoId}/thumbnail.jpg` after processing
- If ffprobe fails, the job is retried up to 3 times (with exponential backoff) and the video status becomes `error` with `status_message` set
- The worker does not expose an HTTP port — it only processes queue jobs
- The FFmpeg binary is available in the worker container (`docker compose exec video-worker ffmpeg -version` works)

---

### SI-03.7 — Streaming and Download Endpoints

**Description:** Implement the streaming and download endpoints that return pre-signed GET URLs to the client. Streaming returns a long-lived (6-hour) URL for the video file; download returns a short-lived (5-minute) URL with `Content-Disposition: attachment`.

**Technical actions:**

- Add to `VideosController`:
  - `@Get(':publicId/stream')` — `@Public()`. Finds video by public_id. If status is not `ready`, returns 404 or 409. Generates a pre-signed GET URL for the video object with 6-hour expiry. Returns `{ url, expires_in: 21600 }` (or 302 redirect to the URL — use JSON response for more flexibility with the frontend)
  - `@Get(':publicId/download')` — `@Public()`. Finds video by public_id. If status is not `ready`, returns 404 or 409. Generates a pre-signed GET URL with 5-minute expiry and `Content-Disposition: attachment; filename="{original_filename}"`. Returns `{ url, expires_in: 300, filename }`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.controller.spec.ts` | Unit | Stream endpoint returns pre-signed URL for ready videos; download sets attachment disposition |
| `test/videos.e2e-spec.ts` | E2E | `GET /videos/:publicId/stream` returns 200 with URL; `GET /videos/:publicId/download` returns 200 with download URL; non-ready video returns 409 |

**Dependencies:** SI-03.4

**Acceptance criteria:**

- `GET /videos/:publicId/stream` returns a pre-signed URL that streams the video directly from MinIO when accessed
- `GET /videos/:publicId/download` returns a pre-signed URL with `Content-Disposition: attachment` — accessing it downloads the file
- Streaming URL has a 6-hour TTL (21,600 seconds)
- Download URL has a 5-minute TTL (300 seconds)
- Both endpoints return 404 when the video does not exist
- Both endpoints return 409 when the video exists but status is not `ready`

---

### SI-03.8 — Video Status Lifecycle Guards and Error Catalog

**Description:** Refine the status transition logic with proper guards (business rules for which state transitions are allowed), add domain exceptions for video-specific errors, and register them in the error catalog. Implement the retry mechanism (re-submit failed video for processing).

**Technical actions:**

- Create `src/videos/exceptions/video-errors.ts` — domain exception classes:
  - `VideoNotFoundException` (404, `VIDEO_NOT_FOUND`) — thrown when public_id doesn't match any video
  - `VideoNotReadyException` (409, `VIDEO_NOT_READY`) — thrown when streaming/download requested for non-ready video
  - `VideoNotOwnedException` (403, `VIDEO_NOT_OWNED`) — thrown when user tries to operate on another user's video
  - `InvalidStatusTransitionException` (409, `INVALID_STATUS_TRANSITION`) — thrown when a status transition is not allowed (e.g., trying to initiate upload on a `ready` video)
- Create allowed transitions map in `video.entity.ts` or `videos.service.ts`:
  ```
  draft → uploading, draft → (deleted)
  uploading → processing (on complete), uploading → draft (on abort), uploading → error
  processing → ready, processing → error
  error → processing (on retry)
  ```
- Add to `VideosController`:
  - `@Post(':publicId/retry')` — authenticated + owns video. Only allowed when status is `error`. Resets `error_retries` to 0, sets status to `processing`, enqueues `process-video` job. Returns 200
- Add to `VideosService` — helper method `assertOwnership(video: Video, userId: string)` that throws `VideoNotOwnedException` if the video's channel is not owned by the user

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Status transitions: valid transitions succeed, invalid transitions throw InvalidStatusTransitionException |
| `src/videos/exceptions/video-errors.spec.ts` | Unit | Each exception class has correct error code, HTTP status, and message |
| `test/videos.e2e-spec.ts` | E2E | Invalid status transitions return 409; retry endpoint works only for error videos; non-existent video returns 404 with VIDEO_NOT_FOUND code |

**Dependencies:** SI-03.4, SI-03.5, SI-03.6

**Acceptance criteria:**

- Attempting to initiate upload on a `ready` video returns 409 with `INVALID_STATUS_TRANSITION`
- `POST /videos/:publicId/retry` on an error video re-enqueues processing and transitions status to `processing`
- `POST /videos/:publicId/retry` on a non-error video returns 409
- All error responses include the correct domain error code (e.g., `VIDEO_NOT_FOUND`, `VIDEO_NOT_READY`, `VIDEO_NOT_OWNED`)
- After retry succeeds, the video status is `ready` with `error_retries = 0`

---

### SI-03.9 — E2E Tests, MinIO Health, and Finalization

**Description:** Wire the full E2E flow: create draft → initiate multipart upload → upload parts to MinIO → complete upload → worker processes → streaming URL available. Add a MinIO integration test, verify the migration runner test still works with the new table, and run the full test suite to ensure the Definition of Done passes.

**Technical actions:**

- Create `test/videos.e2e-spec.ts` — E2E test suite covering:
  1. **Draft creation:** POST /videos/drafts → 201 with public_id
  2. **Upload initiation:** POST /videos/:publicId/uploads/initiate → 200 with upload_id
  3. **Part URL generation:** POST /videos/:publicId/uploads/parts → 200 with pre-signed URLs
  4. **Actual part upload:** Use the pre-signed URLs to PUT part data to MinIO (via `fetch`) — tests that MinIO is properly configured and accessible
  5. **Complete upload:** POST /videos/:publicId/uploads/complete → 200, status becomes `processing`
  6. **Processing completion:** Wait for worker to process (poll GET /videos/:publicId until status is `ready` or `error`, with timeout)
  7. **Streaming:** GET /videos/:publicId/stream → 200 with pre-signed URL
  8. **Download:** GET /videos/:publicId/download → 200 with download URL
  9. **Abort flow:** Create a second draft, initiate, then abort → status back to draft
  10. **Error flow:** Create a third draft, initiate, upload an invalid "video" file, complete — verify worker eventually marks it as `error` and retry works
  11. **Authorization:** Non-owner cannot initiate/complete/abort another user's video
  12. **Anonymous access:** GET /videos/:publicId and stream/download work without auth
- Update `src/database/migrations.integration-spec.ts` — verify the `CreateVideos` migration is included in the expected migration count and the `videos` table appears in `information_schema`
- Create `src/videos/storage.integration-spec.ts` — verify MinIO connectivity and basic operations (put object, get object, delete object) work from within the Docker network

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `test/videos.e2e-spec.ts` | E2E | Full video lifecycle: draft → upload → process → stream/download; abort flow; error + retry flow; auth checks; anonymous access |
| `src/database/migrations.integration-spec.ts` | Integration | Updated to verify 3 migrations (CreateUsersAndChannels, CreateAuthTokens, CreateVideos) and all 7 tables present |
| `src/videos/storage.integration-spec.ts` | Integration | MinIO is reachable, bucket exists, put/get/delete operations work |

**Dependencies:** SI-03.5, SI-03.6, SI-03.7, SI-03.8

**Acceptance criteria:**

- Full E2E test passes: create draft → upload via pre-signed URLs → complete → worker processes → status ready → streaming URL works
- Migration runner test passes with the new `videos` table included
- `npm test -- --runInBand` passes (unit + integration)
- `npm run test:e2e` passes
- `npx tsc --noEmit` exits with code 0
- `npm run lint` passes

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | |
| title | varchar(255) | not null, default `'Untitled'` | Editable in Phase 04 |
| public_id | varchar(11) | unique, not null | nanoid — public URL slug |
| status | enum | not null, default `draft` | `draft`, `uploading`, `processing`, `ready`, `error` |
| processing_step | enum | nullable | `metadata`, `thumbnail` — current step during processing |
| status_message | text | nullable | Error description or processing context |
| error_retries | integer | not null, default `0` | Number of processing attempts |
| original_filename | varchar(255) | not null | Original uploaded filename |
| original_extension | varchar(10) | not null | e.g., `mp4`, `mov`, `mkv` |
| file_size | bigint | nullable | File size in bytes (populated after processing) |
| duration | integer | nullable | Duration in seconds |
| resolution_width | integer | nullable | e.g., 1920 |
| resolution_height | integer | nullable | e.g., 1080 |
| codec | varchar(50) | nullable | e.g., `h264`, `hevc` |
| bitrate | integer | nullable | Bitrate in bps |
| upload_id | varchar(255) | nullable | S3 multipart upload ID during upload |
| channel_id | uuid | FK → channels.id, not null | |
| created_at | timestamp | not null, auto-generated | |
| updated_at | timestamp | not null, auto-generated | |

**Relations:** Video → Channel (many-to-one, owning side via `channel_id`)
**Indexes:** `(public_id)` — unique, `(channel_id)`, `(status)`

**Status Lifecycle:**
```
draft ──→ uploading ──→ processing ──→ ready
  ↑          │               │             
  │          │               ↓             
  └──── abort              error ──→ (retry) → processing
```

---

### API Contracts

#### POST /videos/drafts (SI-03.4)

**Request headers:**
- Authorization: Bearer `<access_token>`
- Content-Type: application/json

**Request body:**
- filename: string, required — original filename with extension

**Response 201:**
- id: string (uuid)
- public_id: string (11-char nanoid)
- status: "draft"

**Error responses:**
- 401: missing or invalid access token
- 400: validation error (filename missing)

---

#### GET /videos/:publicId (SI-03.4)

**Access:** Public (anonymous allowed)

**Response 200:**
- id: string (uuid)
- public_id: string
- title: string
- status: string
- duration: number | null
- resolution_width: number | null
- resolution_height: number | null
- channel: { id, name, nickname }
- created_at: string (ISO 8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: public_id does not exist

---

#### POST /videos/:publicId/uploads/initiate (SI-03.5)

**Request headers:**
- Authorization: Bearer `<access_token>`
- Content-Type: application/json

**Response 200:**
- upload_id: string (S3 multipart upload ID)
- max_parts: 10000
- min_part_size: 5242880 (5 MB)

**Error responses:**
- 401: missing or invalid access token
- 403 VIDEO_NOT_OWNED: user does not own the video
- 404 VIDEO_NOT_FOUND: public_id does not exist
- 409 INVALID_STATUS_TRANSITION: video is not in uploadable state

---

#### POST /videos/:publicId/uploads/parts (SI-03.5)

**Request headers:**
- Authorization: Bearer `<access_token>`
- Content-Type: application/json

**Request body:**
- part_numbers: number[], required — array of part numbers (1 to N, max 50 per request)

**Response 200:**
- parts: [{ part_number: number, upload_url: string }]

**Error responses:**
- 401, 403, 404, 409 — same as initiate

---

#### POST /videos/:publicId/uploads/complete (SI-03.5)

**Request headers:**
- Authorization: Bearer `<access_token>`
- Content-Type: application/json

**Request body:**
- parts: [{ PartNumber: number, ETag: string }], required

**Response 200:**
- status: "processing"

**Error responses:**
- 401, 403, 404, 409 — same as initiate
- 400: validation error (parts array missing or empty)

---

#### POST /videos/:publicId/uploads/abort (SI-03.5)

**Request headers:**
- Authorization: Bearer `<access_token>`

**Response 204:** No content.

**Error responses:**
- 401, 403, 404, 409 — same as initiate

---

#### GET /videos/:publicId/stream (SI-03.7)

**Access:** Public (anonymous allowed)

**Response 200:**
- url: string — pre-signed MinIO GET URL (6-hour TTL)
- expires_in: 21600

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY: video exists but is not in ready state

---

#### GET /videos/:publicId/download (SI-03.7)

**Access:** Public (anonymous allowed)

**Response 200:**
- url: string — pre-signed MinIO GET URL (5-minute TTL) with Content-Disposition: attachment
- expires_in: 300
- filename: string — original filename

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY

---

#### GET /videos/channel/mine (SI-03.4)

**Request headers:**
- Authorization: Bearer `<access_token>`

**Response 200:**
- videos: [{ id, public_id, title, status, duration, created_at }]

**Error responses:**
- 401: missing or invalid access token

---

#### POST /videos/:publicId/retry (SI-03.8)

**Request headers:**
- Authorization: Bearer `<access_token>`

**Response 200:**
- status: "processing"

**Error responses:**
- 401, 403, 404 — same as other authenticated endpoints
- 409 INVALID_STATUS_TRANSITION: video is not in error state

---

### Authorization Matrix

| Endpoint | Public | Authenticated | Notes |
|----------|--------|---------------|-------|
| GET /videos/:publicId | ✓ | | Public video info |
| GET /videos/:publicId/stream | ✓ | | Pre-signed URL for anyone |
| GET /videos/:publicId/download | ✓ | | Pre-signed download URL |
| POST /videos/drafts | | ✓ | Creates draft for user's channel |
| GET /videos/channel/mine | | ✓ | Lists user's channel videos |
| POST /videos/:publicId/uploads/initiate | | ✓ (owner) | Owner only |
| POST /videos/:publicId/uploads/parts | | ✓ (owner) | Owner only |
| POST /videos/:publicId/uploads/complete | | ✓ (owner) | Owner only |
| POST /videos/:publicId/uploads/abort | | ✓ (owner) | Owner only |
| POST /videos/:publicId/retry | | ✓ (owner) | Owner only |

---

### Error Catalog

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | Any endpoint with non-existent public_id |
| VIDEO_NOT_READY | 409 | Video is not ready for playback | Stream/download on non-ready video |
| VIDEO_NOT_OWNED | 403 | You do not own this video | Authenticated user operates on another user's video |
| INVALID_STATUS_TRANSITION | 409 | Invalid status transition | Operation not allowed in current video status |
| UPLOAD_INITIATION_FAILED | 500 | Failed to initiate upload | MinIO CreateMultipartUpload error |
| PRESIGN_URL_FAILED | 500 | Failed to generate upload URL | getSignedUrl error |
| MULTIPART_COMPLETE_FAILED | 500 | Failed to complete upload | MinIO CompleteMultipartUpload error |
| PROCESSING_FAILED | 500 | Video processing failed | Worker exhausted retries |

---

### Events / Messages

#### Queue: `videos`

**Job: `process-video`**

Published by: `VideosService` on upload completion (SI-03.5)
Consumed by: `VideoProcessor.handleProcessVideo` (SI-03.6)

**Payload:**
```json
{
  "videoId": "uuid"
}
```

**Retry policy:** max 3 attempts with exponential backoff (delay: 5s → 25s → 125s)
**Idempotency:** Processor checks current status — if already `ready`, skips. If `error`, processes only if `error_retries < maxRetries`.

---

## Dependency Map

```
SI-03.1 (no deps — infra + config)
├── SI-03.2 (Video entity + migration)
│   └── SI-03.4 (VideosService + drafts)
│       ├── SI-03.5 (Upload endpoints)
│       │   └── SI-03.8 (Status lifecycle guards)
│       └── SI-03.7 (Streaming + download)
└── SI-03.3 (Storage service)
    ├── SI-03.4
    └── SI-03.6 (Worker processor)
        └── SI-03.8

SI-03.9 (E2E + finalization) — after all SIs
```

Linearized implementation order: SI-03.1 → SI-03.2, SI-03.3 (parallel) → SI-03.4 → SI-03.5, SI-03.6, SI-03.7 (parallel) → SI-03.8 → SI-03.9

## Deliverables

- [ ] MinIO, Redis, and Video Worker services in Docker Compose alongside existing API, DB, and Mailpit
- [ ] Video entity with status lifecycle (`draft → uploading → processing → ready/error`) and processing metadata columns
- [ ] Object storage service wrapping `@aws-sdk/client-s3` for MinIO operations (bucket creation, multipart upload, pre-signed URLs)
- [ ] Draft creation endpoint (`POST /videos/drafts`) — pre-cadastro with 11-char nanoid `public_id`
- [ ] Multipart upload orchestration (initiate, presign parts, complete, abort) — file never passes through API
- [ ] BullMQ `videos` queue for processing jobs
- [ ] Video Worker (NestJS standalone) consuming jobs, running FFmpeg for metadata extraction and thumbnail generation
- [ ] Streaming endpoint (`GET /videos/:publicId/stream`) — returns pre-signed MinIO GET URL (6-hour TTL)
- [ ] Download endpoint (`GET /videos/:publicId/download`) — returns pre-signed URL with Content-Disposition attachment (5-minute TTL)
- [ ] Public video info endpoint (`GET /videos/:publicId`) accessible anonymously
- [ ] Video owner guard protecting upload endpoints from unauthorized access
- [ ] Status transition guard enforcing valid state machine transitions
- [ ] Error catalog with 8 domain error codes
- [ ] Retry mechanism — re-submit failed videos for processing
- [ ] All SI tests pass (`npm test -- --runInBand`)
- [ ] E2E tests pass (`npm run test:e2e`)
- [ ] Type/compilation check passes (`npx tsc --noEmit`)
- [ ] Lint passes (`npm run lint`)
