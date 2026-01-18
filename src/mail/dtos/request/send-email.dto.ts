import { IsString, IsNotEmpty, IsOptional, IsArray } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Helper to parse JSON string arrays from FormData
 * FormData sends arrays as JSON strings, so we need to parse them
 */
const parseJsonArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [value];
    } catch {
      // If not valid JSON, treat as single value
      return value.trim() ? [value] : [];
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

  @Transform(({ value }) => (value ? parseJsonArray(value) : undefined))
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  cc?: string[];

  @Transform(({ value }) => (value ? parseJsonArray(value) : undefined))
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  bcc?: string[];
}
