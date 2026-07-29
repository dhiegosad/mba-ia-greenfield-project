import storageConfig from './storage.config';

describe('storageConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should resolve with default values when no env vars are set', () => {
    delete process.env.STORAGE_ENDPOINT;
    delete process.env.STORAGE_PORT;
    delete process.env.STORAGE_ACCESS_KEY;
    delete process.env.STORAGE_SECRET_KEY;
    delete process.env.STORAGE_BUCKET;
    delete process.env.STORAGE_USE_SSL;

    const config = storageConfig();

    expect(config.endpoint).toBe('minio');
    expect(config.port).toBe(9000);
    expect(config.accessKey).toBe('minioadmin');
    expect(config.secretKey).toBe('minioadmin');
    expect(config.bucket).toBe('streamtube');
    expect(config.useSSL).toBe(false);
  });

  it('should resolve with overridden values from env vars', () => {
    process.env.STORAGE_ENDPOINT = 's3.example.com';
    process.env.STORAGE_PORT = '443';
    process.env.STORAGE_ACCESS_KEY = 'my-key';
    process.env.STORAGE_SECRET_KEY = 'my-secret';
    process.env.STORAGE_BUCKET = 'my-bucket';
    process.env.STORAGE_USE_SSL = 'true';

    const config = storageConfig();

    expect(config.endpoint).toBe('s3.example.com');
    expect(config.port).toBe(443);
    expect(config.accessKey).toBe('my-key');
    expect(config.secretKey).toBe('my-secret');
    expect(config.bucket).toBe('my-bucket');
    expect(config.useSSL).toBe(true);
  });
});
