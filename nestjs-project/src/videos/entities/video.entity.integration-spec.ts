import { DataSource } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Channel } from '../../channels/entities/channel.entity';
import { createTestDataSource } from '../../test/create-test-data-source';
import { Video, VideoStatus, ProcessingStep } from './video.entity';

const ALL_ENTITIES = [User, Channel, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES, { synchronize: true });
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource.dropDatabase();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.synchronize(true);
  });

  it('should persist a video with all required fields and default values', async () => {
    const userRepo = dataSource.getRepository(User);
    const channelRepo = dataSource.getRepository(Channel);
    const videoRepo = dataSource.getRepository(Video);

    const user = await userRepo.save(
      userRepo.create({
        email: 'test@example.com',
        password: 'hash',
      }),
    );

    const channel = await channelRepo.save(
      channelRepo.create({
        name: 'Test Channel',
        nickname: 'testchannel',
        user_id: user.id,
      }),
    );

    const video = await videoRepo.save(
      videoRepo.create({
        public_id: 'abc123def45',
        original_filename: 'my-video.mp4',
        original_extension: 'mp4',
        channel_id: channel.id,
      }),
    );

    expect(video.id).toBeDefined();
    expect(video.title).toBe('Untitled');
    expect(video.public_id).toBe('abc123def45');
    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(video.processing_step).toBeNull();
    expect(video.status_message).toBeNull();
    expect(video.error_retries).toBe(0);
    expect(video.file_size).toBeNull();
    expect(video.duration).toBeNull();
    expect(video.channel_id).toBe(channel.id);
    expect(video.created_at).toBeInstanceOf(Date);
    expect(video.updated_at).toBeInstanceOf(Date);
  });

  it('should enforce unique public_id constraint', async () => {
    const userRepo = dataSource.getRepository(User);
    const channelRepo = dataSource.getRepository(Channel);
    const videoRepo = dataSource.getRepository(Video);

    const user = await userRepo.save(
      userRepo.create({
        email: 'test2@example.com',
        password: 'hash',
      }),
    );

    const channel = await channelRepo.save(
      channelRepo.create({
        name: 'Test Channel 2',
        nickname: 'testchannel2',
        user_id: user.id,
      }),
    );

    await videoRepo.save(
      videoRepo.create({
        public_id: 'unique12345',
        original_filename: 'video1.mp4',
        original_extension: 'mp4',
        channel_id: channel.id,
      }),
    );

    await expect(
      videoRepo.save(
        videoRepo.create({
          public_id: 'unique12345',
          original_filename: 'video2.mp4',
          original_extension: 'mp4',
          channel_id: channel.id,
        }),
      ),
    ).rejects.toThrow();
  });

  it('should persist processing metadata fields', async () => {
    const userRepo = dataSource.getRepository(User);
    const channelRepo = dataSource.getRepository(Channel);
    const videoRepo = dataSource.getRepository(Video);

    const user = await userRepo.save(
      userRepo.create({
        email: 'test4@example.com',
        password: 'hash',
      }),
    );

    const channel = await channelRepo.save(
      channelRepo.create({
        name: 'Test Channel 4',
        nickname: 'testchannel4',
        user_id: user.id,
      }),
    );

    const video = await videoRepo.save(
      videoRepo.create({
        public_id: 'meta1234567',
        original_filename: 'hd-video.mp4',
        original_extension: 'mp4',
        channel_id: channel.id,
        status: VideoStatus.READY,
        processing_step: ProcessingStep.THUMBNAIL,
        file_size: 1024000,
        duration: 120,
        resolution_width: 1920,
        resolution_height: 1080,
        codec: 'h264',
        bitrate: 5000000,
      }),
    );

    const found = await videoRepo.findOneBy({ id: video.id });
    expect(Number(found?.file_size)).toBe(1024000);
    expect(found?.duration).toBe(120);
    expect(found?.resolution_width).toBe(1920);
    expect(found?.resolution_height).toBe(1080);
    expect(found?.codec).toBe('h264');
    expect(found?.bitrate).toBe(5000000);
    expect(found?.processing_step).toBe(ProcessingStep.THUMBNAIL);
  });

  it('should link video to channel via channel_id FK', async () => {
    const userRepo = dataSource.getRepository(User);
    const channelRepo = dataSource.getRepository(Channel);
    const videoRepo = dataSource.getRepository(Video);

    const user = await userRepo.save(
      userRepo.create({
        email: 'test5@example.com',
        password: 'hash',
      }),
    );

    const channel = await channelRepo.save(
      channelRepo.create({
        name: 'FK Test',
        nickname: 'fktest2',
        user_id: user.id,
      }),
    );

    const video = await videoRepo.save(
      videoRepo.create({
        public_id: 'fktest2234',
        original_filename: 'video.mp4',
        original_extension: 'mp4',
        channel_id: channel.id,
      }),
    );

    const found = await videoRepo.findOne({
      where: { id: video.id },
      relations: ['channel'],
    });

    expect(found?.channel).toBeDefined();
    expect(found?.channel.id).toBe(channel.id);
    expect(found?.channel.name).toBe('FK Test');
  });
});
