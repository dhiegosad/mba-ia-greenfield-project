import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Repository } from 'typeorm';
import { Job } from 'bullmq';
import { execFile } from 'node:child_process';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { Video, VideoStatus, ProcessingStep } from './entities/video.entity';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { VideosService } from './videos.service';
import { StorageService } from './storage.service';
import { VideoProcessor } from './video-processor';
import { StorageModule } from './storage.module';
import storageConfig from '../config/storage.config';
import { createTestDataSource } from '../test/create-test-data-source';

const execFileAsync = promisify(execFile);

describe('VideoProcessor (integration)', () => {
  let processor: VideoProcessor;
  let videoRepo: Repository<Video>;
  let channelRepo: Repository<Channel>;
  let userRepo: Repository<User>;
  let storageService: StorageService;

  beforeAll(async () => {
    const dataSource = createTestDataSource([Video, Channel, User]);

    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          load: [storageConfig],
          ignoreEnvFile: true,
        }),
        TypeOrmModule.forRoot(dataSource.options),
        TypeOrmModule.forFeature([Video, Channel, User]),
        StorageModule,
      ],
      providers: [
        VideosService,
        VideoProcessor,
        { provide: getQueueToken('videos'), useValue: {} },
      ],
    }).compile();

    processor = module.get(VideoProcessor);
    videoRepo = module.get(getRepositoryToken(Video));
    channelRepo = module.get(getRepositoryToken(Channel));
    userRepo = module.get(getRepositoryToken(User));
    storageService = module.get(StorageService);
  });

  afterEach(async () => {
    await videoRepo.query('DELETE FROM "videos"');
    await videoRepo.query('DELETE FROM "refresh_tokens"');
    await videoRepo.query('DELETE FROM "verification_tokens"');
    await channelRepo.query('DELETE FROM "channels"');
    await userRepo.query('DELETE FROM "users"');
  });

  async function createChannelWithUser(
    email = 'proc@test.com',
  ): Promise<Channel> {
    const user = userRepo.create({ email, password: 'hash' });
    const savedUser = await userRepo.save(user);
    const channel = channelRepo.create({
      name: 'Processor Channel',
      nickname: `proc-${Date.now()}-${randomBytes(2).toString('hex')}`,
      user_id: savedUser.id,
    });
    return channelRepo.save(channel);
  }

  it('should process a video end-to-end: extract metadata and generate thumbnail', async () => {
    const channel = await createChannelWithUser();
    const publicId = `vid${Date.now()}`.slice(-11);

    const video = videoRepo.create({
      title: 'Test Video',
      public_id: publicId,
      original_filename: 'test.mp4',
      original_extension: 'mp4',
      channel_id: channel.id,
      status: VideoStatus.DRAFT,
    });
    const savedVideo = await videoRepo.save(video);

    const tempDir = tmpdir();
    const randPrefix = randomBytes(4).toString('hex');
    const tempVideoPath = join(tempDir, `${randPrefix}-test.mp4`);

    try {
      await execFileAsync('ffmpeg', [
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=1:size=320x240:rate=30',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-y',
        tempVideoPath,
      ]);

      const videoBuffer = await readFile(tempVideoPath);
      const videoKey = storageService.getVideoKey(publicId, 'mp4');
      await storageService.putObject(videoKey, videoBuffer, 'video/mp4');

      await processor.process({
        data: { videoId: savedVideo.id },
      } as Job);

      const updated = await videoRepo.findOneBy({ id: savedVideo.id });
      expect(updated!.status).toBe(VideoStatus.READY);
      expect(updated!.processing_step).toBe(ProcessingStep.THUMBNAIL);
      expect(Number(updated!.duration)).toBeGreaterThan(0);
      expect(Number(updated!.resolution_width)).toBe(320);
      expect(Number(updated!.resolution_height)).toBe(240);
      expect(updated!.codec).toBe('h264');
      expect(Number(updated!.file_size)).toBeGreaterThan(0);

      const thumbKey = storageService.getThumbnailKey(publicId);
      const thumbUrl = await storageService.presignGetUrl(thumbKey, 60);
      expect(thumbUrl).toContain('thumbnail.jpg');
    } finally {
      await unlink(tempVideoPath).catch(() => {});
    }
  }, 30000);

  it('should handle errors and increment retries', async () => {
    const channel = await createChannelWithUser('error-proc@test.com');
    const publicId = `err${Date.now()}`.slice(-11);

    const video = videoRepo.create({
      title: 'Error Video',
      public_id: publicId,
      original_filename: 'broken.mp4',
      original_extension: 'mp4',
      channel_id: channel.id,
      status: VideoStatus.DRAFT,
    });
    const savedVideo = await videoRepo.save(video);

    const tempDir = tmpdir();
    const randPrefix = randomBytes(4).toString('hex');
    const tempInputPath = join(tempDir, `${randPrefix}-input.mp4`);

    try {
      await writeFile(tempInputPath, 'this is not a video file');

      const videoKey = storageService.getVideoKey(publicId, 'mp4');
      await storageService.putObject(
        videoKey,
        Buffer.from('this is not a video file'),
        'video/mp4',
      );

      await expect(
        processor.process({ data: { videoId: savedVideo.id } } as Job),
      ).rejects.toThrow();

      const updated = await videoRepo.findOneBy({ id: savedVideo.id });
      expect(Number(updated!.error_retries)).toBeGreaterThanOrEqual(1);
      expect(updated!.status_message).toBeTruthy();
    } finally {
      await unlink(tempInputPath).catch(() => {});
    }
  }, 30000);
});
