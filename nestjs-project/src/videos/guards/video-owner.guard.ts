import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { VideosService } from '../videos.service';
import { VideoNotFoundException } from '../exceptions/video-errors';

@Injectable()
export class VideoOwnerGuard implements CanActivate {
  constructor(private readonly videosService: VideosService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      params: { publicId: string };
      user: { sub: string };
      video?: unknown;
    }>();

    const publicId = request.params.publicId;
    const video = await this.videosService.findByPublicId(publicId);

    if (!video) {
      throw new VideoNotFoundException();
    }

    this.videosService.assertOwnership(video, request.user.sub);

    request.video = video;
    return true;
  }
}
