import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { execFile } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { cleanAllTables } from '../src/test/create-test-data-source';

const execFileAsync = promisify(execFile);

interface DraftBody {
  id: string;
  public_id: string;
  status: string;
}

interface InitiateBody {
  upload_id: string;
  max_parts: number;
  min_part_size: number;
}

interface PartsBody {
  parts: { part_number: number; upload_url: string }[];
}

interface CompleteBody {
  status: string;
}

interface VideoInfoBody {
  public_id: string;
  status: string;
  channel: Record<string, unknown>;
}

interface ChannelVideosBody {
  videos: unknown[];
}

interface StreamBody {
  url: string;
  expires_in: number;
}

interface DownloadBody {
  url: string;
  expires_in: number;
  filename: string;
}

const pollUntil = async (
  fn: () => Promise<boolean>,
  timeoutMs = 60000,
  intervalMs = 2000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
};

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const timeoutIds = (
      throttlerStorage as unknown as { timeoutIds: Map<string, number[]> }
    ).timeoutIds;
    timeoutIds.forEach((timeouts) => timeouts.forEach(clearTimeout));
    timeoutIds.clear();
    throttlerStorage.storage.clear();
  });

  async function captureConfirmationToken(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const authService = app.get(AuthService);

    const mailServiceInstance = (
      authService as unknown as {
        mailService: {
          sendConfirmationEmail: (...args: unknown[]) => Promise<void>;
        };
      }
    ).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        capturedToken = t;
        return Promise.resolve();
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);
    return capturedToken;
  }

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<{ access_token: string }> {
    const token = await captureConfirmationToken(email, password);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token })
      .expect(204);

    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);

    return {
      access_token: (loginRes.body as { access_token: string }).access_token,
    };
  }

  function authHeader(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  describe('POST /videos/drafts', () => {
    it('should return 201 with draft video for authenticated user', async () => {
      const { access_token } =
        await registerConfirmAndLogin('creator@test.com');

      const res = await request(app.getHttpServer())
        .post('/videos/drafts')
        .set(authHeader(access_token))
        .send({ filename: 'my-video.mp4' })
        .expect(201);

      const body = res.body as DraftBody;
      expect(body.id).toBeDefined();
      expect(body.public_id).toHaveLength(11);
      expect(body.status).toBe('draft');
    });

    it('should return 401 without authentication', async () => {
      await request(app.getHttpServer())
        .post('/videos/drafts')
        .send({ filename: 'video.mp4' })
        .expect(401);
    });

    it('should return 400 when filename is missing', async () => {
      const { access_token } =
        await registerConfirmAndLogin('creator2@test.com');

      await request(app.getHttpServer())
        .post('/videos/drafts')
        .set(authHeader(access_token))
        .send({})
        .expect(400);
    });
  });

  describe('GET /videos/:publicId', () => {
    it('should return video info for anonymous access', async () => {
      const { access_token } = await registerConfirmAndLogin('owner@test.com');

      const draft = await request(app.getHttpServer())
        .post('/videos/drafts')
        .set(authHeader(access_token))
        .send({ filename: 'public-video.mp4' })
        .expect(201);

      const draftBody = draft.body as DraftBody;

      const res = await request(app.getHttpServer())
        .get(`/videos/${draftBody.public_id}`)
        .expect(200);

      const body = res.body as VideoInfoBody;
      expect(body.public_id).toBe(draftBody.public_id);
      expect(body.status).toBe('draft');
      expect(body.channel).toBeDefined();
    });

    it('should return 404 for non-existent video', async () => {
      await request(app.getHttpServer()).get('/videos/nonexistent').expect(404);
    });
  });

  describe('GET /videos/channel/mine', () => {
    it('should return videos for authenticated user', async () => {
      const { access_token } =
        await registerConfirmAndLogin('myvideos@test.com');

      await request(app.getHttpServer())
        .post('/videos/drafts')
        .set(authHeader(access_token))
        .send({ filename: 'video1.mp4' })
        .expect(201);

      await request(app.getHttpServer())
        .post('/videos/drafts')
        .set(authHeader(access_token))
        .send({ filename: 'video2.mp4' })
        .expect(201);

      const res = await request(app.getHttpServer())
        .get('/videos/channel/mine')
        .set(authHeader(access_token))
        .expect(200);

      const body = res.body as ChannelVideosBody;
      expect(body.videos).toHaveLength(2);
    });

    it('should return 401 without authentication', async () => {
      await request(app.getHttpServer())
        .get('/videos/channel/mine')
        .expect(401);
    });
  });

  describe('Upload flow authorization', () => {
    it('should return 403 when non-owner tries to access upload endpoints', async () => {
      const { access_token: ownerToken } =
        await registerConfirmAndLogin('owner@test.com');
      const { access_token: attackerToken } =
        await registerConfirmAndLogin('attacker@test.com');

      const draft = await request(app.getHttpServer())
        .post('/videos/drafts')
        .set(authHeader(ownerToken))
        .send({ filename: 'secret.mp4' })
        .expect(201);

      const publicId = (draft.body as DraftBody).public_id;

      await request(app.getHttpServer())
        .post(`/videos/${publicId}/uploads/initiate`)
        .set(authHeader(attackerToken))
        .expect(403);

      await request(app.getHttpServer())
        .post(`/videos/${publicId}/uploads/parts`)
        .set(authHeader(attackerToken))
        .send({ part_numbers: [1] })
        .expect(403);

      await request(app.getHttpServer())
        .post(`/videos/${publicId}/uploads/complete`)
        .set(authHeader(attackerToken))
        .send({ parts: [{ PartNumber: 1, ETag: 'etag' }] })
        .expect(403);

      await request(app.getHttpServer())
        .post(`/videos/${publicId}/uploads/abort`)
        .set(authHeader(attackerToken))
        .expect(403);
    });
  });

  describe('Upload multipart flow', () => {
    it('should complete full upload lifecycle: initiate → parts → complete', async () => {
      const { access_token } =
        await registerConfirmAndLogin('uploader@test.com');

      const draft = await request(app.getHttpServer())
        .post('/videos/drafts')
        .set(authHeader(access_token))
        .send({ filename: 'big-video.mp4' })
        .expect(201);

      const publicId = (draft.body as DraftBody).public_id;

      const init = await request(app.getHttpServer())
        .post(`/videos/${publicId}/uploads/initiate`)
        .set(authHeader(access_token))
        .expect(201);

      const initBody = init.body as InitiateBody;
      expect(initBody.upload_id).toBeDefined();
      expect(initBody.max_parts).toBe(10000);
      expect(initBody.min_part_size).toBe(5242880);

      const partsRes = await request(app.getHttpServer())
        .post(`/videos/${publicId}/uploads/parts`)
        .set(authHeader(access_token))
        .send({ part_numbers: [1] })
        .expect(201);

      const partsBody = partsRes.body as PartsBody;
      expect(partsBody.parts).toHaveLength(1);
      expect(partsBody.parts[0].part_number).toBe(1);
      expect(partsBody.parts[0].upload_url).toBeDefined();

      const uploadUrl = partsBody.parts[0].upload_url;
      const partData = Buffer.alloc(6 * 1024 * 1024, 'a');
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        body: partData,
      });
      expect(putRes.ok).toBe(true);
      const etag = putRes.headers.get('etag') || '';

      const complete = await request(app.getHttpServer())
        .post(`/videos/${publicId}/uploads/complete`)
        .set(authHeader(access_token))
        .send({ parts: [{ PartNumber: 1, ETag: etag }] })
        .expect(201);

      expect((complete.body as CompleteBody).status).toBe('processing');
    });

    it('should abort upload and reset to draft', async () => {
      const { access_token } =
        await registerConfirmAndLogin('aborter@test.com');

      const draft = await request(app.getHttpServer())
        .post('/videos/drafts')
        .set(authHeader(access_token))
        .send({ filename: 'abort-me.mp4' })
        .expect(201);

      const publicId = (draft.body as DraftBody).public_id;

      await request(app.getHttpServer())
        .post(`/videos/${publicId}/uploads/initiate`)
        .set(authHeader(access_token))
        .expect(201);

      await request(app.getHttpServer())
        .post(`/videos/${publicId}/uploads/abort`)
        .set(authHeader(access_token))
        .expect(204);

      const videoInfo = await request(app.getHttpServer())
        .get(`/videos/${publicId}`)
        .expect(200);

      expect((videoInfo.body as VideoInfoBody).status).toBe('draft');
    });
  });

  describe('Status transition guards', () => {
    it('should return 409 when initiating upload on a processing video', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'transition@test.com',
      );

      const draft = await request(app.getHttpServer())
        .post('/videos/drafts')
        .set(authHeader(access_token))
        .send({ filename: 'transition.mp4' })
        .expect(201);

      const publicId = (draft.body as DraftBody).public_id;

      await request(app.getHttpServer())
        .post(`/videos/${publicId}/uploads/initiate`)
        .set(authHeader(access_token))
        .expect(201);

      const partsRes = await request(app.getHttpServer())
        .post(`/videos/${publicId}/uploads/parts`)
        .set(authHeader(access_token))
        .send({ part_numbers: [1] })
        .expect(201);

      const uploadUrl = (partsRes.body as PartsBody).parts[0].upload_url;
      const partData = Buffer.alloc(6 * 1024 * 1024, 'b');
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        body: partData,
      });
      const etag = putRes.headers.get('etag') || '';

      await request(app.getHttpServer())
        .post(`/videos/${publicId}/uploads/complete`)
        .set(authHeader(access_token))
        .send({ parts: [{ PartNumber: 1, ETag: etag }] })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/videos/${publicId}/uploads/initiate`)
        .set(authHeader(access_token))
        .expect(409);
    });

    it('should return 409 when retrying a non-error video', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'retry-transition@test.com',
      );

      const draft = await request(app.getHttpServer())
        .post('/videos/drafts')
        .set(authHeader(access_token))
        .send({ filename: 'noretry.mp4' })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/videos/${(draft.body as DraftBody).public_id}/retry`)
        .set(authHeader(access_token))
        .expect(409);
    });
  });

  describe('Streaming and download', () => {
    it('should return 409 for stream and download when video is not ready', async () => {
      const { access_token } =
        await registerConfirmAndLogin('notready@test.com');

      const draft = await request(app.getHttpServer())
        .post('/videos/drafts')
        .set(authHeader(access_token))
        .send({ filename: 'not-ready.mp4' })
        .expect(201);

      const publicId = (draft.body as DraftBody).public_id;

      await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .expect(409);

      await request(app.getHttpServer())
        .get(`/videos/${publicId}/download`)
        .expect(409);
    });

    it('should be accessible anonymously', async () => {
      const { access_token } = await registerConfirmAndLogin('anon@test.com');

      const draft = await request(app.getHttpServer())
        .post('/videos/drafts')
        .set(authHeader(access_token))
        .send({ filename: 'anon-video.mp4' })
        .expect(201);

      const publicId = (draft.body as DraftBody).public_id;

      await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .expect(409);

      await request(app.getHttpServer())
        .get(`/videos/${publicId}/download`)
        .expect(409);
    });
  });

  describe('Worker processing', () => {
    it('should process an uploaded video and expose streaming and download URLs', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'worker-e2e@test.com',
      );

      const draft = await request(app.getHttpServer())
        .post('/videos/drafts')
        .set(authHeader(access_token))
        .send({ filename: 'e2e-processed.mp4' })
        .expect(201);

      const publicId = (draft.body as DraftBody).public_id;

      await request(app.getHttpServer())
        .post(`/videos/${publicId}/uploads/initiate`)
        .set(authHeader(access_token))
        .expect(201);

      const partsRes = await request(app.getHttpServer())
        .post(`/videos/${publicId}/uploads/parts`)
        .set(authHeader(access_token))
        .send({ part_numbers: [1] })
        .expect(201);

      const uploadUrl = (partsRes.body as PartsBody).parts[0].upload_url;

      const tempDir = tmpdir();
      const randPrefix = randomBytes(4).toString('hex');
      const tempVideoPath = join(tempDir, `${randPrefix}-e2e.mp4`);

      try {
        await execFileAsync('ffmpeg', [
          '-f',
          'lavfi',
          '-i',
          'testsrc=duration=6:size=640x480:rate=30',
          '-c:v',
          'libx264',
          '-b:v',
          '8M',
          '-pix_fmt',
          'yuv420p',
          '-y',
          tempVideoPath,
        ]);

        const videoBuffer = await readFile(tempVideoPath);
        const putRes = await fetch(uploadUrl, {
          method: 'PUT',
          body: videoBuffer,
        });
        expect(putRes.ok).toBe(true);
        const etag = putRes.headers.get('etag') || '';

        const complete = await request(app.getHttpServer())
          .post(`/videos/${publicId}/uploads/complete`)
          .set(authHeader(access_token))
          .send({ parts: [{ PartNumber: 1, ETag: etag }] })
          .expect(201);

        expect((complete.body as CompleteBody).status).toBe('processing');

        await pollUntil(
          async () => {
            const rows = await dataSource.query<{ status: string }[]>(
              'SELECT status FROM videos WHERE public_id = $1',
              [publicId],
            );
            return rows.length > 0 && rows[0].status === 'ready';
          },
          120000,
          2000,
        );

        const streamRes = await request(app.getHttpServer())
          .get(`/videos/${publicId}/stream`)
          .expect(200);
        const streamBody = streamRes.body as StreamBody;
        expect(streamBody.url).toBeTruthy();
        expect(streamBody.expires_in).toBe(21600);

        const downloadRes = await request(app.getHttpServer())
          .get(`/videos/${publicId}/download`)
          .expect(200);
        const downloadBody = downloadRes.body as DownloadBody;
        expect(downloadBody.url).toBeTruthy();
        expect(downloadBody.filename).toBe('e2e-processed.mp4');
      } finally {
        await unlink(tempVideoPath).catch(() => {});
      }
    }, 180000);
  });

  describe('Error handling', () => {
    it('should handle invalid video data without crashing and allow retry on error', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'badvideo-e2e@test.com',
      );

      const draft = await request(app.getHttpServer())
        .post('/videos/drafts')
        .set(authHeader(access_token))
        .send({ filename: 'corrupt.mp4' })
        .expect(201);

      const publicId = (draft.body as DraftBody).public_id;

      await request(app.getHttpServer())
        .post(`/videos/${publicId}/uploads/initiate`)
        .set(authHeader(access_token))
        .expect(201);

      const partsRes = await request(app.getHttpServer())
        .post(`/videos/${publicId}/uploads/parts`)
        .set(authHeader(access_token))
        .send({ part_numbers: [1] })
        .expect(201);

      const uploadUrl = (partsRes.body as PartsBody).parts[0].upload_url;

      const garbage = Buffer.alloc(6 * 1024 * 1024, 'x');
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        body: garbage,
      });
      expect(putRes.ok).toBe(true);
      const etag = putRes.headers.get('etag') || '';

      const complete = await request(app.getHttpServer())
        .post(`/videos/${publicId}/uploads/complete`)
        .set(authHeader(access_token))
        .send({ parts: [{ PartNumber: 1, ETag: etag }] })
        .expect(201);

      expect((complete.body as CompleteBody).status).toBe('processing');

      await pollUntil(
        async () => {
          const rows = await dataSource.query<
            { error_retries: number; status_message: string | null }[]
          >(
            'SELECT error_retries, status_message FROM videos WHERE public_id = $1',
            [publicId],
          );
          return rows.length > 0 && Number(rows[0].error_retries) > 0;
        },
        60000,
        2000,
      );

      const videoInfo = await request(app.getHttpServer())
        .get(`/videos/${publicId}`)
        .expect(200);
      expect((videoInfo.body as VideoInfoBody).status).not.toBe('ready');

      await request(app.getHttpServer())
        .post(`/videos/${publicId}/retry`)
        .set(authHeader(access_token))
        .expect(409);
    }, 120000);
  });
});
