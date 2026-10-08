require('dotenv').config();

const env = (k, d) => process.env[k] ?? d;

module.exports = {
  port: Number(env('PORT', 3000)),
  region: env('AWS_REGION', 'us-east-1'),
  db: {
    host: env('DB_HOST', 'localhost'),
    port: Number(env('DB_PORT', 5432)),
    user: env('DB_USER', 'medadmin'),
    password: env('DB_PASSWORD', ''),
    database: env('DB_NAME', 'medcloud'),
    ssl: env('DB_SSL', 'true') === 'true' ? { rejectUnauthorized: false } : false,
  },
  redisUrl: env('REDIS_URL', ''),
  cacheTtl: Number(env('CACHE_TTL', 60)),
  bucket: env('S3_BUCKET', ''),
  auditTable: env('DYNAMO_TABLE', 'medcloud-audit'),
  snsTopicArn: env('SNS_TOPIC_ARN', ''),
  sqsQueueUrl: env('SQS_QUEUE_URL', ''),
};
