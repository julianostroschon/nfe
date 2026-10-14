# Validação da entrega

Validado em 13/10/2026–14/10/2026, com Node 22.23, pnpm 9.14, MySQL 8.4 e Redis 7.4.

| Verificação | Resultado |
| --- | --- |
| Schema Prisma | `pnpm prisma:validate` passou. |
| TypeScript | `pnpm typecheck` passou. |
| Núcleo técnico e proteção de contratos | 120 testes passaram em sete suítes; nenhum teste pulado. |
| Integração real local | Cinco E2E passaram com MySQL/Redis, simulador mTLS e receptor HTTP. |
| Compilação | `pnpm build` passou. |
| Formatação | `pnpm format:check` passou; schema Prisma não foi formatado. |
| Isolamento | Busca exigida sem ocorrências nos artefatos próprios; nenhum import legado absoluto. |
| Migration inicial | Aplicada em banco MySQL novo; seis tabelas fiscais, FKs somente internas. Checksum confere com o arquivo entregue. |
| Idempotência | Repetição concorrente retorna o mesmo pedido; conteúdo diferente retorna 409; comparação binária distingue maiúsculas/minúsculas. |
| Docker | Imagem construída; API iniciou sem privilégios; `/health`, OpenAPI e autenticação retornaram 200. |
| Certificado sintético | Script executado; material gerado somente em diretório local ignorado. |

Os cinco E2E cobrem emissão, consulta ao fisco, cancelamento, resposta perdida depois do efeito fiscal, HMAC/reentrega, isolamento de emitentes, numeração concorrente, intenção persistida durante pausa do worker, rejeição confirmada e comparação binária de chaves.

O fluxo reutiliza os bytes da DPS/evento persistidos. Consultas inconclusivas não autorizam retransmissão nem viram rejeição fiscal. O XML autorizado permanece após cancelamento. Estado, evento e intenção de webhook são gravados na mesma transação; o destinatário precisa deduplicar pelo identificador de evento.

A revisão final conferiu as adaptações do núcleo, os novos arquivos, a superfície pública dos DTOs, o isolamento por CNPJ, as constraints e as retentativas. A entrega está pronta para revisão e transporte a outro repositório. O versionamento registra a entrega em commits semânticos.

A validação externa com o Emissor Nacional real não foi executada. Limites do leiaute implementado e responsabilidades do chamador estão no README.
