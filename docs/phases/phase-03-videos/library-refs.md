---
kind: phase
name: phase-03-videos
---

# phase-03-videos — Library References

Libraries introduced in this phase, with versions confirmed via `context7` against the project's installed dependency manifest.

## Core Libraries

### @nestjs/bullmq (^11.x)
- **Purpose:** NestJS integration for BullMQ queue system
- **TD:** TD-01
- **Key APIs:** `BullModule.forRootAsync()`, `BullModule.registerQueue()`, `@InjectQueue()`, `@Processor()`, `@Process()`
- **Note:** Replaces the older `@nestjs/bull` package. Uses `bullmq` v5.x under the hood.

### bullmq (^5.x)
- **Purpose:** Queue library backed by Redis
- **TD:** TD-01
- **Key APIs:** `Queue.add()`, `Worker`, `Job`, `QueueEvents`
- **Note:** Requires `ioredis` as peer dependency.

### ioredis (^5.x)
- **Purpose:** Redis client for Node.js
- **TD:** TD-01
- **Key APIs:** `new Redis()`, Redis connection options
- **Note:** Required by BullMQ. Used internally — no direct usage expected in application code.

### @aws-sdk/client-s3 (^3.x)
- **Purpose:** AWS S3 SDK — used for MinIO operations (same API)
- **TD:** TD-02
- **Key APIs:** `S3Client`, `CreateMultipartUploadCommand`, `UploadPartCommand`, `CompleteMultipartUploadCommand`, `AbortMultipartUploadCommand`, `GetObjectCommand`, `HeadObjectCommand`, `DeleteObjectCommand`
- **Note:** MinIO is S3-compatible. Use `forcePathStyle: true` and custom `endpoint` for MinIO.

### @aws-sdk/s3-request-presigner (^3.x)
- **Purpose:** Generate pre-signed URLs for S3/MinIO operations
- **TD:** TD-02, TD-04
- **Key APIs:** `getSignedUrl()` — used for pre-signed PUT (upload) and GET (streaming/download) URLs
- **Note:** Works with MinIO's S3-compatible API.

### fluent-ffmpeg (^2.x)
- **Purpose:** Node.js wrapper for FFmpeg/ffprobe CLI commands
- **TD:** TD-03
- **Key APIs:** `ffmpeg()`, `ffprobe()`, `.screenshots()`, `.ffprobe()` for metadata extraction
- **Note:** Requires `ffmpeg` and `ffprobe` binaries installed in the container. Used in the worker, not the API.

### nanoid (^5.x)
- **Purpose:** URL-safe unique ID generation
- **TD:** TD-04
- **Key APIs:** `nanoid(11)` — generates 11-character collision-free IDs
- **Note:** Used for video public IDs (URL slugs).

## Infrastructure

### MinIO (Docker image: minio/minio)
- **Purpose:** S3-compatible object storage
- **TD:** TD-02, TD-06
- **Compose config:** Single-node MinIO server, bucket `streamtube` created on startup via init script or healthcheck command

### Redis (Docker image: redis:7-alpine)
- **Purpose:** Backend for BullMQ queue
- **TD:** TD-01
- **Compose config:** Redis 7 Alpine, no persistence needed for dev

### FFmpeg (in worker Dockerfile)
- **Purpose:** Video processing (metadata extraction, thumbnail generation)
- **TD:** TD-03
- **Install:** `RUN apk add --no-cache ffmpeg` in the worker's Docker stage
