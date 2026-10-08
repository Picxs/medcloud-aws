// Worker desacoplado: consome a fila SQS (assinada no tópico SNS) e faz o rescaling das imagens de exame.
const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
const sharp = require('sharp');
const path = require('path');
const cfg = require('./config');
const { pool, cache, storage, audit } = require('./aws');

const sqs = new SQSClient({ region: cfg.region });

async function processExame({ exameId, key }) {
  const original = await storage.get(key);
  const img = sharp(original, { failOn: 'none' });
  const meta = await img.metadata();
  const base = key.replace(path.extname(key), '');

  // Preview para visualização rápida (máx 1280px, WebP) + thumbnail 256px com realce de contraste.
  const preview = await sharp(original).rotate().resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 }).toBuffer();
  const thumb = await sharp(original).rotate().resize(256, 256, { fit: 'cover' }).normalise().webp({ quality: 70 }).toBuffer();

  const previewKey = `${base}-preview.webp`;
  const thumbKey = `${base}-thumb.webp`;
  await storage.put(previewKey, preview, 'image/webp');
  await storage.put(thumbKey, thumb, 'image/webp');

  const q = await pool.query(
    `UPDATE exames SET status='PRONTO', arquivo_preview=$1, arquivo_thumb=$2, largura_original=$3,
       altura_original=$4, tamanho_preview=$5, processado_em=now() WHERE id=$6 RETURNING *`,
    [previewKey, thumbKey, meta.width, meta.height, preview.length, exameId]);
  await cache.invalidate('exames:*', 'dashboard');
  await audit.log('PROCESS', 'exame', {
    id: exameId, original: `${meta.width}x${meta.height} (${original.length} B)`,
    preview: `${preview.length} B`, reducao: `${(100 - (preview.length / original.length) * 100).toFixed(1)}%`,
  }, { origem: 'worker' });
  return q.rows[0];
}

async function loop() {
  console.log('[worker] escutando', cfg.sqsQueueUrl);
  for (;;) {
    try {
      const r = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: cfg.sqsQueueUrl, MaxNumberOfMessages: 5, WaitTimeSeconds: 20, VisibilityTimeout: 120,
      }));
      for (const m of r.Messages || []) {
        const envelope = JSON.parse(m.Body);
        const msg = JSON.parse(envelope.Message || m.Body); // SNS embrulha a mensagem
        try {
          if (msg.type === 'EXAME_UPLOADED') {
            await processExame(msg);
            console.log('[worker] exame', msg.exameId, 'processado');
          }
          await sqs.send(new DeleteMessageCommand({ QueueUrl: cfg.sqsQueueUrl, ReceiptHandle: m.ReceiptHandle }));
        } catch (e) {
          console.error('[worker] falha exame', msg.exameId, e.message);
          await pool.query(`UPDATE exames SET status='ERRO' WHERE id=$1`, [msg.exameId]).catch(() => {});
        }
      }
    } catch (e) {
      console.error('[worker]', e.message);
      await new Promise((s) => setTimeout(s, 5000));
    }
  }
}
loop();
