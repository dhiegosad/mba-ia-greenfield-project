---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-07-21T12:00:00-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-21T12:00:00-03:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-07-21T12:00:00-03:00"
  docs/decisions/technical-decisions-phase-01-configuracao-base.md: "2026-07-21T12:00:00-03:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-07-21T12:00:00-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Videos

**Capabilities**

- Servico de armazenamento de arquivos (videos e thumbnails)
- Servico de processamento em segundo plano (filas)
- Upload de videos com suporte a arquivos de ate 10GB sem impacto na performance
- Pre-cadastro automatico do video como rascunho ao iniciar o upload
- Processamento automatico do video apos upload (extracao de duracao e metadados)
- Geracao automatica de thumbnail a partir de um frame do video
- URL unica por video, sem conflito com outros videos
- Reproducao via streaming (sem necessidade de download completo)
- Download do video pelo usuario

**Out of scope:** Frontend pages (video watch, upload UI, player) — deferred to Phase 05. Video editing, visibility (public/unlisted), categories, channel page — all deferred to Phase 04. Comments, likes, subscriptions — deferred to Phase 06.

**Deliverables:** upload de ate 10GB funcional, processamento automatico do video, streaming funcionando, URLs unicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — video watch page, upload UI, player and all video-related UI surfaces are deferred to Phase 05.

**Sequencing notes:** Depends on Fase 01 — Configuracao Base and Fase 02 — Cadastro, Login e Gerenciamento de Conta.

