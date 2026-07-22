import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { Repository } from 'typeorm';
import { Video, VideoStatus, ProcessingStep } from './entities/video.entity';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { VideosService } from './videos.service';
import { StorageService } from './storage.service';
import { createTestDataSource } from '../test/create-test-data-source';

describe('VideosService (integration)', () => {
  let service: VideosService;
  let videoRepo: Repository<Video>;
  let channelRepo: Repository<Channel>;
  let userRepo: Repository<User>;

  beforeAll(async () => {
    const dataSource = createTestDataSource([Video, Channel, User]);

    const module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(dataSource.options),
        TypeOrmModule.forFeature([Video, Channel, User]),
      ],
      providers: [
        VideosService,
        { provide: StorageService, useValue: {} },
        { provide: getQueueToken('videos'), useValue: {} },
      ],
    }).compile();

    service = module.get(VideosService);
    videoRepo = module.get(getRepositoryToken(Video));
    channelRepo = module.get(getRepositoryToken(Channel));
    userRepo = module.get(getRepositoryToken(User));
  });

  afterEach(async () => {
    await videoRepo.query('DELETE FROM "videos"');
    await videoRepo.query('DELETE FROM "refresh_tokens"');
    await videoRepo.query('DELETE FROM "verification_tokens"');
    await channelRepo.query('DELETE FROM "channels"');
    await userRepo.query('DELETE FROM "users"');
  });

  describe('createDraft', () => {
    it('should persist a draft video with unique public_id', async () => {
      const channel = await createChannelWithUser(channelRepo, userRepo);

      const video = await service.createDraft(channel.id, 'my-video.mp4');

      expect(video.id).toBeDefined();
      expect(video.public_id).toHaveLength(11);
      expect(video.status).toBe(VideoStatus.DRAFT);
      expect(video.original_filename).toBe('my-video.mp4');
      expect(video.original_extension).toBe('mp4');
      expect(video.channel_id).toBe(channel.id);

      const found = await videoRepo.findOne({
        where: { public_id: video.public_id },
      });
      expect(found).toBeDefined();
    });

    it('should generate unique public_ids for different videos', async () => {
      const channel1 = await createChannelWithUser(
        channelRepo,
        userRepo,
        'user1@test.com',
      );

      const v1 = await service.createDraft(channel1.id, 'a.mp4');
      const v2 = await service.createDraft(channel1.id, 'b.mp4');

      expect(v1.public_id).not.toBe(v2.public_id);
    });
  });

  describe('findByPublicId', () => {
    it('should return video with channel relation', async () => {
      const channel = await createChannelWithUser(channelRepo, userRepo);
      const video = await service.createDraft(channel.id, 'test.mp4');

      const found = await service.findByPublicId(video.public_id);

      expect(found).toBeDefined();
      expect(found!.channel).toBeDefined();
      expect(found!.channel.id).toBe(channel.id);
      expect(found!.channel.name).toBe(channel.name);
    });

    it('should return null for non-existent public_id', async () => {
      const found = await service.findByPublicId('nonexistent');
      expect(found).toBeNull();
    });
  });

  describe('findByChannel', () => {
    it('should return videos for a specific channel ordered by newest first', async () => {
      const channel = await createChannelWithUser(channelRepo, userRepo);

      const v1 = await service.createDraft(channel.id, 'first.mp4');
      const v2 = await service.createDraft(channel.id, 'second.mp4');

      const videos = await service.findByChannel(channel.id);

      expect(videos).toHaveLength(2);
      expect(videos[0].id).toBe(v2.id);
      expect(videos[1].id).toBe(v1.id);
    });

    it('should return empty array for channel with no videos', async () => {
      const channel = await createChannelWithUser(channelRepo, userRepo);
      const videos = await service.findByChannel(channel.id);
      expect(videos).toEqual([]);
    });
  });

  describe('updateStatus', () => {
    it('should update status and extra fields atomically', async () => {
      const channel = await createChannelWithUser(channelRepo, userRepo);
      const video = await service.createDraft(channel.id, 'test.mp4');

      await service.updateStatus(video.id, VideoStatus.PROCESSING, {
        processingStep: ProcessingStep.METADATA,
        statusMessage: 'Working on it',
      });

      const updated = await videoRepo.findOneBy({ id: video.id });
      expect(updated!.status).toBe(VideoStatus.PROCESSING);
      expect(updated!.processing_step).toBe(ProcessingStep.METADATA);
      expect(updated!.status_message).toBe('Working on it');
    });

    it('should increment retries', async () => {
      const channel = await createChannelWithUser(channelRepo, userRepo);
      const video = await service.createDraft(channel.id, 'test.mp4');

      await service.updateStatus(video.id, VideoStatus.ERROR, {
        incrementRetries: true,
      });

      const updated = await videoRepo.findOneBy({ id: video.id });
      expect(updated!.status).toBe(VideoStatus.ERROR);
      expect(Number(updated!.error_retries)).toBe(1);
    });
  });

  describe('setVideoMetadata', () => {
    it('should persist all processing metadata', async () => {
      const channel = await createChannelWithUser(channelRepo, userRepo);
      const video = await service.createDraft(channel.id, 'test.mp4');

      await service.setVideoMetadata(video.id, {
        duration: 180,
        width: 1280,
        height: 720,
        codec: 'h264',
        bitrate: 3000,
        fileSize: 5000000,
      });

      const updated = await videoRepo.findOneBy({ id: video.id });
      expect(Number(updated!.duration)).toBe(180);
      expect(Number(updated!.resolution_width)).toBe(1280);
      expect(Number(updated!.resolution_height)).toBe(720);
      expect(updated!.codec).toBe('h264');
      expect(Number(updated!.bitrate)).toBe(3000);
      expect(Number(updated!.file_size)).toBe(5000000);
    });
  });
});

async function createChannelWithUser(
  channelRepo: Repository<Channel>,
  userRepo: Repository<User>,
  email = 'test@streamtube.local',
): Promise<Channel> {
  const user = userRepo.create({
    email,
    password: 'hash',
  });
  const savedUser = await userRepo.save(user);

  const channel = channelRepo.create({
    name: 'Test Channel',
    nickname: `ch-${Date.now()}`,
    user_id: savedUser.id,
  });
  return channelRepo.save(channel);
}
