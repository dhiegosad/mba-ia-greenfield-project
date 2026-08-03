import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { VideosService } from './videos.service';
import { StorageService } from './storage.service';
import { VideoStatus, ProcessingStep } from './entities/video.entity';

const execFileAsync = promisify(execFile);

interface FfprobeOutput {
  format: {
    duration: string;
    size: string;
    bit_rate?: string;
  };
  streams: Array<{
    codec_type: string;
    codec_name: string;
    width?: number;
    height?: number;
    bit_rate?: string;
  }>;
}

@Processor('videos')
export class VideoProcessor extends WorkerHost {
  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
  ) {
    super();
  }

  async process(job: Job<{ videoId: string }>): Promise<void> {
    const { videoId } = job.data;
    let tempInputPath: string | null = null;
    let tempThumbnailPath: string | null = null;

    try {
      const video = await this.videosService.findById(videoId);
      if (!video) {
        throw new Error(`Video ${videoId} not found`);
      }

      await this.videosService.updateStatus(video.id, VideoStatus.PROCESSING, {
        processingStep: ProcessingStep.METADATA,
      });

      const videoKey = this.storageService.getVideoKey(
        video.public_id,
        video.original_extension,
      );
      const downloadUrl = await this.storageService.presignGetUrl(
        videoKey,
        3600,
      );
      const response = await fetch(downloadUrl);
      if (!response.ok) {
        throw new Error(
          `Failed to download video: ${response.status} ${response.statusText}`,
        );
      }
      const videoBuffer = Buffer.from(await response.arrayBuffer());

      const tempDir = tmpdir();
      const randPrefix = randomBytes(8).toString('hex');
      tempInputPath = join(
        tempDir,
        `${randPrefix}-input.${video.original_extension}`,
      );
      await writeFile(tempInputPath, videoBuffer);

      const { stdout: ffprobeOut } = await execFileAsync('ffprobe', [
        '-v',
        'quiet',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        tempInputPath,
      ]);

      const probe = JSON.parse(ffprobeOut) as FfprobeOutput;
      const videoStream = probe.streams.find((s) => s.codec_type === 'video');
      if (!videoStream) {
        throw new Error('No video stream found');
      }

      const duration = Math.round(parseFloat(probe.format.duration));
      const width = videoStream.width ?? 0;
      const height = videoStream.height ?? 0;
      const codec = videoStream.codec_name;
      const bitrate = parseInt(
        videoStream.bit_rate || probe.format.bit_rate || '0',
        10,
      );
      const fileSize = parseInt(probe.format.size, 10);

      await this.videosService.setVideoMetadata(video.id, {
        duration,
        width,
        height,
        codec,
        bitrate,
        fileSize,
      });

      await this.videosService.updateStatus(video.id, VideoStatus.PROCESSING, {
        processingStep: ProcessingStep.THUMBNAIL,
      });

      const thumbnailOffset = Math.min(10, Math.floor(duration * 0.3));
      tempThumbnailPath = join(tempDir, `${randPrefix}-thumbnail.jpg`);

      await execFileAsync('ffmpeg', [
        '-y',
        '-i',
        tempInputPath,
        '-ss',
        `00:00:${String(thumbnailOffset).padStart(2, '0')}`,
        '-vframes',
        '1',
        '-q:v',
        '2',
        tempThumbnailPath,
      ]);

      const thumbnailBuffer = await readFile(tempThumbnailPath);
      const thumbnailKey = this.storageService.getThumbnailKey(video.public_id);
      await this.storageService.putObject(
        thumbnailKey,
        thumbnailBuffer,
        'image/jpeg',
      );

      await this.videosService.updateStatus(video.id, VideoStatus.READY);
    } catch (error) {
      await this.handleError(videoId, error);
      throw error;
    } finally {
      if (tempInputPath) {
        await unlink(tempInputPath).catch(() => {});
      }
      if (tempThumbnailPath) {
        await unlink(tempThumbnailPath).catch(() => {});
      }
    }
  }

  private async handleError(videoId: string, error: unknown): Promise<void> {
    const video = await this.videosService.findById(videoId);
    if (!video) return;

    const errorRetries = Number(video.error_retries) + 1;
    const message = error instanceof Error ? error.message : String(error);

    if (errorRetries >= 3) {
      await this.videosService.updateStatus(video.id, VideoStatus.ERROR, {
        statusMessage: message,
        incrementRetries: true,
      });
      return;
    }

    await this.videosService.updateStatus(video.id, VideoStatus.PROCESSING, {
      statusMessage: message,
      incrementRetries: true,
    });
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<{ videoId: string }>, error: Error): void {
    void error;
    void job;
  }
}
