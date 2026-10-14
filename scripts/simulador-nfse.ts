import { startNfseSimulator } from '../src/core/nfse-national.simulator';
function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const port = Number(option('--porta') ?? 8443);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Porta inválida');
void startNfseSimulator({
  port,
  listenHost: option('--host'),
  reject: option('--rejeitar')?.split(','),
})
  .then((handle) => {
    const stop = async () => {
      await handle.close();
      process.exitCode = 0;
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  })
  .catch(() => {
    console.error('Não foi possível iniciar o simulador');
    process.exitCode = 1;
  });
