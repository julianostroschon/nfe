import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiHeader,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { ApiKeyGuard, TenantRequest } from '../security/api-key.guard';
import {
  CreateCertificateDto,
  CreateCityConfigDto,
  UpdateCertificateDto,
  UpdateCityConfigDto,
} from './config.dto';
import { CertificateResponse, CityConfigResponse } from './config.response';
import { ConfigsService } from './configs.service';

@ApiTags('Certificados')
@ApiSecurity('apiKey')
@ApiHeader({ name: 'X-Emitter-Cnpj', required: true })
@UseGuards(ApiKeyGuard)
@Controller('certificates')
export class CertificatesController {
  constructor(private readonly service: ConfigsService) {}
  @Post()
  @ApiCreatedResponse({ type: CertificateResponse })
  @ApiOperation({ summary: 'Cadastrar A1 e substituir o certificado ativo' })
  create(@Req() r: TenantRequest, @Body() dto: CreateCertificateDto) {
    return this.service.createCertificate(r.emitterCnpj, dto);
  }
  @Get()
  @ApiOkResponse({ type: [CertificateResponse] })
  @ApiOperation({ summary: 'Listar metadados de certificados' })
  list(@Req() r: TenantRequest) {
    return this.service.listCertificates(r.emitterCnpj);
  }
  @Get(':id')
  @ApiOkResponse({ type: CertificateResponse })
  @ApiOperation({ summary: 'Consultar metadados de um certificado' })
  find(@Req() r: TenantRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.certificate(r.emitterCnpj, id);
  }
  @Patch(':id')
  @ApiOkResponse({ type: CertificateResponse })
  @ApiOperation({ summary: 'Revogar uso do certificado; renovação usa POST' })
  update(
    @Req() r: TenantRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() _dto: UpdateCertificateDto,
  ) {
    return this.service.revokeCertificate(r.emitterCnpj, id);
  }
  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revogar material e preservar referência fiscal' })
  async remove(@Req() r: TenantRequest, @Param('id', ParseUUIDPipe) id: string) {
    await this.service.revokeCertificate(r.emitterCnpj, id);
  }
}
@ApiTags('Configurações municipais')
@ApiSecurity('apiKey')
@ApiHeader({ name: 'X-Emitter-Cnpj', required: true })
@UseGuards(ApiKeyGuard)
@Controller('city-configs')
export class CityConfigsController {
  constructor(private readonly service: ConfigsService) {}
  @Post()
  @ApiCreatedResponse({ type: CityConfigResponse })
  @ApiOperation({ summary: 'Cadastrar município e ambiente' })
  create(@Req() r: TenantRequest, @Body() dto: CreateCityConfigDto) {
    return this.service.createConfig(r.emitterCnpj, dto);
  }
  @Get()
  @ApiOkResponse({ type: [CityConfigResponse] })
  @ApiOperation({ summary: 'Listar configurações do emitente' })
  list(@Req() r: TenantRequest) {
    return this.service.listConfigs(r.emitterCnpj);
  }
  @Get(':id')
  @ApiOkResponse({ type: CityConfigResponse })
  @ApiOperation({ summary: 'Consultar configuração' })
  find(@Req() r: TenantRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.config(r.emitterCnpj, id);
  }
  @Patch(':id')
  @ApiOkResponse({ type: CityConfigResponse })
  @ApiOperation({ summary: 'Atualizar configuração e destino do webhook' })
  update(
    @Req() r: TenantRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCityConfigDto,
  ) {
    return this.service.updateConfig(r.emitterCnpj, id, dto);
  }
  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Excluir configuração; pedidos preservam o snapshot' })
  remove(@Req() r: TenantRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.deleteConfig(r.emitterCnpj, id);
  }
}
