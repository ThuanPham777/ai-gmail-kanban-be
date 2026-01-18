import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsArray,
  IsBoolean,
} from 'class-validator';
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

/**
 * Helper to parse boolean from FormData string
 */
const parseBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return undefined;
};

export class ReplyEmailDto {
  @IsString()
  @IsNotEmpty()
  body: string;

  @Transform(({ value }) => (value ? parseJsonArray(value) : undefined))
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  cc?: string[];

  @Transform(({ value }) => parseBoolean(value))
  @IsOptional()
  @IsBoolean()
  replyAll?: boolean;
}
