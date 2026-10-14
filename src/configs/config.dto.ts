import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Environment } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class CreateCityConfigDto {
  @ApiProperty() @IsInt() @Min(1000000) @Max(9999999) cityCode: number;
  @ApiProperty({ enum: Environment }) @IsEnum(Environment) environment: Environment;
  @ApiProperty() @IsBoolean() enabled: boolean;
  @ApiProperty({ description: 'Formato ilustrativo: ' + '1' })
  @Matches(/^[1-9]\d{0,4}$/)
  series: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(65535) cancellationWindowDays?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'], require_protocol: true })
  @Length(1, 2048)
  webhookUrl?: string;
  @ApiPropertyOptional({ writeOnly: true })
  @IsOptional()
  @IsString()
  @Length(32, 256)
  webhookSecret?: string;
}
export class UpdateCityConfigDto extends PartialType(CreateCityConfigDto) {}
export class CreateCertificateDto {
  @ApiProperty({ description: 'Arquivo PKCS#12 em base64; limite de 1 MB', writeOnly: true })
  @IsString()
  @Length(4, 1398104)
  @Matches(/^[A-Za-z0-9+/]+={0,2}$/)
  pfxBase64: string;
  @ApiProperty({ writeOnly: true }) @IsString() @Length(1, 256) password: string;
}
export class UpdateCertificateDto {
  @ApiProperty({ enum: ['REVOKED'] }) @IsEnum(['REVOKED']) status: 'REVOKED';
}
