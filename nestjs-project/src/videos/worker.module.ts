import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import queueConfig from '../config/queue.config';
import databaseConfig from '../config/database.config';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { VideosModule } from './videos.module';
import { VideoProcessor } from './video-processor';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      load: [queueConfig, databaseConfig, storageConfig],
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule.forFeature(databaseConfig)],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule.forFeature(queueConfig)],
      inject: [queueConfig.KEY],
      useFactory: (qConfig: ConfigType<typeof queueConfig>) => ({
        connection: {
          host: qConfig.host,
          port: qConfig.port,
          password: qConfig.password || undefined,
        },
      }),
    }),
    StorageModule,
    UsersModule,
    VideosModule,
  ],
  providers: [VideoProcessor],
})
export class WorkerModule {}
