# Serviço NFS-e Nacional

Serviço independente para emitir, consultar e cancelar NFS-e pelo Emissor Nacional. Stack: NestJS 11, Prisma 7, MySQL 8.4, Bull 4/Redis 7 e pnpm. Requer Node 22.12+ e `xmllint` (libxml2-utils no Debian/Ubuntu). Não há dependência de outro repositório.

## Rodar localmente

Execute na raiz desta pasta:

```sh
pnpm install --frozen-lockfile
pnpm prisma:generate
pnpm ambiente-teste
docker compose -p nfse-extraction up -d --wait mysql redis
pnpm db:deploy
pnpm verify
pnpm start
```

`ambiente-teste` gera `.env` com segredos aleatórios de desenvolvimento e `tmp/acesso-teste.json` com a API key sintética. Não sobrescreve `.env` existente. Os dois ficam fora do versionamento. Se as portas estiverem ocupadas, ajuste `MYSQL_PORT`, `REDIS_PORT`, `DATABASE_URL` e `REDIS_URL` em conjunto; `PORT` controla a API local.

Em outro terminal, inicie o simulador:

```sh
pnpm simulador-nfse --porta 8443
```

Configure `NFSE_BASE_URL_OVERRIDE=127.0.0.1:8443` no `.env` e reinicie a API. O override só funciona em homologação. Para gerar material sintético:

```sh
pnpm gerar-certificados-teste 12345678000195
```

O arquivo gerado é `tmp/certificados-teste/valido.pfx`, com senha **de teste** `teste123`. É autoassinado e não tem valor fiscal. O script e as fixtures nunca precisam de certificados reais.

O cenário ponta a ponta automatizado cadastra certificado/configuração, envia pedidos HTTP, executa o processamento real com MySQL/Redis, assina DPS/evento, chama o simulador por mTLS e verifica webhook HMAC. Simula falha da resposta após autorização/cancelamento e recusa da primeira entrega de webhook. Também verifica numeração concorrente, idempotência e isolamento entre CNPJs:

```sh
pnpm test:e2e
```

Os testes criam dados fiscais sintéticos. Use banco dedicado ao desenvolvimento. O teste substitui somente a configuração de homologação do CNPJ sintético indicado; preserva notas anteriores.

## Docker

A imagem executa migrations e inicia a API com usuário sem privilégios:

```sh
docker compose -p nfse-extraction --profile app up -d --build
```

Para incluir o simulador no mesmo ambiente:

```sh
NFSE_BASE_URL_OVERRIDE=simulator:8443 docker compose -p nfse-extraction --profile app --profile simulator up -d --build
```

A API é publicada no `PORT` configurado, MySQL/Redis apenas em loopback. O compose usa senhas do `.env`; use valores alfanuméricos para a senha MySQL que compõe a URL. Redis não é publicado em interface externa. Os volumes persistem dados ao executar `docker compose -p nfse-extraction down`.

`pnpm isolamento:validate` verifica a ausência de acoplamento por termos nos artefatos próprios (exclui dependências, compilados e arquivos locais de teste). `pnpm prisma:validate` valida o schema. A migration inicial usa somente MySQL. Não execute comandos de formatação do Prisma. A imagem contém o CLI Prisma para aplicar migrations e as ferramentas XML; prioriza reprodução do fluxo neste primeiro serviço extraído.

## Ambiente

| Variável | Uso |
| --- | --- |
| `PORT` | Porta HTTP local; padrão 3000. No container a porta interna é sempre 3000. |
| `DATABASE_URL` | URL MySQL exclusiva do serviço. |
| `REDIS_URL` | Redis usado pelo Bull; padrão local 6379 se omitido. |
| `QUEUE_PREFIX` | Namespace Redis opcional; padrão derivado do nome do banco fiscal. Instâncias do mesmo banco devem compartilhar o prefixo. |
| `MYSQL_PASSWORD` / `MYSQL_ROOT_PASSWORD` | Inicialização do MySQL no compose. |
| `MYSQL_PORT` / `REDIS_PORT` | Portas locais do compose; padrões 3307 e 6380. |
| `CREDENTIALS_ENCRYPTION_KEY` | Chave AES de 32 bytes, base64 ou hexadecimal; obrigatória. |
| `API_KEY_HASHES_JSON` | Lista de hashes SHA-256 de API keys e CNPJs autorizados; obrigatória. |
| `NFSE_ENVIRONMENT` | Ambiente operacional do processo, opcional; valida o uso de override. Cada pedido/configuração declara seu ambiente explicitamente. |
| `NFSE_BASE_URL_OVERRIDE` | Host:porta do simulador; recusado para pedidos de produção. |
| `NFSE_SCHEMA_DIR` | Diretório absoluto dos XSDs; padrão `schemas/v1.01` relativo ao diretório de execução. |
| `NODE_ENV` | `test` silencia o logger Nest nos testes. |

