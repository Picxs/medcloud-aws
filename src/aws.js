// [TRABALHO 2] Clientes Postgres + MinIO (S3) + RabbitMQ + DynamoDB + Redis compartilhados por backend e worker.
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  PutBucketPolicyCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const {
  DynamoDBClient,
  DescribeTableCommand,
  CreateTableCommand,
} = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { Pool } = require('pg');
const Redis = require('ioredis');
const amqp = require('amqplib');
const crypto = require('crypto');
const cfg = require('./config');

// ---------- [TRABALHO 2 - MINIO] Cliente S3 apontando para o container MinIO ----------
const s3Config = {
  region: cfg.region,
  forcePathStyle: true, // Obrigatório para MinIO
  credentials: {
    accessKeyId: cfg.s3.accessKey,
    secretAccessKey: cfg.s3.secretKey,
  },
};

const s3 = new S3Client({
  ...s3Config,
  ...(cfg.s3.endpoint ? { endpoint: cfg.s3.endpoint } : {}),
});

// Cliente usado apenas para assinar URLs (getSignedUrl) com o host acessível pelo navegador (localhost:9000)
const s3Public = new S3Client({
  ...s3Config,
  ...(cfg.s3.publicEndpoint ? { endpoint: cfg.s3.publicEndpoint } : cfg.s3.endpoint ? { endpoint: cfg.s3.endpoint } : {}),
});

// ---------- [TRABALHO 2 - DYNAMODB] Banco NoSQL (AWS Cloud ou container DynamoDB Local) ----------
const ddbConfig = { region: cfg.region };
if (cfg.dynamoEndpoint) {
  ddbConfig.endpoint = cfg.dynamoEndpoint;
  ddbConfig.credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'local',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'local',
  };
}
const ddbRaw = new DynamoDBClient(ddbConfig);
const ddb = DynamoDBDocumentClient.from(ddbRaw, {
  marshallOptions: { removeUndefinedValues: true },
});

// ---------- [TRABALHO 2 - POSTGRES] Banco Relacional em container ----------
const pool = new Pool({ ...cfg.db, max: 10 });

// ---------- Redis (Cache) ----------
let redis = null;
if (cfg.redisUrl) {
  redis = new Redis(cfg.redisUrl, { maxRetriesPerRequest: 1, lazyConnect: false });
  redis.on('error', (e) => console.warn('[redis]', e.message));
}

const cache = {
  async wrap(key, fn, ttl = cfg.cacheTtl) {
    if (redis && redis.status === 'ready') {
      const cached = await redis.get(key).catch(() => null);
      if (cached) return { data: JSON.parse(cached), hit: true };
    }
    const data = await fn();
    if (redis && redis.status === 'ready') await redis.set(key, JSON.stringify(data), 'EX', ttl).catch(() => { });
    return { data, hit: false };
  },
  async invalidate(...patterns) {
    if (!redis || redis.status !== 'ready') return;
    for (const p of patterns) {
      const keys = p.includes('*') ? await redis.keys(p) : [p];
      if (keys.length) await redis.del(...keys);
    }
  },
  status: () => (redis ? redis.status : 'disabled'),
};

// ---------- [TRABALHO 2 - MINIO] Operações de leitura e escrita de arquivos ----------
const storage = {
  async init() {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
      console.log(`[minio] bucket "${cfg.bucket}" pronto (${cfg.s3.endpoint})`);
    } catch (e) {
      await s3.send(new CreateBucketCommand({ Bucket: cfg.bucket }));
      console.log(`[minio] bucket "${cfg.bucket}" criado com sucesso`);
    }
    // Permite leitura das imagens geradas pelo MinIO
    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { AWS: ['*'] },
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${cfg.bucket}/*`],
        },
      ],
    };
    await s3.send(new PutBucketPolicyCommand({ Bucket: cfg.bucket, Policy: JSON.stringify(policy) })).catch(() => { });
  },
  put: (Key, Body, ContentType) =>
    s3.send(new PutObjectCommand({ Bucket: cfg.bucket, Key, Body, ContentType })),
  async get(Key) {
    const r = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key }));
    return Buffer.from(await r.Body.transformToByteArray());
  },
  url: (Key) =>
    Key ? getSignedUrl(s3Public, new GetObjectCommand({ Bucket: cfg.bucket, Key }), { expiresIn: 3600 }) : null,
};

// ---------- [TRABALHO 2 - DYNAMODB] Log de auditoria NoSQL ----------
const audit = {
  async init() {
    try {
      await ddbRaw.send(new DescribeTableCommand({ TableName: cfg.auditTable }));
      console.log(`[dynamodb] tabela "${cfg.auditTable}" pronta (${cfg.dynamoEndpoint || 'AWS Cloud'})`);
    } catch (e) {
      if (e.name === 'ResourceNotFoundException') {
        try {
          await ddbRaw.send(
            new CreateTableCommand({
              TableName: cfg.auditTable,
              BillingMode: 'PAY_PER_REQUEST',
              AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
              KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
            })
          );
          console.log(`[dynamodb] tabela "${cfg.auditTable}" criada com sucesso`);
        } catch (err) {
          if (/preexisting|ResourceInUse/i.test(err.message + err.name)) {
            console.log(`[dynamodb] tabela "${cfg.auditTable}" pronta`);
          } else {
            throw err;
          }
        }
      } else {
        console.warn('[dynamodb] aviso ao verificar tabela:', e.message);
      }
    }
  },
  async log(acao, entidade, dados, extra = {}) {
    const item = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      acao, // CREATE | READ | UPDATE | DELETE | PROCESS
      entidade,
      dados: JSON.parse(JSON.stringify(dados ?? {})),
      ...extra,
    };
    try {
      await ddb.send(new PutCommand({ TableName: cfg.auditTable, Item: item }));
    } catch (e) {
      console.error('[audit]', e.message);
    }
    return item;
  },
  async recent(limit = 50) {
    const r = await ddb.send(new ScanCommand({ TableName: cfg.auditTable, Limit: 500 }));
    return (r.Items || []).sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
  },
};

// ---------- [TRABALHO 2 - RABBITMQ] Produtor de mensagens para a fila do worker ----------
let amqpConn = null;
let amqpChannel = null;

async function getRabbitChannel() {
  if (amqpChannel) return amqpChannel;
  amqpConn = await amqp.connect(cfg.rabbitUrl);
  amqpConn.on('error', (e) => {
    console.warn('[rabbitmq] erro na conexão:', e.message);
    amqpChannel = null;
    amqpConn = null;
  });
  amqpConn.on('close', () => {
    amqpChannel = null;
    amqpConn = null;
  });
  amqpChannel = await amqpConn.createChannel();
  await amqpChannel.assertQueue(cfg.rabbitQueue, { durable: true });
  return amqpChannel;
}

const events = {
  async init() {
    for (let attempt = 1; attempt <= 15; attempt++) {
      try {
        const ch = await getRabbitChannel();
        console.log(`[rabbitmq] fila "${cfg.rabbitQueue}" pronta`);
        return ch;
      } catch (e) {
        console.warn(`[rabbitmq] aguardando broker (${attempt}/15):`, e.message);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  },
  async publish(type, payload) {
    const ch = await getRabbitChannel();
    const message = Buffer.from(JSON.stringify({ type, ...payload, timestamp: new Date().toISOString() }));
    return ch.sendToQueue(cfg.rabbitQueue, message, {
      persistent: true,
      contentType: 'application/json',
    });
  },
  status: () => (amqpChannel ? 'connected' : 'disconnected'),
};

module.exports = { pool, cache, storage, audit, events };
