import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageModule', () => {
  it('should compile with ConfigModule.forFeature and StorageService', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          load: [storageConfig],
          ignoreEnvFile: true,
        }),
        StorageModule,
      ],
    }).compile();

    expect(module).toBeDefined();
    expect(module.get(StorageService)).toBeDefined();
  });
});
