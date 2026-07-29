import queueConfig from './queue.config';

describe('queueConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should resolve with default values when no env vars are set', () => {
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_PORT;
    delete process.env.REDIS_PASSWORD;

    const config = queueConfig();

    expect(config.host).toBe('redis');
    expect(config.port).toBe(6379);
    expect(config.password).toBe('');
  });

  it('should resolve with overridden values from env vars', () => {
    process.env.REDIS_HOST = 'my-redis.example.com';
    process.env.REDIS_PORT = '6380';
    process.env.REDIS_PASSWORD = 'secret';

    const config = queueConfig();

    expect(config.host).toBe('my-redis.example.com');
    expect(config.port).toBe(6380);
    expect(config.password).toBe('secret');
  });
});
