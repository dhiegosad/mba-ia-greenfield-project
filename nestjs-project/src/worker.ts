import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './videos/worker.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  await app.init();
}

bootstrap();