O arquivo de referência de ambiente incluído não contém segredos utilizáveis. Configure a chave de cifragem antes de cadastrar certificados e preserve-a: outra chave não abre o material já armazenado. PFX, senha e segredo de webhook são cifrados com AES-256-GCM, nonce aleatório e tag autenticada. Nenhum desses valores sai na API.

Formato de autorização:

```json
[{"sha256":"HASH_SHA256_HEXADECIMAL_DA_CHAVE","cnpjs":["12345678000195"]}]
```

Cada requisição autenticada usa `X-API-Key` e `X-Emitter-Cnpj`. O contexto selecionado deve estar autorizado na chave; o CNPJ no pedido deve coincidir. Certificados, configurações, pedidos e tarefas são consultados nesse contexto. Não existe cadastro de pessoas operadoras ou perfis.

## API REST

Swagger está em `/docs`, JSON em `/docs-json`; `pnpm swagger:generate` produz `openapi.json`, incluindo contratos de entrada e saída. `/health` é público e retorna 200 somente se MySQL e Redis responderem; caso contrário, 503.

| Método e caminho | Resultado |
| --- | --- |
| `POST /invoices` | 202: pedido persistido e intenção de emissão registrada. |
| `GET /invoices/:id` | Snapshot fiscal, estado, XML autorizado, eventos e tarefas. |
| `GET /invoices/:id?refresh=true` | Acrescenta `national`, consultando DPS, XML e cancelamento no fisco. Não altera o histórico local. Consulta inconclusiva retorna 503. |
| `POST /invoices/:id/cancel` | 202: evento de cancelamento agendado. |
| `POST /invoices/:id/retry` | 202: retoma tarefas esgotadas, preservando a DPS e os bytes do webhook. |
| `POST /certificates` | 201: recebe PKCS#12 em base64 e senha, confere CNPJ/validade/chave e substitui certificado ativo. |
| `GET /certificates` e `GET /certificates/:id` | Metadados públicos do certificado. |
| `PATCH /certificates/:id` | Revoga uso com `{"status":"REVOKED"}`. Renovação usa POST. |
| `DELETE /certificates/:id` | 204: revoga uso; mantém material cifrado e referências fiscais históricas. |
| `POST /city-configs` | 201: configuração por CNPJ do contexto, município emissor e ambiente. |
| `GET /city-configs` e `GET /city-configs/:id` | Configurações sem segredo de webhook. |
| `PATCH /city-configs/:id` | Atualização parcial. |
| `DELETE /city-configs/:id` | 204: exclusão da configuração; snapshots dos pedidos permanecem. |

Campos desconhecidos e valores nulos são recusados com 400. Omita campos opcionais. A API aceita JSON, até 2 MB; certificado decodificado até 1 MB. Identificadores de rotas são UUIDs locais ao serviço. Recurso de outro emitente retorna 404. Falhas de autenticação retornam 401/403; conflitos retornam 409.

Antes da emissão, cadastre um certificado e esta configuração:

```json
{
  "cityCode": 4314902,
  "environment": "HOMOLOGATION",
  "enabled": true,
  "series": "1",
  "webhookUrl": "http://127.0.0.1:9000/events",
  "webhookSecret": "SEGREDO_GERADO_COM_PELO_MENOS_32_CARACTERES"
}
```

`cancellationWindowDays` é opcional; sem ele o serviço não inventa prazo e o fisco avalia a regra municipal. Webhook é opcional; quando configurado, URL e segredo são obrigatórios juntos. Produção exige HTTPS. Alterações posteriores de destino não mudam pedidos já aceitos: URL e segredo são copiados para o snapshot do pedido.

