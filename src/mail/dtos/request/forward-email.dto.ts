import { IsArray, IsOptional, IsString, IsNotEmpty } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Helper to parse JSON string arrays from FormData
 */
const parseJsonArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [value];
    } catch {
      return value.trim() ? [value] : [];
    }
  }
  return [];
};

export class ForwardEmailDto {
  @Transform(({ value }) => parseJsonArray(value))
  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  to: string[];

  @IsOptional()
  @IsString()
  subject?: string;

  @IsOptional()
  @IsString()
  body?: string;

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
