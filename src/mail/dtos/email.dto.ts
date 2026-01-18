import { IsString, IsNotEmpty, IsOptional, IsArray } from 'class-validator';
import { Transform } from 'class-transformer';

// Helper to parse JSON string arrays from FormData
const parseJsonArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [value];
    } catch {
      return value ? [value] : [];
    }
  }
  return [];
};

export class SendEmailDto {
  @Transform(({ value }) => parseJsonArray(value))
  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  to: string[];

  @IsString()
  @IsNotEmpty()
  subject: string;

  @IsString()
  @IsNotEmpty()
  body: string;

  @Transform(({ value }) => parseJsonArray(value))
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  cc?: string[];

  @Transform(({ value }) => parseJsonArray(value))
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  bcc?: string[];
}

export class ReplyEmailDto {
  @IsString()
  @IsNotEmpty()
  body: string;

  @Transform(({ value }) => parseJsonArray(value))
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  cc?: string[];
}
