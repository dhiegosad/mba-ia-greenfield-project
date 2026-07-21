import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';
import { StorageService } from './storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import {
  InvalidStatusTransitionException,
  VideoNotReadyException,
} from './exceptions/video-errors';

describe('VideosController', () => {
  let controller: VideosController;
  let videosService: jest.Mocked<
    Pick<
      VideosService,
      | 'createDraft'
      | 'findByPublicId'
      | 'findByChannel'
      | 'initiateUpload'
      | 'resetToDraft'
      | 'updateStatus'
      | 'enqueueProcessing'
      | 'assertStatusTransition'
      | 'retryProcessing'
    >
  >;
  let storageService: jest.Mocked<
    Pick<
      StorageService,
      | 'createMultipartUpload'
      | 'presignUploadPart'
      | 'completeMultipartUpload'
      | 'abortMultipartUpload'
      | 'getVideoKey'
      | 'presignGetUrl'
    >
  >;
  let channelRepo: jest.Mocked<Pick<Repository<Channel>, 'findOne'>>;

  const mockVideosService = {
    createDraft: jest.fn(),
    findByPublicId: jest.fn(),
    findByChannel: jest.fn(),
    initiateUpload: jest.fn(),
    resetToDraft: jest.fn(),
    updateStatus: jest.fn(),
    enqueueProcessing: jest.fn(),
    assertStatusTransition: jest.fn(),
    retryProcessing: jest.fn(),
  };

  const mockStorageService = {
    createMultipartUpload: jest.fn(),
    presignUploadPart: jest.fn(),
    completeMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
    getVideoKey: jest.fn(),
    presignGetUrl: jest.fn(),
  };

  const mockChannelRepo = {
    findOne: jest.fn(),
  };

  const mockChannel = {
    id: 'ch-uuid',
    name: 'My Channel',
    nickname: 'mychannel',
  } as Channel;

  const mockVideo = {
    id: 'v-uuid',
    public_id: 'abc123def45',
    status: VideoStatus.UPLOADING,
    original_filename: 'video.mp4',
    original_extension: 'mp4',
    upload_id: 's3-upload-001',
    channel_id: 'ch-uuid',
  } as Video;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module = await Test.createTestingModule({
      controllers: [VideosController],
      providers: [
        { provide: VideosService, useValue: mockVideosService },
        { provide: StorageService, useValue: mockStorageService },
        { provide: getRepositoryToken(Channel), useValue: mockChannelRepo },
      ],
    }).compile();

    controller = module.get(VideosController);
    videosService = module.get(VideosService);
    storageService = module.get(StorageService);
    channelRepo = module.get(getRepositoryToken(Channel));
  });

  describe('createDraft', () => {
    it('should create a draft linked to the current user channel', async () => {
      channelRepo.findOne.mockResolvedValue(mockChannel);
      mockVideosService.createDraft.mockResolvedValue({
        id: 'v-uuid',
        public_id: 'abc123def45',
        status: VideoStatus.DRAFT,
      } as Video);

      const result = await controller.createDraft(
        { sub: 'user-1', email: 'a@b.com' },
        { filename: 'video.mp4' },
      );

      expect(channelRepo.findOne).toHaveBeenCalledWith({
        where: { user_id: 'user-1' },
      });
      expect(mockVideosService.createDraft).toHaveBeenCalledWith(
        'ch-uuid',
        'video.mp4',
      );
      expect(result).toEqual({
        id: 'v-uuid',
        public_id: 'abc123def45',
        status: VideoStatus.DRAFT,
      });
    });

    it('should throw if user has no channel', async () => {
      channelRepo.findOne.mockResolvedValue(null);

      await expect(
        controller.createDraft(
          { sub: 'no-channel-user', email: 'a@b.com' },
          { filename: 'video.mp4' },
        ),
      ).rejects.toThrow('Channel not found for current user');
    });
  });

  describe('findByPublicId', () => {
    it('should return public video info with channel details', async () => {
      const video = {
        ...mockVideo,
        title: 'My Video',
        duration: 120,
        resolution_width: 1920,
        resolution_height: 1080,
        channel: mockChannel,
        created_at: new Date('2026-01-01'),
      } as Video;
      mockVideosService.findByPublicId.mockResolvedValue(video);

      const result = await controller.findByPublicId('abc123def45');

      expect(result).toMatchObject({
        id: 'v-uuid',
        title: 'My Video',
        channel: { id: 'ch-uuid', name: 'My Channel', nickname: 'mychannel' },
      });
    });

    it('should throw VideoNotFoundException when video does not exist', async () => {
      mockVideosService.findByPublicId.mockResolvedValue(null);

      await expect(controller.findByPublicId('nonexistent')).rejects.toThrow(
        'Video not found',
      );
    });
  });

  describe('findMyVideos', () => {
    it('should return videos for the current user channel', async () => {
      channelRepo.findOne.mockResolvedValue(mockChannel);
      mockVideosService.findByChannel.mockResolvedValue([
        {
          id: 'v-1',
          public_id: 'abc123',
          title: 'Test',
          status: VideoStatus.DRAFT,
          duration: null,
          created_at: new Date(),
        } as Video,
      ]);

      const result = await controller.findMyVideos({
        sub: 'user-1',
        email: 'a@b.com',
      });

      expect(result.videos).toHaveLength(1);
      expect(result.videos[0]).toHaveProperty('public_id', 'abc123');
    });

    it('should throw if user has no channel', async () => {
      channelRepo.findOne.mockResolvedValue(null);

      await expect(
        controller.findMyVideos({ sub: 'no-channel-user', email: 'a@b.com' }),
      ).rejects.toThrow('Channel not found for current user');
    });
  });

  describe('initiateUpload', () => {
    it('should create multipart upload and store upload_id', async () => {
      mockStorageService.createMultipartUpload.mockResolvedValue(
        's3-upload-002',
      );

      const result = await controller.initiateUpload(mockVideo);

      expect(mockVideosService.assertStatusTransition).toHaveBeenCalledWith(
        mockVideo,
        VideoStatus.UPLOADING,
      );
      expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
        'abc123def45',
        'video.mp4',
        'video/mp4',
      );
      expect(mockVideosService.initiateUpload).toHaveBeenCalledWith(
        'v-uuid',
        's3-upload-002',
      );
      expect(result).toEqual({
        upload_id: 's3-upload-002',
        max_parts: 10000,
        min_part_size: 5242880,
      });
    });

    it('should throw InvalidStatusTransitionException if status is not allowed', async () => {
      mockVideosService.assertStatusTransition.mockImplementation(() => {
        throw new InvalidStatusTransitionException(
          VideoStatus.PROCESSING,
          VideoStatus.UPLOADING,
        );
      });

      const processingVideo = {
        ...mockVideo,
        status: VideoStatus.PROCESSING,
      } as Video;

      await expect(controller.initiateUpload(processingVideo)).rejects.toThrow(
        InvalidStatusTransitionException,
      );
    });
  });

  describe('presignUploadParts', () => {
    it('should generate pre-signed URLs for each part number', async () => {
      mockStorageService.presignUploadPart
        .mockResolvedValueOnce('http://minio/part/1')
        .mockResolvedValueOnce('http://minio/part/2');

      const result = await controller.presignUploadParts(mockVideo, {
        part_numbers: [1, 2],
      });

      expect(result.parts).toHaveLength(2);
      expect(result.parts[0]).toEqual({
        part_number: 1,
        upload_url: 'http://minio/part/1',
      });
    });

    it('should throw InvalidStatusTransitionException if status is not uploading', async () => {
      const draftVideo = { ...mockVideo, status: VideoStatus.DRAFT } as Video;

      await expect(
        controller.presignUploadParts(draftVideo, { part_numbers: [1] }),
      ).rejects.toThrow(InvalidStatusTransitionException);
    });

    it('should throw ConflictException if no upload initiated', async () => {
      const noUploadVideo = {
        ...mockVideo,
        upload_id: null,
      } as Video;

      await expect(
        controller.presignUploadParts(noUploadVideo, { part_numbers: [1] }),
      ).rejects.toThrow('Upload has not been initiated yet');
    });
  });

  describe('completeUpload', () => {
    it('should complete multipart upload and enqueue processing', async () => {
      const result = await controller.completeUpload(mockVideo, {
        parts: [{ PartNumber: 1, ETag: 'etag-1' }],
      });

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'abc123def45',
        'mp4',
        's3-upload-001',
        [{ PartNumber: 1, ETag: 'etag-1' }],
      );
      expect(mockVideosService.updateStatus).toHaveBeenCalledWith(
        'v-uuid',
        VideoStatus.PROCESSING,
      );
      expect(mockVideosService.enqueueProcessing).toHaveBeenCalledWith(
        'v-uuid',
      );
      expect(result).toEqual({ status: VideoStatus.PROCESSING });
    });

    it('should throw InvalidStatusTransitionException if status is not uploading', async () => {
      const draftVideo = { ...mockVideo, status: VideoStatus.DRAFT } as Video;

      await expect(
        controller.completeUpload(draftVideo, {
          parts: [{ PartNumber: 1, ETag: 'etag-1' }],
        }),
      ).rejects.toThrow(InvalidStatusTransitionException);
    });
  });

  describe('getStreamUrl', () => {
    it('should return a pre-signed stream URL for a ready video', async () => {
      const readyVideo = { ...mockVideo, status: VideoStatus.READY } as Video;
      mockVideosService.findByPublicId.mockResolvedValue(readyVideo);
      mockStorageService.getVideoKey.mockReturnValue(
        'videos/abc123def45/original.mp4',
      );
      mockStorageService.presignGetUrl.mockResolvedValue(
        'http://minio/videos/abc123def45/original.mp4?sign=abc',
      );

      const result = await controller.getStreamUrl('abc123def45');

      expect(mockStorageService.getVideoKey).toHaveBeenCalledWith(
        'abc123def45',
        'mp4',
      );
      expect(mockStorageService.presignGetUrl).toHaveBeenCalledWith(
        'videos/abc123def45/original.mp4',
        21600,
      );
      expect(result).toEqual({
        url: 'http://minio/videos/abc123def45/original.mp4?sign=abc',
        expires_in: 21600,
      });
    });

    it('should throw VideoNotFoundException when video not found', async () => {
      mockVideosService.findByPublicId.mockResolvedValue(null);

      await expect(controller.getStreamUrl('nonexistent')).rejects.toThrow(
        'Video not found',
      );
    });

    it('should throw VideoNotReadyException when video is not ready', async () => {
      mockVideosService.findByPublicId.mockResolvedValue(mockVideo);

      await expect(controller.getStreamUrl('abc123def45')).rejects.toThrow(
        VideoNotReadyException,
      );
    });
  });

  describe('getDownloadUrl', () => {
    it('should return a pre-signed download URL with attachment disposition', async () => {
      const readyVideo = { ...mockVideo, status: VideoStatus.READY } as Video;
      mockVideosService.findByPublicId.mockResolvedValue(readyVideo);
      mockStorageService.getVideoKey.mockReturnValue(
        'videos/abc123def45/original.mp4',
      );
      mockStorageService.presignGetUrl.mockResolvedValue(
        'http://minio/videos/abc123def45/original.mp4?download',
      );

      const result = await controller.getDownloadUrl('abc123def45');

      expect(mockStorageService.presignGetUrl).toHaveBeenCalledWith(
        'videos/abc123def45/original.mp4',
        300,
        'video.mp4',
      );
      expect(result).toEqual({
        url: 'http://minio/videos/abc123def45/original.mp4?download',
        expires_in: 300,
        filename: 'video.mp4',
      });
    });

    it('should throw VideoNotFoundException when video not found', async () => {
      mockVideosService.findByPublicId.mockResolvedValue(null);

      await expect(controller.getDownloadUrl('nonexistent')).rejects.toThrow(
        'Video not found',
      );
    });

    it('should throw VideoNotReadyException when video is not ready', async () => {
      mockVideosService.findByPublicId.mockResolvedValue(mockVideo);

      await expect(controller.getDownloadUrl('abc123def45')).rejects.toThrow(
        VideoNotReadyException,
      );
    });
  });

  describe('retryProcessing', () => {
    it('should retry processing for an error video', async () => {
      const errorVideo = { ...mockVideo, status: VideoStatus.ERROR } as Video;

      const result = await controller.retryProcessing(errorVideo);

      expect(mockVideosService.retryProcessing).toHaveBeenCalledWith('v-uuid');
      expect(result).toEqual({ status: VideoStatus.PROCESSING });
    });

    it('should throw InvalidStatusTransitionException if status is not error', async () => {
      const readyVideo = { ...mockVideo, status: VideoStatus.READY } as Video;

      await expect(controller.retryProcessing(readyVideo)).rejects.toThrow(
        InvalidStatusTransitionException,
      );
    });
  });

  describe('abortUpload', () => {
    it('should abort multipart upload and reset to draft', async () => {
      await controller.abortUpload(mockVideo);

      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        'abc123def45',
        'mp4',
        's3-upload-001',
      );
      expect(mockVideosService.resetToDraft).toHaveBeenCalledWith('v-uuid');
    });

    it('should throw InvalidStatusTransitionException if status is not uploading', async () => {
      const draftVideo = { ...mockVideo, status: VideoStatus.DRAFT } as Video;

      await expect(controller.abortUpload(draftVideo)).rejects.toThrow(
        InvalidStatusTransitionException,
      );
    });

    it('should skip S3 abort if no upload_id exists', async () => {
      const noUploadVideo = {
        ...mockVideo,
        upload_id: null,
      } as Video;

      await controller.abortUpload(noUploadVideo);

      expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
      expect(mockVideosService.resetToDraft).toHaveBeenCalled();
    });
  });
});
