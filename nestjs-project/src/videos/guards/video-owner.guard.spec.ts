import { Test } from '@nestjs/testing';
import { type ExecutionContext } from '@nestjs/common';
import { VideoOwnerGuard } from './video-owner.guard';
import { VideosService } from '../videos.service';
import {
  VideoNotFoundException,
  VideoNotOwnedException,
} from '../exceptions/video-errors';
import { Video } from '../entities/video.entity';

describe('VideoOwnerGuard', () => {
  let guard: VideoOwnerGuard;
  let videosService: jest.Mocked<
    Pick<VideosService, 'findByPublicId' | 'assertOwnership'>
  >;

  const mockVideosService = {
    findByPublicId: jest.fn(),
    assertOwnership: jest.fn(),
  };

  const mockVideo = {
    id: 'v-uuid',
    public_id: 'abc123',
    channel: { user_id: 'user-1' },
  } as unknown as Video;

  function createContext(
    paramsPublicId: string,
    userSub: string,
  ): ExecutionContext {
    const request = {
      params: { publicId: paramsPublicId },
      user: { sub: userSub },
    };
    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    const module = await Test.createTestingModule({
      providers: [
        VideoOwnerGuard,
        { provide: VideosService, useValue: mockVideosService },
      ],
    }).compile();

    guard = module.get(VideoOwnerGuard);
    videosService = module.get(VideosService);
  });

  it('should allow the owner of the video', async () => {
    mockVideosService.findByPublicId.mockResolvedValue(mockVideo);

    const ctx = createContext('abc123', 'user-1');
    const result = await guard.canActivate(ctx);

    expect(result).toBe(true);
    expect(mockVideosService.findByPublicId).toHaveBeenCalledWith('abc123');
    expect(mockVideosService.assertOwnership).toHaveBeenCalledWith(
      mockVideo,
      'user-1',
    );
  });

  it('should throw VideoNotFoundException when video does not exist', async () => {
    mockVideosService.findByPublicId.mockResolvedValue(null);

    const ctx = createContext('nonexistent', 'user-1');

    await expect(guard.canActivate(ctx)).rejects.toThrow(
      VideoNotFoundException,
    );
  });

  it('should throw VideoNotOwnedException when user does not own the video', async () => {
    mockVideosService.findByPublicId.mockResolvedValue(mockVideo);
    mockVideosService.assertOwnership.mockImplementationOnce(() => {
      throw new VideoNotOwnedException();
    });

    const ctx = createContext('abc123', 'user-2');

    await expect(guard.canActivate(ctx)).rejects.toThrow(
      VideoNotOwnedException,
    );
  });

  it('should attach the video to the request', async () => {
    mockVideosService.findByPublicId.mockResolvedValue(mockVideo);

    const ctx = createContext('abc123', 'user-1');
    const request = ctx.switchToHttp().getRequest<{ video?: unknown }>();

    await guard.canActivate(ctx);

    expect(request.video).toBe(mockVideo);
  });
});
