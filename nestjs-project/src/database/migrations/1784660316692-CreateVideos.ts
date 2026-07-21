import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1784660316692 implements MigrationInterface {
  name = 'CreateVideos1784660316692';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."videos_status_enum" AS ENUM('draft', 'uploading', 'processing', 'ready', 'error')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."videos_processing_step_enum" AS ENUM('metadata', 'thumbnail')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "title" character varying(255) NOT NULL DEFAULT 'Untitled', "public_id" character varying(11) NOT NULL, "status" "public"."videos_status_enum" NOT NULL DEFAULT 'draft', "processing_step" "public"."videos_processing_step_enum", "status_message" text, "error_retries" integer NOT NULL DEFAULT '0', "original_filename" character varying(255) NOT NULL, "original_extension" character varying(10) NOT NULL, "file_size" bigint, "duration" integer, "resolution_width" integer, "resolution_height" integer, "codec" character varying(50), "bitrate" integer, "upload_id" character varying(255), "channel_id" uuid NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_39a1f0fe7991162aace659078ec" UNIQUE ("public_id"), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc"`,
    );
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(`DROP TYPE "public"."videos_processing_step_enum"`);
    await queryRunner.query(`DROP TYPE "public"."videos_status_enum"`);
  }
}
