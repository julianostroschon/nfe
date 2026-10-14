import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Environment } from '@prisma/client';

export class IssuerDto {
  @ApiProperty() @Matches(/^\d{14}$/) cnpj: string;
  @ApiProperty() @IsString() @Length(1, 250) name: string;
  @ApiProperty() @IsInt() @Min(1000000) @Max(9999999) cityCode: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 15) municipalRegistration?: string;
  @ApiProperty({ enum: ['1', '2', '3'] }) @IsEnum(['1', '2', '3']) simplesNacional: '1' | '2' | '3';
  @ApiPropertyOptional({ enum: ['1', '2', '3'] })
  @IsOptional()
  @IsEnum(['1', '2', '3'])
  simplesNacionalRegime?: string;
  @ApiProperty({ enum: ['0', '1', '2', '3', '4', '5', '6', '9'] })
  @IsEnum(['0', '1', '2', '3', '4', '5', '6', '9'])
  specialTaxRegime: string;
}
export class TakerDto {
  @ApiProperty() @Matches(/^\d{14}$/) cnpj: string;
  @ApiProperty() @IsString() @Length(1, 150) name: string;
}
export class ServiceDto {
  @ApiProperty({ description: 'Formato ilustrativo: ' + '01.01' })
  @Matches(/^\d{2}\.\d{2}$/)
  lc116Code: string;
  @ApiProperty({ description: 'Formato ilustrativo: ' + '010101' })
  @Matches(/^\d{6}$/)
  nationalServiceCode: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\d{3}$/) municipalTaxCode?: string;
  @ApiProperty() @IsString() @Length(1, 2000) description: string;
  @ApiProperty({ enum: ['1', '2', '3', '4'] }) @IsEnum(['1', '2', '3', '4']) issqnTaxation:
    | '1'
    | '2'
    | '3'
    | '4';
  @ApiProperty({ description: 'Formato ilustrativo: ' + '2.00' })
  @Matches(/^[0-5]\.\d{2}$/)
  issRate: string;
  @ApiProperty() @IsBoolean() issWithheld: boolean;
}
export class ValuesDto {
  @ApiProperty({ description: 'Formato ilustrativo: ' + '1500.00' })
  @Matches(/^(0|[1-9]\d{0,12})\.\d{2}$/)
  amount: string;
  @ApiProperty({ description: 'Formato ilustrativo: ' + '0.00' })
  @Matches(/^(0|[1-9]\d{0,1}|100)\.\d{2}$/)
  totalFederalTaxPercent: string;
  @ApiProperty({ description: 'Formato ilustrativo: ' + '0.00' })
  @Matches(/^(0|[1-9]\d{0,1}|100)\.\d{2}$/)
  totalStateTaxPercent: string;
  @ApiProperty({ description: 'Formato ilustrativo: ' + '0.00' })
  @Matches(/^(0|[1-9]\d{0,1}|100)\.\d{2}$/)
  totalMunicipalTaxPercent: string;
}
export class CreateInvoiceDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(200) externalId: string;
  @ApiProperty({ enum: Environment }) @IsEnum(Environment) environment: Environment;
  @ApiProperty({ type: IssuerDto })
  @IsObject()
  @ValidateNested()
  @Type(() => IssuerDto)
  issuer: IssuerDto;
  @ApiProperty({ type: TakerDto })
  @IsObject()
  @ValidateNested()
  @Type(() => TakerDto)
  taker: TakerDto;
  @ApiProperty() @IsInt() @Min(1000000) @Max(9999999) serviceCityCode: number;
  @ApiProperty({ description: 'Formato ilustrativo: ' + '2026-10-01' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsISO8601({ strict: true })
  competency: string;
  @ApiProperty({ type: ServiceDto })
  @IsObject()
  @ValidateNested()
  @Type(() => ServiceDto)
  service: ServiceDto;
  @ApiProperty({ type: ValuesDto })
  @IsObject()
  @ValidateNested()
  @Type(() => ValuesDto)
  values: ValuesDto;
}
export class CancelInvoiceDto {
  @ApiProperty({ enum: ['1', '2', '9'] }) @IsEnum(['1', '2', '9']) reasonCode: '1' | '2' | '9';
  @ApiProperty() @IsString() @Length(15, 255) reason: string;
}
