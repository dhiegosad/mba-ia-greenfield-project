import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { Video, VideoStatus, ProcessingStep } from './entities/video.entity';
import { VideosService } from './videos.service';
import { StorageService } from './storage.service';
import {
  VideoNotOwnedException,
  InvalidStatusTransitionException,
} from './exceptions/video-errors';

describe('VideosService', () => {
  let service: VideosService;

  const mockVideoRepo = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    update: jest.fn(),
    increment: jest.fn(),
  };

  const mockQueue = {
    add: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: mockVideoRepo },
        { provide: StorageService, useValue: {} },
        { provide: getQueueToken('videos'), useValue: mockQueue },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  describe('createDraft', () => {
    it('should generate an 11-char public_id and save with draft status', async () => {
      const savedVideo = {
        id: 'uuid-1',
        public_id: 'abc123def45',
        status: VideoStatus.DRAFT,
        channel_id: 'ch-1',
        original_filename: 'video.mp4',
        original_extension: 'mp4',
      };
      mockVideoRepo.create.mockReturnValue(savedVideo);
      mockVideoRepo.save.mockResolvedValue(savedVideo as Video);

      const result = await service.createDraft('ch-1', 'video.mp4');

      expect(mockVideoRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'ch-1',
          original_filename: 'video.mp4',
          original_extension: 'mp4',
          status: VideoStatus.DRAFT,
        }),
      );
      const createdDraft = (
        mockVideoRepo.create.mock.calls[0] as unknown[]
      )[0] as {
        public_id: string;
      };
      expect(createdDraft.public_id).toHaveLength(11);
      expect(result).toEqual(savedVideo);
    });

    it('should default extension to mp4 when filename has no dot', async () => {
      mockVideoRepo.create.mockReturnValue({});
      mockVideoRepo.save.mockResolvedValue({} as Video);

      await service.createDraft('ch-1', 'noextension');

      expect(mockVideoRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          original_extension: 'mp4',
        }),
      );
    });
  });

  describe('findByPublicId', () => {
    it('should return video with channel relation loaded', async () => {
      const video = { id: 'v-1', public_id: 'abc123' } as Video;
      mockVideoRepo.findOne.mockResolvedValue(video);

      const result = await service.findByPublicId('abc123');

      expect(result).toBe(video);
      expect(mockVideoRepo.findOne).toHaveBeenCalledWith({
        where: { public_id: 'abc123' },
        relations: ['channel'],
      });
    });

    it('should return null when not found', async () => {
      mockVideoRepo.findOne.mockResolvedValue(null);

      const result = await service.findByPublicId('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findByChannel', () => {
    it('should return videos ordered by created_at DESC', async () => {
      const videos = [{ id: 'v-1' }, { id: 'v-2' }] as Video[];
      mockVideoRepo.find.mockResolvedValue(videos);

      const result = await service.findByChannel('ch-1');

      expect(result).toEqual(videos);
      expect(mockVideoRepo.find).toHaveBeenCalledWith({
        where: { channel_id: 'ch-1' },
        order: { created_at: 'DESC' },
      });
    });
  });

  describe('updateStatus', () => {
    it('should update status and optional fields', async () => {
      mockVideoRepo.update.mockResolvedValue({ affected: 1 } as never);

      await service.updateStatus('v-1', VideoStatus.PROCESSING, {
        processingStep: ProcessingStep.METADATA,
        statusMessage: 'Extracting metadata',
      });

      expect(mockVideoRepo.update).toHaveBeenCalledWith('v-1', {
        status: VideoStatus.PROCESSING,
        processing_step: ProcessingStep.METADATA,
        status_message: 'Extracting metadata',
      });
    });

    it('should increment retries when requested', async () => {
      mockVideoRepo.update.mockResolvedValue({ affected: 1 } as never);
      mockVideoRepo.increment.mockResolvedValue({} as never);

      await service.updateStatus('v-1', VideoStatus.ERROR, {
        incrementRetries: true,
      });

      expect(mockVideoRepo.increment).toHaveBeenCalledWith(
        { id: 'v-1' },
        'error_retries',
        1,
      );
    });
  });

  describe('setVideoMetadata', () => {
    it('should update all processing metadata columns', async () => {
      mockVideoRepo.update.mockResolvedValue({ affected: 1 } as never);

      await service.setVideoMetadata('v-1', {
        duration: 120,
        width: 1920,
        height: 1080,
        codec: 'h264',
        bitrate: 5000,
        fileSize: 1024000,
      });

      expect(mockVideoRepo.update).toHaveBeenCalledWith('v-1', {
        duration: 120,
        resolution_width: 1920,
        resolution_height: 1080,
        codec: 'h264',
        bitrate: 5000,
        file_size: 1024000,
      });
    });
  });

  describe('initiateUpload', () => {
    it('should store upload_id and set status to uploading', async () => {
      mockVideoRepo.update.mockResolvedValue({ affected: 1 } as never);

      await service.initiateUpload('v-1', 's3-upload-001');

      expect(mockVideoRepo.update).toHaveBeenCalledWith('v-1', {
        upload_id: 's3-upload-001',
        status: VideoStatus.UPLOADING,
      });
    });
  });

  describe('resetToDraft', () => {
    it('should clear upload_id and set status to draft', async () => {
      mockVideoRepo.update.mockResolvedValue({ affected: 1 } as never);

      await service.resetToDraft('v-1');

      expect(mockVideoRepo.update).toHaveBeenCalledWith('v-1', {
        upload_id: null,
        status: VideoStatus.DRAFT,
      });
    });
  });

  describe('enqueueProcessing', () => {
    it('should add a process-video job to the queue', async () => {
      await service.enqueueProcessing('v-1');

      expect(mockQueue.add).toHaveBeenCalledWith('process-video', {
        videoId: 'v-1',
      });
    });
  });

  describe('assertOwnership', () => {
    it('should not throw when user owns the video', () => {
      const video = {
        channel: { user_id: 'user-1' },
      } as Video;

      expect(() => service.assertOwnership(video, 'user-1')).not.toThrow();
    });

    it('should throw VideoNotOwnedException when user does not own the video', () => {
      const video = {
        channel: { user_id: 'owner-1' },
      } as Video;

      expect(() => service.assertOwnership(video, 'user-2')).toThrow(
        VideoNotOwnedException,
      );
    });
  });

  describe('assertStatusTransition', () => {
    it('should not throw for valid transition (draft → uploading)', () => {
      const video = { status: VideoStatus.DRAFT } as Video;

      expect(() =>
        service.assertStatusTransition(video, VideoStatus.UPLOADING),
      ).not.toThrow();
    });

    it('should not throw for valid transition (uploading → processing)', () => {
      const video = { status: VideoStatus.UPLOADING } as Video;

      expect(() =>
        service.assertStatusTransition(video, VideoStatus.PROCESSING),
      ).not.toThrow();
    });

    it('should not throw for valid transition (error → processing)', () => {
      const video = { status: VideoStatus.ERROR } as Video;

      expect(() =>
        service.assertStatusTransition(video, VideoStatus.PROCESSING),
      ).not.toThrow();
    });

    it('should throw InvalidStatusTransitionException for invalid transition', () => {
      const video = { status: VideoStatus.READY } as Video;

      expect(() =>
        service.assertStatusTransition(video, VideoStatus.UPLOADING),
      ).toThrow(InvalidStatusTransitionException);
    });

    it('should throw InvalidStatusTransitionException when transitioning from ready', () => {
      const video = { status: VideoStatus.READY } as Video;

      expect(() =>
        service.assertStatusTransition(video, VideoStatus.PROCESSING),
      ).toThrow(InvalidStatusTransitionException);
    });
  });

  describe('retryProcessing', () => {
    it('should reset error_retries and enqueue processing', async () => {
      mockVideoRepo.update.mockResolvedValue({ affected: 1 } as never);

      await service.retryProcessing('v-1');

      expect(mockVideoRepo.update).toHaveBeenCalledWith('v-1', {
        status: VideoStatus.PROCESSING,
        error_retries: 0,
        status_message: null,
      });
      expect(mockQueue.add).toHaveBeenCalledWith('process-video', {
        videoId: 'v-1',
      });
    });
  });
});
