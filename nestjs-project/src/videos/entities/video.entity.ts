import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';

export enum VideoStatus {
  DRAFT = 'draft',
  UPLOADING = 'uploading',
  PROCESSING = 'processing',
  READY = 'ready',
  ERROR = 'error',
}

export enum ProcessingStep {
  METADATA = 'metadata',
  THUMBNAIL = 'thumbnail',
}

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255, default: 'Untitled' })
  title: string;

  @Column({ type: 'varchar', length: 11, unique: true })
  public_id: string;

  @Column({ type: 'enum', enum: VideoStatus, default: VideoStatus.DRAFT })
  status: VideoStatus;

  @Column({ type: 'enum', enum: ProcessingStep, nullable: true })
  processing_step: ProcessingStep | null;

  @Column({ type: 'text', nullable: true })
  status_message: string | null;

  @Column({ type: 'integer', default: 0 })
  error_retries: number;

  @Column({ type: 'varchar', length: 255 })
  original_filename: string;

  @Column({ type: 'varchar', length: 10 })
  original_extension: string;

  @Column({ type: 'bigint', nullable: true })
  file_size: number | null;

  @Column({ type: 'integer', nullable: true })
  duration: number | null;

  @Column({ type: 'integer', nullable: true })
  resolution_width: number | null;

  @Column({ type: 'integer', nullable: true })
  resolution_height: number | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  codec: string | null;

  @Column({ type: 'integer', nullable: true })
  bitrate: number | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  upload_id: string | null;

  @Column({ type: 'uuid' })
  channel_id: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel)
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
