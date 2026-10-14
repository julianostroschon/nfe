import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiOkResponse,
  ApiHeader,
  ApiOperation,
  ApiQuery,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { ApiKeyGuard, TenantRequest } from '../security/api-key.guard';
import { CancelInvoiceDto, CreateInvoiceDto } from './invoice.dto';
import { InvoiceResponse } from './invoice.response';
import { InvoicesService } from './invoices.service';

@ApiTags('Notas fiscais')
@ApiSecurity('apiKey')
@ApiHeader({ name: 'X-Emitter-Cnpj', required: true })
@UseGuards(ApiKeyGuard)
@Controller('invoices')
export class InvoicesController {
  constructor(private readonly service: InvoicesService) {}
  @Post()
  @HttpCode(202)
  @ApiAcceptedResponse({
    description: 'Pedido persistido; resultado entregue por webhook',
    type: InvoiceResponse,
  })
  @ApiOperation({ summary: 'Solicitar emissão de NFS-e' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  create(
    @Req() req: TenantRequest,
    @Body() body: CreateInvoiceDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.service.create(req.emitterCnpj, body, key);
  }
  @Get(':id')
  @ApiOkResponse({ type: InvoiceResponse })
  @ApiOperation({ summary: 'Consultar pedido, documento fiscal, eventos e processamento' })
  @ApiQuery({
    name: 'refresh',
    required: false,
    enum: ['true', 'false'],
    description:
      'true consulta também a NFS-e e o evento no Emissor Nacional, sem alterar o snapshot local',
  })
  find(
    @Req() req: TenantRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('refresh') refresh?: string,
  ) {
    return refresh === 'true'
      ? this.service.consultNational(req.emitterCnpj, id)
      : this.service.find(req.emitterCnpj, id);
  }
  @Post(':id/cancel')
  @HttpCode(202)
  @ApiAcceptedResponse({ type: InvoiceResponse })
  @ApiOperation({ summary: 'Solicitar evento de cancelamento' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  cancel(
    @Req() req: TenantRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CancelInvoiceDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.service.cancel(req.emitterCnpj, id, body, key);
  }
  @Post(':id/retry')
  @HttpCode(202)
  @ApiAcceptedResponse({ type: InvoiceResponse })
  @ApiOperation({ summary: 'Retomar tarefas que esgotaram tentativas, preservando a DPS' })
  retry(@Req() req: TenantRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.retry(req.emitterCnpj, id);
  }
}
