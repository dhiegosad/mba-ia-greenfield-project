import { VideoStatus } from './entities/video.entity';

export const ALLOWED_TRANSITIONS: Record<VideoStatus, VideoStatus[]> = {
  [VideoStatus.DRAFT]: [VideoStatus.UPLOADING],
  [VideoStatus.UPLOADING]: [
    VideoStatus.PROCESSING,
    VideoStatus.DRAFT,
    VideoStatus.ERROR,
  ],
  [VideoStatus.PROCESSING]: [VideoStatus.READY, VideoStatus.ERROR],
  [VideoStatus.READY]: [],
  [VideoStatus.ERROR]: [VideoStatus.PROCESSING],
};
