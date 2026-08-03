import { Test } from '@nestjs/testing';
import { Job } from 'bullmq';
import { execFile } from 'node:child_process';
import { unlink, readFile } from 'node:fs/promises';
import { VideoProcessor } from './video-processor';
import { VideosService } from './videos.service';
import { StorageService } from './storage.service';
import { VideoStatus, ProcessingStep } from './entities/video.entity';
import type { Video } from './entities/video.entity';

jest.mock('node:child_process', () => ({
  execFile: jest.fn(),
}));

jest.mock('node:fs/promises', () => ({
  writeFile: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
  readFile: jest.fn().mockResolvedValue(Buffer.from('')),
}));

describe('VideoProcessor', () => {
  let processor: VideoProcessor;

  const mockVideosService = {
    findById: jest.fn(),
    findByPublicId: jest.fn(),
    updateStatus: jest.fn(),
    setVideoMetadata: jest.fn(),
  };

  const mockStorageService = {
    getVideoKey: jest.fn(),
    getThumbnailKey: jest.fn(),
    presignGetUrl: jest.fn(),
    putObject: jest.fn(),
  };

  const mockVideo = {
    id: 'v-uuid',
    public_id: 'abc123def45',
    original_extension: 'mp4',
    error_retries: 0,
  } as Video;

  const ffprobeOutput = JSON.stringify({
    format: {
      duration: '120.5',
      size: '10240000',
      bit_rate: '5000000',
    },
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        width: 1920,
        height: 1080,
        bit_rate: '4500000',
      },
    ],
  });

  const thumbnailBuffer = Buffer.from('fake-jpeg');

  function callbackWith(stdout: string) {
    return (
      _cmd: string,
      _args: string[],
      cb: (
        err: Error | null,
        result: { stdout: string; stderr: string },
      ) => void,
    ) => {
      cb(null, { stdout, stderr: '' });
    };
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    });

    const module = await Test.createTestingModule({
      providers: [
        VideoProcessor,
        { provide: VideosService, useValue: mockVideosService },
        { provide: StorageService, useValue: mockStorageService },
      ],
    }).compile();

    processor = module.get(VideoProcessor);
  });

  describe('process', () => {
    it('should process a video: extract metadata and generate thumbnail', async () => {
      mockVideosService.findById.mockResolvedValue(mockVideo);
      mockStorageService.getVideoKey.mockReturnValue(
        'videos/abc123def45/original.mp4',
      );
      mockStorageService.getThumbnailKey.mockReturnValue(
        'videos/abc123def45/thumbnail.jpg',
      );
      mockStorageService.presignGetUrl.mockResolvedValue(
        'http://minio/video.mp4',
      );
      (execFile as unknown as jest.Mock)
        .mockImplementationOnce(callbackWith(ffprobeOutput))
        .mockImplementationOnce(callbackWith(''));
      (readFile as jest.Mock).mockResolvedValue(thumbnailBuffer);

      await processor.process({
        data: { videoId: 'v-uuid' },
      } as unknown as Job<{ videoId: string }>);

      expect(mockVideosService.updateStatus).toHaveBeenCalledWith(
        'v-uuid',
        VideoStatus.PROCESSING,
        { processingStep: ProcessingStep.METADATA },
      );
      expect(mockVideosService.setVideoMetadata).toHaveBeenCalledWith(
        'v-uuid',
        {
          duration: 121,
          width: 1920,
          height: 1080,
          codec: 'h264',
          bitrate: 4500000,
          fileSize: 10240000,
        },
      );
      expect(mockVideosService.updateStatus).toHaveBeenCalledWith(
        'v-uuid',
        VideoStatus.PROCESSING,
        { processingStep: ProcessingStep.THUMBNAIL },
      );
      expect(mockStorageService.putObject).toHaveBeenCalledWith(
        'videos/abc123def45/thumbnail.jpg',
        thumbnailBuffer,
        'image/jpeg',
      );
      expect(mockVideosService.updateStatus).toHaveBeenCalledWith(
        'v-uuid',
        VideoStatus.READY,
      );
    });

    it('should throw and handle error for non-existent video', async () => {
      mockVideosService.findById.mockResolvedValue(null);

      const job = { data: { videoId: 'nonexistent' } } as unknown as Job<{
        videoId: string;
      }>;

      await expect(processor.process(job)).rejects.toThrow(
        'Video nonexistent not found',
      );
    });

    it('should clean up temp files in finally block', async () => {
      mockVideosService.findById.mockResolvedValue(mockVideo);
      mockStorageService.getVideoKey.mockReturnValue('key');
      mockStorageService.getThumbnailKey.mockReturnValue('thumb-key');
      mockStorageService.presignGetUrl.mockResolvedValue('http://minio/v');
      (execFile as unknown as jest.Mock)
        .mockImplementationOnce(callbackWith(ffprobeOutput))
        .mockImplementationOnce(callbackWith(''));
      (readFile as jest.Mock).mockResolvedValue(thumbnailBuffer);

      await processor.process({
        data: { videoId: 'v-uuid' },
      } as unknown as Job<{ videoId: string }>);

      expect(unlink).toHaveBeenCalledTimes(2);
    });
  });
});
