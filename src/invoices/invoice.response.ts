import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Environment, InvoiceStatus, TaskKind, TaskStatus } from '@prisma/client';
import { CreateInvoiceDto } from './invoice.dto';

export class FiscalEventResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() type: string;
  @ApiProperty({ type: String, nullable: true }) code: string | null;
  @ApiProperty({ type: String, nullable: true }) message: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}
export class FiscalTaskResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: TaskKind }) kind: TaskKind;
  @ApiProperty({ enum: TaskStatus }) status: TaskStatus;
  @ApiProperty() attempts: number;
  @ApiProperty({ type: String, nullable: true }) lastError: string | null;
}
export class NationalLookupResponse {
  @ApiProperty() exists: boolean;
  @ApiPropertyOptional() accessKey?: string;
  @ApiPropertyOptional() authorizedXml?: string;
  @ApiPropertyOptional() canceled?: boolean;
  @ApiPropertyOptional({ type: String, nullable: true }) cancellationEventXml?: string | null;
}
export class InvoiceResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() cnpj: string;
  @ApiProperty({ enum: Environment }) environment: Environment;
  @ApiProperty() externalId: string;
  @ApiProperty({ enum: InvoiceStatus }) status: InvoiceStatus;
  @ApiProperty({ type: CreateInvoiceDto }) request: CreateInvoiceDto;
  @ApiProperty() dpsId: string;
  @ApiProperty() series: string;
  @ApiProperty() number: number;
  @ApiProperty({ type: String, nullable: true }) accessKey: string | null;
  @ApiProperty({ type: String, nullable: true }) authorizedXml: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) authorizedAt: string | null;
  @ApiProperty({ type: String, nullable: true, enum: ['PENDING', 'CONFIRMED', 'REJECTED'] })
  cancellationStatus: string | null;
  @ApiProperty({ type: String, nullable: true }) cancellationEventXml: string | null;
  @ApiProperty({ type: String, nullable: true }) lastError: string | null;
  @ApiProperty() attemptCount: number;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
  @ApiProperty({ format: 'date-time' }) updatedAt: string;
  @ApiProperty({ type: [FiscalEventResponse] }) events: FiscalEventResponse[];
  @ApiProperty({ type: [FiscalTaskResponse] }) tasks: FiscalTaskResponse[];
  @ApiPropertyOptional({ type: NationalLookupResponse }) national?: NationalLookupResponse;
}
