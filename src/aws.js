// Clientes AWS + Postgres (RDS) + Redis (ElastiCache) compartilhados por web e worker.
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { Pool } = require('pg');
const Redis = require('ioredis');
const crypto = require('crypto');
const cfg = require('./config');

const s3 = new S3Client({ region: cfg.region });
const sns = new SNSClient({ region: cfg.region });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: cfg.region }), {
  marshallOptions: { removeUndefinedValues: true },
});

// ---------- RDS ----------
const pool = new Pool({ ...cfg.db, max: 10 });

// ---------- ElastiCache (Redis) ----------
let redis = null;
if (cfg.redisUrl) {
  redis = new Redis(cfg.redisUrl, { maxRetriesPerRequest: 1, lazyConnect: false });
  redis.on('error', (e) => console.warn('[redis]', e.message));
}

const cache = {
  // Retorna { data, hit } — o "hit" é exibido na interface para demonstrar o cache.
  async wrap(key, fn, ttl = cfg.cacheTtl) {
    if (redis && redis.status === 'ready') {
      const cached = await redis.get(key).catch(() => null);
      if (cached) return { data: JSON.parse(cached), hit: true };
    }
    const data = await fn();
    if (redis && redis.status === 'ready') await redis.set(key, JSON.stringify(data), 'EX', ttl).catch(() => {});
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

// ---------- S3 ----------
const storage = {
  put: (Key, Body, ContentType) =>
    s3.send(new PutObjectCommand({ Bucket: cfg.bucket, Key, Body, ContentType })),
  async get(Key) {
    const r = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key }));
    return Buffer.from(await r.Body.transformToByteArray());
  },
  url: (Key) => (Key ? getSignedUrl(s3, new GetObjectCommand({ Bucket: cfg.bucket, Key }), { expiresIn: 3600 }) : null),
};

// ---------- DynamoDB (log de auditoria do CRUD) ----------
const audit = {
  async log(acao, entidade, dados, extra = {}) {
    const item = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      acao, // CREATE | READ | UPDATE | DELETE | PROCESS
      entidade,
      dados: JSON.parse(JSON.stringify(dados ?? {})), // Date -> string ISO (DynamoDB não aceita Date)
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

// ---------- SNS (publica evento para a fila SQS do worker) ----------
const events = {
  publish: (type, payload) =>
    sns.send(new PublishCommand({
      TopicArn: cfg.snsTopicArn,
      Message: JSON.stringify({ type, ...payload }),
      MessageAttributes: { type: { DataType: 'String', StringValue: type } },
    })),
};

module.exports = { pool, cache, storage, audit, events };
