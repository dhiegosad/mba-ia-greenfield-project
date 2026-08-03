import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Video } from '../entities/video.entity';

export const VideoParam = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Video => {
    const request = ctx.switchToHttp().getRequest<{ video: Video }>();
    return request.video;
  },
);
