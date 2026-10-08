// Verifica RDS/ElastiCache e, quando prontos, gera o .env da aplicação.
const fs = require('fs');
const path = require('path');
const RDS = require('@aws-sdk/client-rds');
const EC = require('@aws-sdk/client-elasticache');

const region = 'us-east-1';
const state = JSON.parse(fs.readFileSync(path.join(__dirname, 'state.json')));

(async () => {
  const db = (await new RDS.RDSClient({ region }).send(new RDS.DescribeDBInstancesCommand({ DBInstanceIdentifier: state.dbId }))).DBInstances[0];
  const rc = (await new EC.ElastiCacheClient({ region }).send(new EC.DescribeCacheClustersCommand({ CacheClusterId: state.redisId, ShowCacheNodeInfo: true }))).CacheClusters[0];
  console.log('RDS:', db.DBInstanceStatus, '| Redis:', rc.CacheClusterStatus);
  if (db.DBInstanceStatus !== 'available' || rc.CacheClusterStatus !== 'available') return console.log('Aguarde e rode novamente.');

  const env = {
    PORT: 80, AWS_REGION: region,
    DB_HOST: db.Endpoint.Address, DB_PORT: db.Endpoint.Port, DB_USER: 'medadmin', DB_PASSWORD: state.dbPassword, DB_NAME: 'medcloud', DB_SSL: 'true',
    REDIS_URL: `redis://${rc.CacheNodes[0].Endpoint.Address}:${rc.CacheNodes[0].Endpoint.Port}`,
    S3_BUCKET: state.bucket, DYNAMO_TABLE: state.auditTable, SNS_TOPIC_ARN: state.topicArn, SQS_QUEUE_URL: state.queueUrl,
  };
  fs.writeFileSync(path.join(__dirname, '..', '.env'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  console.log('.env gerado.');
})().catch((e) => { console.error(e.name, e.message); process.exit(1); });
