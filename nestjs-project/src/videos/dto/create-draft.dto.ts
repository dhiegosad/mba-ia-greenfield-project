import { IsString, IsNotEmpty } from 'class-validator';

export class CreateDraftDto {
  @IsString()
  @IsNotEmpty()
  filename: string;
}
