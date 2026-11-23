require('dotenv').config();

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

module.exports = {
  port: Number(env('PORT', 3000)),
  region: env('AWS_REGION', 'us-east-1'),

  // [TRABALHO 2 - POSTGRES] Banco de dados relacional em container gerenciado pela equipe
  db: {
    host: env('DB_HOST', 'postgres'),
    port: Number(env('DB_PORT', 5432)),
    user: env('DB_USER', 'medadmin'),
    password: env('DB_PASSWORD', 'medcloud123'),
    database: env('DB_NAME', 'medcloud'),
    ssl: env('DB_SSL', 'false') === 'true' ? { rejectUnauthorized: false } : false,
  },

  // Cache Redis em container
  redisUrl: env('REDIS_URL', 'redis://redis:6379'),
  cacheTtl: Number(env('CACHE_TTL', 60)),

  // [TRABALHO 2 - MINIO] Armazenamento de objetos compatível com S3
  bucket: env('S3_BUCKET', 'medcloud-exames'),
  s3: {
    endpoint: env('S3_ENDPOINT', 'http://minio:9000'),
    publicEndpoint: env('S3_PUBLIC_ENDPOINT', 'http://localhost:9000'),
    accessKey: env('MINIO_ROOT_USER', 'minioadmin'),
    secretKey: env('MINIO_ROOT_PASSWORD', 'minioadmin123'),
  },

  // [TRABALHO 2 - DYNAMODB] Banco NoSQL da AWS (suporta AWS Cloud ou DynamoDB Local via DYNAMO_ENDPOINT)
  auditTable: env('DYNAMO_TABLE', 'medcloud-audit'),
  dynamoEndpoint: env('DYNAMO_ENDPOINT', ''),

  // [TRABALHO 2 - RABBITMQ] Serviço de fila de mensagens substituindo SNS/SQS
  rabbitUrl: env('RABBITMQ_URL', 'amqp://medadmin:medcloud123@rabbitmq:5672'),
  rabbitQueue: env('RABBITMQ_QUEUE', 'medcloud.exames.processamento'),
};
