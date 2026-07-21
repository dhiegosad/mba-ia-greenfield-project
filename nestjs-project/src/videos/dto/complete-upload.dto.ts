import { Type } from 'class-transformer';
import {
  IsArray,
  ArrayMinSize,
  ValidateNested,
  IsInt,
  IsString,
  IsNotEmpty,
  Min,
} from 'class-validator';

class UploadPart {
  @IsInt()
  @Min(1)
  PartNumber: number;

  @IsString()
  @IsNotEmpty()
  ETag: string;
}

export class CompleteUploadDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => UploadPart)
  parts: UploadPart[];
}
