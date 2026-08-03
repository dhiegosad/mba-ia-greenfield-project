import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { nanoid } from 'nanoid';
import { Video } from './entities/video.entity';
import { VideoStatus, ProcessingStep } from './entities/video.entity';
import { StorageService } from './storage.service';
import { ALLOWED_TRANSITIONS } from './videos.constants';
import {
  VideoNotOwnedException,
  InvalidStatusTransitionException,
} from './exceptions/video-errors';

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepo: Repository<Video>,
    private readonly storageService: StorageService,
    @InjectQueue('videos')
    private readonly videoQueue: Queue,
  ) {}

  async createDraft(channelId: string, filename: string): Promise<Video> {
    const parts = filename.split('.');
    const extension = parts.length > 1 ? parts.pop()! : 'mp4';
    const publicId = nanoid(11);

    const video = this.videoRepo.create({
      public_id: publicId,
      channel_id: channelId,
      original_filename: filename,
      original_extension: extension,
      status: VideoStatus.DRAFT,
    });

    return this.videoRepo.save(video);
  }

  async findById(id: string): Promise<Video | null> {
    return this.videoRepo.findOne({ where: { id } });
  }

  async findByPublicId(publicId: string): Promise<Video | null> {
    return this.videoRepo.findOne({
      where: { public_id: publicId },
      relations: ['channel'],
    });
  }

  async findByChannel(channelId: string): Promise<Video[]> {
    return this.videoRepo.find({
      where: { channel_id: channelId },
      order: { created_at: 'DESC' },
    });
  }

  async updateStatus(
    videoId: string,
    status: VideoStatus,
    extra?: {
      processingStep?: ProcessingStep;
      statusMessage?: string;
      incrementRetries?: boolean;
    },
  ): Promise<void> {
    const updateData: Record<string, unknown> = { status };

    if (extra?.processingStep !== undefined) {
      updateData.processing_step = extra.processingStep;
    }
    if (extra?.statusMessage !== undefined) {
      updateData.status_message = extra.statusMessage;
    }
    if (extra?.incrementRetries) {
      await this.videoRepo.increment({ id: videoId }, 'error_retries', 1);
    }

    await this.videoRepo.update(videoId, updateData);
  }

  async initiateUpload(videoId: string, uploadId: string): Promise<void> {
    await this.videoRepo.update(videoId, {
      upload_id: uploadId,
      status: VideoStatus.UPLOADING,
    });
  }

  async resetToDraft(videoId: string): Promise<void> {
    await this.videoRepo.update(videoId, {
      upload_id: null,
      status: VideoStatus.DRAFT,
    });
  }

  async enqueueProcessing(videoId: string): Promise<void> {
    await this.videoQueue.add('process-video', { videoId });
  }

  async setVideoMetadata(
    videoId: string,
    metadata: {
      duration: number;
      width: number;
      height: number;
      codec: string;
      bitrate: number;
      fileSize: number;
    },
  ): Promise<void> {
    await this.videoRepo.update(videoId, {
      duration: metadata.duration,
      resolution_width: metadata.width,
      resolution_height: metadata.height,
      codec: metadata.codec,
      bitrate: metadata.bitrate,
      file_size: metadata.fileSize,
    });
  }

  assertOwnership(video: Video, userId: string): void {
    if (video.channel?.user_id !== userId) {
      throw new VideoNotOwnedException();
    }
  }

  assertStatusTransition(video: Video, targetStatus: VideoStatus): void {
    const allowed = ALLOWED_TRANSITIONS[video.status];
    if (!allowed || !allowed.includes(targetStatus)) {
      throw new InvalidStatusTransitionException(video.status, targetStatus);
    }
  }

  async retryProcessing(videoId: string): Promise<void> {
    await this.videoRepo.update(videoId, {
      status: VideoStatus.PROCESSING,
      error_retries: 0,
      status_message: null,
    });
    await this.enqueueProcessing(videoId);
  }
}