O cadastro do certificado recebe `{"pfxBase64":"CONTEUDO_BASE64","password":"SENHA"}`. Rotação preserva o certificado que assinou notas anteriores; revogação impede seu uso em novas conexões. O pedido já assinado pode ser consultado, mas reenvio depende de material ainda válido e não revogado.

Pedido genérico de emissão:

```json
{
  "externalId": "identificador-opaco-123",
  "environment": "HOMOLOGATION",
  "issuer": {
    "cnpj": "12345678000195",
    "name": "Empresa Sintética LTDA",
    "cityCode": 4314902,
    "municipalRegistration": "123456",
    "simplesNacional": "1",
    "specialTaxRegime": "0"
  },
  "taker": {"cnpj": "98765432000198", "name": "Tomador Sintético LTDA"},
  "serviceCityCode": 4314902,
  "competency": "2026-10-01",
  "service": {
    "lc116Code": "01.01",
    "nationalServiceCode": "010101",
    "municipalTaxCode": "001",
    "description": "Serviço técnico genérico",
    "issqnTaxation": "1",
    "issRate": "2.00",
    "issWithheld": false
  },
  "values": {
    "amount": "1500.00",
    "totalFederalTaxPercent": "1.25",
    "totalStateTaxPercent": "0.00",
    "totalMunicipalTaxPercent": "2.00"
  }
}
```

Inclua `Idempotency-Key` com 1–200 caracteres ASCII sem espaços. A chave é única por CNPJ + ambiente e diferencia maiúsculas de minúsculas (comparação binária no MySQL). A mesma chave/conteúdo devolve o mesmo pedido; conteúdo diferente retorna 409. O hash usa JSON com chaves ordenadas recursivamente, preservando valores. Não se normalizam valores monetários: use sempre duas casas decimais.

Um pedido representa uma nota e um serviço já resolvido pelo chamador. `externalId` é armazenado e devolvido sem interpretação. Códigos LC 116/nacional devem ser compatíveis; desdobro nacional não é inferido. `municipalTaxCode`, quando enviado, tem três dígitos conforme o XSD. Valores e percentuais são strings decimais; valor precisa ser positivo e alíquota entre 0 e 5%. Competência é data civil válida `AAAA-MM-DD`.

Regime do Simples: `1` não optante, `2` MEI, `3` ME/EPP. Para `3`, informe também `simplesNacionalRegime` (`1`, `2` ou `3`). Regime especial aceita `0`–`6` e `9`. Tributação ISSQN aceita `1` tributável, `2` imunidade, `3` exportação, `4` não incidência. Essas declarações vêm do chamador; o serviço valida formato e coerência do leiaute.

Para não optante do Simples, a DPS não serializa `pAliq`; a alíquota declarada permanece no snapshot e a parametrização do município define a do fisco. Os percentuais totais aproximados são recebidos explicitamente e serializados para não optante. Para optantes, o núcleo usa o indicador previsto no leiaute em vez desses percentuais.

Cancelamento recebe `{"reasonCode":"1","reason":"Dados fiscais incorretos no pedido original"}` e `Idempotency-Key`. Códigos: `1` erro de emissão, `2` serviço não prestado, `9` outros. Justificativa: 15–255 caracteres após normalização compatível com XSD. A mesma chave não agenda outro evento; reutilização com outro conteúdo retorna 409. Rejeição confirmada permite uma nova solicitação corrigida com nova chave. Resultado incerto permanece pendente para reconciliação.

## Fluxo técnico e estados

1. Validar autenticação, contexto, contrato, certificado e configuração habilitada.
2. Reservar número por CNPJ/ambiente/série, montar e assinar DPS, validar XSD e persistir pedido + tarefa em uma transação MySQL. Falha desfaz também a reserva. A numeração não é em memória.
3. Publicador consulta intenções persistidas a cada segundo e envia jobs ao Redis. Workers usam reserva com prazo e identificador de posse para evitar processamento concorrente do mesmo registro.
4. Consultar DPS antes de transmitir. Se já autorizada, recuperar a mesma NFS-e; caso contrário enviar os mesmos bytes assinados em GZip/base64 via `node:https` com `pfx` e senha para mTLS.
5. Gravar estado + evento + intenção de webhook atomicamente. O XML autorizado é preservado quando o cancelamento ocorre.
6. Cancelamento monta/assina/valida pedido de evento e consulta o evento `101101`, sequencial `1`, antes de transmitir novamente.

