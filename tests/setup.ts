import { existsSync } from 'node:fs';
import { DPS_SCHEMA, PED_REG_EVENTO_SCHEMA, isXmlLintAvailable } from '../src/core/xsd-validator';
if (!isXmlLintAvailable() || !existsSync(DPS_SCHEMA) || !existsSync(PED_REG_EVENTO_SCHEMA))
  throw new Error(
    'Testes exigem xmllint e pacote completo de schemas; nenhum teste XSD pode ser pulado',
  );
