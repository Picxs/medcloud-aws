// [TRABALHO 2 - RABBITMQ + MINIO] Worker Desacoplado em Container.
// Este processo roda em background consumindo a fila do RabbitMQ, lendo a imagem bruta do MinIO,
// gerando preview e thumbnail otimizados com Sharp, salvando de volta no MinIO e atualizando Postgres + DynamoDB.
const amqp = require('amqplib');
const sharp = require('sharp');
const path = require('path');
const cfg = require('./config');
const { pool, cache, storage, audit } = require('./aws');

async function processExame({ exameId, key }) {
  const original = await storage.get(key);
  const img = sharp(original, { failOn: 'none' });
  const meta = await img.metadata();
  const base = key.replace(path.extname(key), '');

  // [PROCESSAMENTO] Redimensionamento e compressão WebP
  const preview = await sharp(original)
    .rotate()
    .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
  const thumb = await sharp(original)
    .rotate()
    .resize(256, 256, { fit: 'cover' })
    .normalise()
    .webp({ quality: 70 })
    .toBuffer();

  const previewKey = `${base}-preview.webp`;
  const thumbKey = `${base}-thumb.webp`;

  // Salva no MinIO as imagens já otimizadas
  await storage.put(previewKey, preview, 'image/webp');
  await storage.put(thumbKey, thumb, 'image/webp');

  const q = await pool.query(
    `UPDATE exames SET status='PRONTO', arquivo_preview=$1, arquivo_thumb=$2, largura_original=$3,
       altura_original=$4, tamanho_preview=$5, processado_em=now() WHERE id=$6 RETURNING *`,
    [previewKey, thumbKey, meta.width, meta.height, preview.length, exameId]
  );
  await cache.invalidate('exames:*', 'dashboard');
  await audit.log(
    'PROCESS',
    'exame',
    {
      id: exameId,
      original: `${meta.width}x${meta.height} (${original.length} B)`,
      preview: `${preview.length} B`,
      reducao: `${(100 - (preview.length / original.length) * 100).toFixed(1)}%`,
    },
    { origem: 'worker-rabbitmq' }
  );
  return q.rows[0];
}

async function startWorker() {
  await storage.init().catch((e) => console.warn('[worker/minio]', e.message));
  await audit.init().catch((e) => console.warn('[worker/dynamodb]', e.message));

  for (;;) {
    try {
      console.log(`[worker] conectando ao RabbitMQ (${cfg.rabbitUrl}) fila "${cfg.rabbitQueue}"...`);
      const conn = await amqp.connect(cfg.rabbitUrl);
      const ch = await conn.createChannel();
      await ch.assertQueue(cfg.rabbitQueue, { durable: true });
      await ch.prefetch(1);

      console.log(`[worker] aguardando mensagens na fila "${cfg.rabbitQueue}"`);

      await new Promise((resolve, reject) => {
        conn.on('close', () => reject(new Error('Conexão com RabbitMQ fechada')));
        conn.on('error', reject);

        ch.consume(cfg.rabbitQueue, async (m) => {
          if (!m) return;
          let msg = {};
          try {
            msg = JSON.parse(m.content.toString());
            if (msg.type === 'EXAME_UPLOADED') {
              await processExame(msg);
              console.log(`[worker] exame #${msg.exameId} processado com sucesso via RabbitMQ + MinIO`);
            }
            ch.ack(m);
          } catch (e) {
            console.error('[worker] falha ao processar exame', msg.exameId, e.message);
            if (msg.exameId) {
              await pool.query(`UPDATE exames SET status='ERRO' WHERE id=$1`, [msg.exameId]).catch(() => {});
            }
            // Remove da fila para não entrar em loop infinito se o arquivo estiver corrompido
            ch.nack(m, false, false);
          }
        });
      });
    } catch (e) {
      console.error('[worker] erro/reconectando em 5s:', e.message);
      await new Promise((s) => setTimeout(s, 5000));
    }
  }
}

startWorker();
