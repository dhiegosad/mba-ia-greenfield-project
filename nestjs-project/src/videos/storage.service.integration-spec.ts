import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';
import { StorageModule } from './storage.module';

describe('StorageService (integration)', () => {
  let service: StorageService;
  let s3Client: S3Client;
  const videoId = 'test-video-001';

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          load: [storageConfig],
          ignoreEnvFile: true,
          envFilePath: undefined,
        }),
        StorageModule,
      ],
    }).compile();

    service = module.get(StorageService);

    const cfg = module.get(storageConfig.KEY);
    s3Client = new S3Client({
      endpoint: `http://${cfg.endpoint}:${cfg.port}`,
      region: 'us-east-1',
      credentials: {
        accessKeyId: cfg.accessKey,
        secretAccessKey: cfg.secretKey,
      },
      forcePathStyle: true,
    });
  });

  describe('MinIO connectivity', () => {
    it('should have bucket created on module init', async () => {
      await service.onModuleInit();

      const signedUrl = await getSignedUrl(
        s3Client,
        new GetObjectCommand({
          Bucket: 'streamtube',
          Key: 'non-existent-file',
        }),
        { expiresIn: 60 },
      );

      expect(signedUrl).toContain('streamtube');
    });
  });

  describe('multipart upload lifecycle', () => {
    const extension = 'mp4';

    it('should create a multipart upload and return an upload ID', async () => {
      const uploadId = await service.createMultipartUpload(
        videoId,
        `video.${extension}`,
        'video/mp4',
      );

      expect(uploadId).toBeDefined();
      expect(typeof uploadId).toBe('string');
      expect(uploadId.length).toBeGreaterThan(0);
    });

    it('should generate pre-signed URLs for upload parts', async () => {
      const url = await service.presignUploadPart(
        videoId,
        extension,
        'test-upload-id',
        1,
        60,
      );

      expect(url).toContain('http://');
      expect(url).toContain('partNumber=1');
    });
  });

  describe('presignGetUrl', () => {
    it('should generate a pre-signed GET URL for an object', async () => {
      const url = await service.presignGetUrl(
        `videos/${videoId}/original.mp4`,
        60,
      );

      expect(url).toContain('http://');
    });

    it('should generate a download URL with Content-Disposition', async () => {
      const url = await service.presignGetUrl(
        `videos/${videoId}/original.mp4`,
        60,
        'my-video.mp4',
      );

      expect(url).toContain('http://');
      expect(url).toContain('response-content-disposition');
    });
  });

  describe('put and get object via pre-signed URLs', () => {
    const testKey = 'test/hello.txt';

    afterEach(async () => {
      try {
        await service.deleteObject(testKey);
      } catch {
        // ignore if object doesn't exist
      }
    });

    it('should upload an object via pre-signed PUT and retrieve it via pre-signed GET', async () => {
      const putCommand = new PutObjectCommand({
        Bucket: 'streamtube',
        Key: testKey,
      });

      const putUrl = await getSignedUrl(s3Client, putCommand, {
        expiresIn: 60,
      });

      const response = await fetch(putUrl, {
        method: 'PUT',
        body: 'hello world',
      });

      expect(response.ok).toBe(true);

      const getCommand = new GetObjectCommand({
        Bucket: 'streamtube',
        Key: testKey,
      });

      const getUrl = await getSignedUrl(s3Client, getCommand, {
        expiresIn: 60,
      });

      const getResponse = await fetch(getUrl);
      const text = await getResponse.text();
      expect(text).toBe('hello world');
    });
  });
});
