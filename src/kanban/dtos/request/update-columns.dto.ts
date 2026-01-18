import {
  IsArray,
  ValidateNested,
  IsString,
  IsNumber,
  IsOptional,
  Allow,
} from 'class-validator';
import { Type, Exclude } from 'class-transformer';

class KanbanColumnDto {
  // Allow _id from MongoDB documents (will be ignored, not stored)
  @Allow()
  @Exclude()
  _id?: any;

  @IsString()
  id: string;

  @IsString()
  name: string;

  @IsNumber()
  order: number;

  @IsOptional()
  @IsString()
  gmailLabel?: string;

  @IsOptional()
  @IsString()
  color?: string;
}

export class UpdateColumnsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => KanbanColumnDto)
  columns: KanbanColumnDto[];
}
