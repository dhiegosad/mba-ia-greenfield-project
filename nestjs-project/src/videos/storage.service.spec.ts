import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import {
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';
import { StorageModule } from './storage.module';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

const mockS3Send: jest.Mock = jest.fn();

jest.mock('@aws-sdk/client-s3', () => {
  const actual =
    jest.requireActual<typeof import('@aws-sdk/client-s3')>(
      '@aws-sdk/client-s3',
    );
  return {
    ...actual,
    S3Client: jest.fn(() => ({
      send: mockS3Send,
    })),
  };
});

const mockedGetSignedUrl = getSignedUrl as jest.Mock;

describe('StorageService', () => {
  let service: StorageService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          load: [storageConfig],
          ignoreEnvFile: true,
        }),
        StorageModule,
      ],
    }).compile();

    service = module.get(StorageService);
  });

  describe('key generation', () => {
    it('should generate correct video key', () => {
      const key = service.getVideoKey('abc-123', 'mp4');
      expect(key).toBe('videos/abc-123/original.mp4');
    });

    it('should generate correct thumbnail key', () => {
      const key = service.getThumbnailKey('abc-123');
      expect(key).toBe('videos/abc-123/thumbnail.jpg');
    });
  });

  describe('createMultipartUpload', () => {
    it('should dispatch CreateMultipartUploadCommand and return upload ID', async () => {
      mockS3Send.mockResolvedValueOnce({ UploadId: 'upload-001' });

      const uploadId = await service.createMultipartUpload(
        'video-1',
        'my-video.mp4',
        'video/mp4',
      );

      expect(uploadId).toBe('upload-001');
      expect(mockS3Send).toHaveBeenCalledTimes(1);
      const commandArg = (
        mockS3Send.mock.calls[0] as unknown[]
      )[0] as CreateMultipartUploadCommand;
      expect(commandArg.constructor.name).toBe('CreateMultipartUploadCommand');
    });
  });

  describe('presignUploadPart', () => {
    it('should generate a pre-signed URL for an upload part', async () => {
      mockedGetSignedUrl.mockResolvedValueOnce(
        'http://minio:9000/bucket/key?part=1&signature=xyz',
      );

      const url = await service.presignUploadPart(
        'video-1',
        'mp4',
        'upload-001',
        1,
      );

      expect(url).toContain('http://minio:9000');
      expect(mockedGetSignedUrl).toHaveBeenCalledTimes(1);
    });
  });

  describe('completeMultipartUpload', () => {
    it('should dispatch CompleteMultipartUploadCommand', async () => {
      mockS3Send.mockResolvedValueOnce({});

      await service.completeMultipartUpload('video-1', 'mp4', 'upload-001', [
        { PartNumber: 1, ETag: 'etag-1' },
      ]);

      expect(mockS3Send).toHaveBeenCalledTimes(1);
      const commandArg = (
        mockS3Send.mock.calls[0] as unknown[]
      )[0] as CompleteMultipartUploadCommand;
      expect(commandArg.constructor.name).toBe(
        'CompleteMultipartUploadCommand',
      );
    });
  });

  describe('abortMultipartUpload', () => {
    it('should dispatch AbortMultipartUploadCommand', async () => {
      mockS3Send.mockResolvedValueOnce({});

      await service.abortMultipartUpload('video-1', 'mp4', 'upload-001');

      expect(mockS3Send).toHaveBeenCalledTimes(1);
      const commandArg = (
        mockS3Send.mock.calls[0] as unknown[]
      )[0] as AbortMultipartUploadCommand;
      expect(commandArg.constructor.name).toBe('AbortMultipartUploadCommand');
    });
  });

  describe('presignGetUrl', () => {
    it('should generate a pre-signed GET URL for streaming', async () => {
      mockedGetSignedUrl.mockResolvedValueOnce(
        'http://minio:9000/bucket/key?signature=abc',
      );

      const url = await service.presignGetUrl('videos/v-1/original.mp4', 21600);

      expect(url).toContain('http://minio:9000');
      expect(mockedGetSignedUrl).toHaveBeenCalledTimes(1);
    });

    it('should include Content-Disposition when downloadFilename is provided', async () => {
      mockedGetSignedUrl.mockResolvedValueOnce(
        'http://minio:9000/bucket/key?download',
      );

      await service.presignGetUrl(
        'videos/v-1/original.mp4',
        300,
        'my-video.mp4',
      );

      const commandArg: { input: { ResponseContentDisposition: string } } = (
        mockedGetSignedUrl.mock.calls[0] as unknown[]
      )[1] as {
        input: { ResponseContentDisposition: string };
      };
      expect(commandArg.input.ResponseContentDisposition).toBe(
        'attachment; filename="my-video.mp4"',
      );
    });
  });

  describe('putObject', () => {
    it('should dispatch PutObjectCommand with correct params', async () => {
      mockS3Send.mockResolvedValueOnce({});

      const body = Buffer.from('fake-thumbnail');
      await service.putObject('videos/v-1/thumbnail.jpg', body, 'image/jpeg');

      expect(mockS3Send).toHaveBeenCalledTimes(1);
      const commandArg = (
        mockS3Send.mock.calls[0] as unknown[]
      )[0] as PutObjectCommand;
      expect(commandArg.constructor.name).toBe('PutObjectCommand');
    });
  });

  describe('deleteObject', () => {
    it('should dispatch DeleteObjectCommand', async () => {
      mockS3Send.mockResolvedValueOnce({});

      await service.deleteObject('videos/v-1/original.mp4');

      expect(mockS3Send).toHaveBeenCalledTimes(1);
      const commandArg = (
        mockS3Send.mock.calls[0] as unknown[]
      )[0] as DeleteObjectCommand;
      expect(commandArg.constructor.name).toBe('DeleteObjectCommand');
    });
  });
});
