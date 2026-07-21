import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT || 'minio',
  port: parseInt(process.env.STORAGE_PORT || '9000', 10),
  accessKey: process.env.STORAGE_ACCESS_KEY || 'minioadmin',
  secretKey: process.env.STORAGE_SECRET_KEY || 'minioadmin',
  bucket: process.env.STORAGE_BUCKET || 'streamtube',
  useSSL: process.env.STORAGE_USE_SSL === 'true',
}));
