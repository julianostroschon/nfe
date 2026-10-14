import { ApiProperty } from '@nestjs/swagger';
import { CertificateStatus, Environment } from '@prisma/client';
export class CertificateResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() cnpj: string;
  @ApiProperty() subjectName: string;
  @ApiProperty() fingerprint: string;
  @ApiProperty({ format: 'date-time' }) validFrom: string;
  @ApiProperty({ format: 'date-time' }) validUntil: string;
  @ApiProperty({ enum: CertificateStatus }) status: CertificateStatus;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
  @ApiProperty({ format: 'date-time' }) updatedAt: string;
}
export class CityConfigResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() cnpj: string;
  @ApiProperty() cityCode: number;
  @ApiProperty({ enum: Environment }) environment: Environment;
  @ApiProperty() enabled: boolean;
  @ApiProperty() series: string;
  @ApiProperty({ type: Number, nullable: true }) cancellationWindowDays: number | null;
  @ApiProperty({ type: String, nullable: true }) webhookUrl: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
  @ApiProperty({ format: 'date-time' }) updatedAt: string;
}
