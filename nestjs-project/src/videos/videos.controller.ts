import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  NotFoundException,
  ConflictException,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { VideosService } from './videos.service';
import { StorageService } from './storage.service';
import { CreateDraftDto } from './dto/create-draft.dto';
import { UploadPartsDto } from './dto/upload-parts.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoOwnerGuard } from './guards/video-owner.guard';
import { VideoParam } from './decorators/video.decorator';
import {
  VideoNotFoundException,
  VideoNotReadyException,
  InvalidStatusTransitionException,
} from './exceptions/video-errors';

@Controller('videos')
export class VideosController {
  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
    @InjectRepository(Channel)
    private readonly channelRepo: Repository<Channel>,
  ) {}

  @Get('channel/mine')
  async findMyVideos(@CurrentUser() user: JwtPayload): Promise<{
    videos: Pick<
      Video,
      'id' | 'public_id' | 'title' | 'status' | 'duration' | 'created_at'
    >[];
  }> {
    const channel = await this.channelRepo.findOne({
      where: { user_id: user.sub },
    });
    if (!channel) {
      throw new NotFoundException('Channel not found for current user');
    }

    const videos = await this.videosService.findByChannel(channel.id);

    return {
      videos: videos.map((v) => ({
        id: v.id,
        public_id: v.public_id,
        title: v.title,
        status: v.status,
        duration: v.duration,
        created_at: v.created_at,
      })),
    };
  }

  @Public()
  @Get(':publicId')
  async findByPublicId(@Param('publicId') publicId: string): Promise<{
    id: string;
    title: string;
    public_id: string;
    status: string;
    duration: number | null;
    resolution_width: number | null;
    resolution_height: number | null;
    channel: { id: string; name: string; nickname: string } | null;
    created_at: Date;
  }> {
    const video = await this.videosService.findByPublicId(publicId);
    if (!video) {
      throw new VideoNotFoundException();
    }

    return {
      id: video.id,
      title: video.title,
      public_id: video.public_id,
      status: video.status,
      duration: video.duration,
      resolution_width: video.resolution_width,
      resolution_height: video.resolution_height,
      channel: video.channel
        ? {
            id: video.channel.id,
            name: video.channel.name,
            nickname: video.channel.nickname,
          }
        : null,
      created_at: video.created_at,
    };
  }

  @Post('drafts')
  @HttpCode(HttpStatus.CREATED)
  async createDraft(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateDraftDto,
  ): Promise<{ id: string; public_id: string; status: string }> {
    const channel = await this.channelRepo.findOne({
      where: { user_id: user.sub },
    });
    if (!channel) {
      throw new NotFoundException('Channel not found for current user');
    }

    const video = await this.videosService.createDraft(
      channel.id,
      dto.filename,
    );

    return {
      id: video.id,
      public_id: video.public_id,
      status: video.status,
    };
  }

  @UseGuards(VideoOwnerGuard)
  @Post(':publicId/uploads/initiate')
  async initiateUpload(
    @VideoParam() video: Video,
  ): Promise<{ upload_id: string; max_parts: number; min_part_size: number }> {
    this.videosService.assertStatusTransition(video, VideoStatus.UPLOADING);

    const uploadId = await this.storageService.createMultipartUpload(
      video.public_id,
      video.original_filename,
      `video/${video.original_extension}`,
    );

    await this.videosService.initiateUpload(video.id, uploadId);

    return {
      upload_id: uploadId,
      max_parts: 10000,
      min_part_size: 5 * 1024 * 1024,
    };
  }

  @UseGuards(VideoOwnerGuard)
  @Post(':publicId/uploads/parts')
  async presignUploadParts(
    @VideoParam() video: Video,
    @Body() dto: UploadPartsDto,
  ): Promise<{ parts: { part_number: number; upload_url: string }[] }> {
    if (video.status !== VideoStatus.UPLOADING) {
      throw new InvalidStatusTransitionException(
        video.status,
        VideoStatus.UPLOADING,
      );
    }

    if (!video.upload_id) {
      throw new ConflictException('Upload has not been initiated yet');
    }

    const parts = await Promise.all(
      dto.part_numbers.map(async (partNumber) => {
        const uploadUrl = await this.storageService.presignUploadPart(
          video.public_id,
          video.original_extension,
          video.upload_id!,
          partNumber,
        );
        return { part_number: partNumber, upload_url: uploadUrl };
      }),
    );

    return { parts };
  }

  @UseGuards(VideoOwnerGuard)
  @Post(':publicId/uploads/complete')
  async completeUpload(
    @VideoParam() video: Video,
    @Body() dto: CompleteUploadDto,
  ): Promise<{ status: string }> {
    if (video.status !== VideoStatus.UPLOADING) {
      throw new InvalidStatusTransitionException(
        video.status,
        VideoStatus.PROCESSING,
      );
    }

    if (!video.upload_id) {
      throw new ConflictException('Upload has not been initiated yet');
    }

    await this.storageService.completeMultipartUpload(
      video.public_id,
      video.original_extension,
      video.upload_id,
      dto.parts,
    );

    await this.videosService.updateStatus(video.id, VideoStatus.PROCESSING);
    await this.videosService.enqueueProcessing(video.id);

    return { status: VideoStatus.PROCESSING };
  }

  @Public()
  @Get(':publicId/stream')
  async getStreamUrl(
    @Param('publicId') publicId: string,
  ): Promise<{ url: string; expires_in: number }> {
    const video = await this.videosService.findByPublicId(publicId);
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }

    const key = this.storageService.getVideoKey(
      video.public_id,
      video.original_extension,
    );
    const url = await this.storageService.presignGetUrl(key, 21600);

    return { url, expires_in: 21600 };
  }

  @Public()
  @Get(':publicId/download')
  async getDownloadUrl(
    @Param('publicId') publicId: string,
  ): Promise<{ url: string; expires_in: number; filename: string }> {
    const video = await this.videosService.findByPublicId(publicId);
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }

    const key = this.storageService.getVideoKey(
      video.public_id,
      video.original_extension,
    );
    const url = await this.storageService.presignGetUrl(
      key,
      300,
      video.original_filename,
    );

    return { url, expires_in: 300, filename: video.original_filename };
  }

  @UseGuards(VideoOwnerGuard)
  @Post(':publicId/retry')
  async retryProcessing(
    @VideoParam() video: Video,
  ): Promise<{ status: string }> {
    if (video.status !== VideoStatus.ERROR) {
      throw new InvalidStatusTransitionException(
        video.status,
        VideoStatus.PROCESSING,
      );
    }

    await this.videosService.retryProcessing(video.id);

    return { status: VideoStatus.PROCESSING };
  }

  @UseGuards(VideoOwnerGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post(':publicId/uploads/abort')
  async abortUpload(@VideoParam() video: Video): Promise<void> {
    if (video.status !== VideoStatus.UPLOADING) {
      throw new InvalidStatusTransitionException(
        video.status,
        VideoStatus.DRAFT,
      );
    }

    if (video.upload_id) {
      await this.storageService.abortMultipartUpload(
        video.public_id,
        video.original_extension,
        video.upload_id,
      );
    }

    await this.videosService.resetToDraft(video.id);
  }
}
