import { Test } from '@nestjs/testing';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import databaseConfig from '../config/database.config';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should compile with BullModule, TypeOrmModule and VideoProcessor wiring', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          load: [queueConfig, databaseConfig],
          ignoreEnvFile: true,
        }),
        TypeOrmModule.forRootAsync({
          imports: [ConfigModule.forFeature(databaseConfig)],
          inject: [databaseConfig.KEY],
          useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
            type: 'postgres',
            host: dbConfig.host || 'localhost',
            port: dbConfig.port || 5432,
            username: dbConfig.username || 'test',
            password: dbConfig.password || 'test',
            database: dbConfig.name || 'test',
            autoLoadEntities: true,
            synchronize: true,
          }),
        }),
        BullModule.forRootAsync({
          imports: [ConfigModule.forFeature(queueConfig)],
          inject: [queueConfig.KEY],
          useFactory: (cfg: {
            host: string;
            port: number;
            password: string;
          }) => ({
            connection: {
              host: cfg.host || 'localhost',
              port: cfg.port || 6379,
              password: cfg.password || undefined,
            },
          }),
        }),
        WorkerModule,
      ],
    }).compile();

    expect(module).toBeDefined();
    await module.close();
  }, 30000);
});