Estados da nota: `PENDING`, `AUTHORIZED`, `REJECTED`, `CANCELED`. `cancellationStatus` é separado: `PENDING`, `CONFIRMED`, `REJECTED` ou nulo. Indisponibilidade não vira rejeição fiscal. Tarefas têm estados `PENDING`, `PROCESSING`, `DONE`, `FAILED`, seis tentativas e backoff exponencial (limitado a cinco minutos). Resultado técnico esgotado mantém a nota pendente ou autorizada conforme a operação; `/retry` retoma tarefas esgotadas. A reserva de processamento dura cinco minutos e pode ser retomada após queda do worker.

TLS oficial valida a cadeia do servidor. Só o override de homologação aceita o certificado autoassinado do simulador. O certificado A1 continua sendo apresentado no handshake. Os XSDs completos v1.01 estão em `schemas/v1.01`; o validador remove apenas o erro conhecido do facet de série (`^`/`$` literais no esquema), com testes específicos. Outros erros bloqueiam transmissão. Temporários XML são removidos após validação.

## Webhook HMAC

Eventos: `invoice.authorized`, `invoice.rejected`, `invoice.canceled`, `invoice.cancellation_rejected`, `invoice.transmission_failed`, `invoice.cancellation_failed`. Payload contém apenas identificadores fiscais locais, identificador externo opaco, CNPJ, ambiente e resultado:

```json
{
  "eventId": "UUID_DO_EVENTO",
  "type": "invoice.authorized",
  "occurredAt": "2026-10-14T01:00:00.000Z",
  "invoiceId": "UUID_DO_PEDIDO_FISCAL",
  "externalId": "identificador-opaco-123",
  "emitterCnpj": "12345678000195",
  "environment": "HOMOLOGATION",
  "status": "AUTHORIZED",
  "cancellationStatus": null,
  "dpsId": "IDENTIFICADOR_FISCAL_DA_DPS",
  "accessKey": "CHAVE_FISCAL",
  "result": {"code": null, "message": null}
}
```

Cabeçalhos: `X-Webhook-Event-Id`, `X-Webhook-Timestamp` (segundos Unix), `X-Webhook-Signature` (`sha256=` + hexadecimal). Assinatura: `HMAC-SHA256(segredo, timestamp + "." + corpo_bruto)`. Valide com comparação em tempo constante, janela temporal (por exemplo, cinco minutos) e deduplicação por `eventId`. Não reserialize JSON antes de validar. Só 2xx confirma recebimento; timeout, erro de rede ou outro status causam retentativa. Redirecionamentos são recusados. A entrega é pelo menos uma vez; falha após recebimento pode gerar duplicata com o mesmo `eventId`.

## Limites e responsabilidades do chamador

O contrato suporta o subconjunto técnico do núcleo original: emitente e tomador com CNPJ, um serviço por DPS, valor bruto, ISS e cancelamento direto. Não inclui tomador CPF, endereço, intermediário, deduções/descontos, exportação detalhada, IBS/CBS, emissão judicial ou outros eventos. Declarar uma variante que demande campos fora desse subconjunto pode ser recusado pelo fisco; esses campos não são aceitos silenciosamente pela API.

Não há classificação automática, particionamento de valores, gatilhos de emissão, catálogos tributários com CRUD, dados demonstrativos de organizações reais ou autenticação de sistemas externos. Para integrar, o chamador resolve os dados fiscais, decide o momento, separa notas por serviço, monta o pedido autossuficiente, escolhe chave estável e identificador opaco, consome/deduplica webhooks e consulta/reconcilia resultados. Esse adaptador não faz parte deste repositório.

A validação aqui é local com certificados sintéticos. Credenciamento e homologação com o Emissor Nacional real exigem certificado ICP-Brasil e revisão fiscal dos dados declarados. Referências oficiais: [documentação atual](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/documentacao-atual) e [manual das APIs](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/manual-municipios-emissor-publico-api-sistema-nacional-nfs-e-v1-2-out21025.pdf/@@download/file).