**Neighbors (for boundary detection only):** Fase 02 — Cadastro, Login e Gerenciamento de Conta (prior), Fase 04 — Gerenciamento de Videos e Canal (next).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Message Queue Technology | decided | A (BullMQ + Redis) | @nestjs/bullmq@^11.x, bullmq@^5.x, ioredis@^5.x |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend | Upload Strategy for 10 GB Files | decided | B (Multipart + pre-signed URLs) | @aws-sdk/client-s3@^3.x, @aws-sdk/s3-request-presigner@^3.x |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Worker Architecture (FFmpeg) | decided | B (NestJS standalone app) | fluent-ffmpeg@^2.x |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | URL Uniqueness + Streaming | decided | B (nanoid + direct MinIO streaming) | nanoid@^5.x |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Video Status Lifecycle | decided | B (Status + substatus with retry) | — |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | Object Storage Organization | decided | A (Single bucket, flat keys) | — |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md`

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Servico de armazenamento de arquivos (videos e thumbnails) | phase-03-videos/TD-06 |
| Servico de processamento em segundo plano (filas) | phase-03-videos/TD-01 |
| Upload de videos com suporte a arquivos de ate 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pre-cadastro automatico do video como rascunho ao iniciar o upload | phase-03-videos/TD-05 |
| Processamento automatico do video apos upload (extracao de duracao e metadados) | phase-03-videos/TD-03 |
| Geracao automatica de thumbnail a partir de um frame do video | phase-03-videos/TD-03 |
| URL unica por video, sem conflito com outros videos | phase-03-videos/TD-04 |
| Reproducao via streaming (sem necessidade de download completo) | phase-03-videos/TD-04 |
| Download do video pelo usuario | phase-03-videos/TD-04 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** BullMQ + Redis — Best NestJS integration via `@nestjs/bullmq` with minimal infrastructure overhead. Redis is lightweight (~30MB container), trivially added to Docker Compose, and separates processing state from the domain database. Rich feature set: retries with exponential backoff, job progress reporting, concurrency control, rate limiting.

**Libraries:** `@nestjs/bullmq@^11.x`, `bullmq@^5.x`, `ioredis@^5.x`

### phase-03-videos/TD-02

**Recommendation:** Multipart upload with pre-signed URLs per part — Resumable and parallel uploads directly address the 10 GB requirement. MinIO native S3 multipart API provides this without additional infrastructure. The client uploads parts in parallel directly to MinIO; the API only orchestrates (initiate multipart, presign URLs per part, complete/abort). Standard S3 SDK handles client-side multipart logic.

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

### phase-03-videos/TD-03

**Recommendation:** NestJS standalone app as worker — Shared codebase (entities, config, modules) eliminates duplication. `@nestjs/bullmq` processors leverage the same DI and repository patterns as the API. Both API and worker containers build from the same Dockerfile with different CMD directives. For FFmpeg: `ffprobe -v quiet -print_format json -show_format -show_streams` for metadata, `ffmpeg -i <file> -ss 00:00:10 -vframes 1 -q:v 2` for thumbnail at 10s.

**Libraries:** `fluent-ffmpeg@^2.x`

### phase-03-videos/TD-04

**Recommendation:** nanoid + direct MinIO streaming — Short (11-char), collision-free, URL-safe IDs via `nanoid`. Pre-signed GET URLs for streaming and download go directly to MinIO, offloading data transfer from the API. 6-hour TTL for streaming URLs, 5-minute TTL for download URLs. View counting deferred to Phase 05 (separate "playback started" frontend event).

**Libraries:** `nanoid@^5.x`

### phase-03-videos/TD-05

**Recommendation:** Status + substatus with retry — Primary status enum (`draft`, `uploading`, `processing`, `ready`, `error`) with `processing_step` field (`metadata`, `thumbnail`) for granular failure visibility. `status_message` text field for error context. Max 3 retries with configurable delay between attempts.

**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** Single bucket (`streamtube`) with flat keys — Video files at `videos/{videoId}/original.{ext}`, thumbnails at `videos/{videoId}/thumbnail.jpg`. Simple setup, easy migration path. Access via pre-signed URLs — no public-read objects needed in Phase 03.

**Libraries:** —

## Inherited Decisions Detail

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Custom guards with @nestjs/jwt only (no Passport). Project already uses custom `JwtAuthGuard` implementing `CanActivate`.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Refresh Token Rotation (Option A) — Provides strongest security model with automatic theft detection. PostgreSQL already in stack.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Random Opaque Tokens in Database (Option B) — Revocability is important for email confirmation and password reset tokens.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** @nestjs-modules/mailer (Option A) — Best NestJS integration with minimal boilerplate. Handlebars templates for email formatting.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** class-validator + class-transformer (Option A) — Documented NestJS approach, project uses decorators extensively.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Custom Domain Exception Filter (Option A) — Machine-readable error codes in `{ statusCode, error, message }` format.

**Libraries:** —

### phase-01-configuracao-base/TD-01

**Recommendation:** @nestjs/config (Option A) — Official, core-team-maintained, NestJS 11 compatibility.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Joi (Option A) — First-class integration with `@nestjs/config` via `validationSchema`.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Namespaced/grouped with registerAs (Option B) — Clear file boundaries per domain, typed injection.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Shared registerAs factory (Option A) — `data-source.ts` imports the factory, zero duplication.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_
- `JwtAuthGuard` is registered as a global guard via `APP_GUARD` in `AuthModule`. All endpoints require authentication by default; `@Public()` opt out. _(from phase 02)_
- Auth endpoints follow the pattern: `@Public()` for register/login/confirm/forgot-password/reset-password, authenticated for logout. _(from phase 02)_
- DTOs use `class-validator` decorators; global `ValidationPipe` with `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`. _(from phase 02)_
- Domain exceptions extend a common `DomainException` base class; a global `DomainExceptionFilter` maps them to `{ statusCode, error, message }` responses. _(from phase 02)_
- Error codes from the error catalog are defined as `errorCode` string constants on domain exception classes. _(from phase 02)_
- Passwords are hashed with Argon2id (OWASP minimum: 19MiB memory, 2 iterations). _(from phase 02)_
- Transactions use `dataSource.transaction()` with async callback; create-save patterns use `manager.create()` + `manager.save()` inside transactions. _(from phase 02)_
- Channel/User creation pattern: `UsersService.createUserWithChannel()` saves user via repository, delegates channel creation to `ChannelsService.createChannel(userId, email)`, compensates on channel failure. _(from phase 02)_
- Email templates are Handlebars `.hbs` files in `src/mail/templates/`, copied to `dist/mail/templates/` via `nest-cli.json` assets. _(from phase 02)_
- Refresh tokens use JWT with SHA-256 hash stored in DB, family-based rotation with 10-second grace period for concurrent requests. _(from phase 02)_

## Inherited Deferred Capabilities

_No inherited deferred capabilities._

## Non-UI / Deferred Capabilities

_No UI surfaces in scope for this phase._

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type in `nestjs-project/`. Phase 03 introduces the video module (entities, services, controllers), a worker processor, new infrastructure services (MinIO, Redis), and a new Docker Compose service for the worker. Layer coverage by SI is recorded in `progress.md`.
