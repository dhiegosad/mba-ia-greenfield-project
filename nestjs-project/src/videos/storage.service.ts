import { Injectable, Inject, type OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  S3Client,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  type CompletedPart,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';

@Injectable()
export class StorageService implements OnModuleInit {
  private client: S3Client;
  private bucket: string;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.client = new S3Client({
      endpoint: `${this.config.useSSL ? 'https' : 'http'}://${this.config.endpoint}:${this.config.port}`,
      region: 'us-east-1',
      credentials: {
        accessKeyId: this.config.accessKey,
        secretAccessKey: this.config.secretKey,
      },
      forcePathStyle: true,
    });
    this.bucket = this.config.bucket;
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    } catch (error: unknown) {
      const sdkError = error as { name?: string };
      if (sdkError.name !== 'BucketAlreadyOwnedByYou') {
        throw error;
      }
    }
  }

  getVideoKey(videoId: string, extension: string): string {
    return `videos/${videoId}/original.${extension}`;
  }

  getThumbnailKey(videoId: string): string {
    return `videos/${videoId}/thumbnail.jpg`;
  }

  async createMultipartUpload(
    videoId: string,
    filename: string,
    mimeType: string,
  ): Promise<string> {
    const extension = filename.split('.').pop() || 'mp4';
    const key = this.getVideoKey(videoId, extension);

    const command = new CreateMultipartUploadCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: mimeType,
    });

    const response = await this.client.send(command);
    return response.UploadId!;
  }

  async presignUploadPart(
    videoId: string,
    extension: string,
    uploadId: string,
    partNumber: number,
    expiresIn = 3600,
  ): Promise<string> {
    const key = this.getVideoKey(videoId, extension);

    const command = new UploadPartCommand({
      Bucket: this.bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    });

    return getSignedUrl(this.client, command, { expiresIn });
  }

  async completeMultipartUpload(
    videoId: string,
    extension: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    const key = this.getVideoKey(videoId, extension);

    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }),
    );
  }

  async abortMultipartUpload(
    videoId: string,
    extension: string,
    uploadId: string,
  ): Promise<void> {
    const key = this.getVideoKey(videoId, extension);

    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async presignGetUrl(
    key: string,
    expiresIn: number,
    downloadFilename?: string,
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(downloadFilename && {
        ResponseContentDisposition: `attachment; filename="${downloadFilename}"`,
      }),
    });

    return getSignedUrl(this.client, command, { expiresIn });
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
  }
}
