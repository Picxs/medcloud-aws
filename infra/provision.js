// Provisiona os recursos da Parte 1 (idempotente): S3, DynamoDB, SNS, SQS, Security Groups, RDS e ElastiCache.
// Uso: AWS_SHARED_CREDENTIALS_FILE=.aws/credentials AWS_CONFIG_FILE=.aws/config npm run infra
const fs = require('fs');
const path = require('path');
const S3 = require('@aws-sdk/client-s3');
const DDB = require('@aws-sdk/client-dynamodb');
const SNS = require('@aws-sdk/client-sns');
const SQS = require('@aws-sdk/client-sqs');
const EC2 = require('@aws-sdk/client-ec2');
const RDS = require('@aws-sdk/client-rds');
const EC = require('@aws-sdk/client-elasticache');
const crypto = require('crypto');

const region = 'us-east-1';
const P = 'medcloud';
const STATE = path.join(__dirname, 'state.json');
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE)) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
const c = (K) => new K({ region });
const s3 = c(S3.S3Client), ddb = c(DDB.DynamoDBClient), sns = c(SNS.SNSClient), sqs = c(SQS.SQSClient);
const ec2 = c(EC2.EC2Client), rds = c(RDS.RDSClient), ec = c(EC.ElastiCacheClient);
const ok = async (p, ignore) => { try { return await p; } catch (e) { if (ignore && ignore.test(e.name + e.message)) return null; throw e; } };

async function main() {
  // ---- Rede: VPC padrão ----
  const vpc = (await ec2.send(new EC2.DescribeVpcsCommand({ Filters: [{ Name: 'isDefault', Values: ['true'] }] }))).Vpcs[0];
  state.vpcId = vpc.VpcId;
  const subnets = (await ec2.send(new EC2.DescribeSubnetsCommand({ Filters: [{ Name: 'vpc-id', Values: [vpc.VpcId] }] }))).Subnets;
  state.subnetIds = subnets.map((s) => s.SubnetId);
  console.log('VPC', state.vpcId, 'subnets', state.subnetIds.length);

  async function sg(name, desc) {
    const f = await ec2.send(new EC2.DescribeSecurityGroupsCommand({ Filters: [{ Name: 'group-name', Values: [name] }, { Name: 'vpc-id', Values: [vpc.VpcId] }] }));
    if (f.SecurityGroups[0]) return f.SecurityGroups[0].GroupId;
    return (await ec2.send(new EC2.CreateSecurityGroupCommand({ GroupName: name, Description: desc, VpcId: vpc.VpcId }))).GroupId;
  }
  const ingress = (GroupId, perms) => ok(ec2.send(new EC2.AuthorizeSecurityGroupIngressCommand({ GroupId, IpPermissions: perms })), /Duplicate/);
  state.sgAlb = await sg(`${P}-alb`, 'ALB HTTP');
  state.sgApp = await sg(`${P}-app`, 'App EC2');
  state.sgData = await sg(`${P}-data`, 'RDS + Redis');
  await ingress(state.sgAlb, [{ IpProtocol: 'tcp', FromPort: 80, ToPort: 80, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }]);
  await ingress(state.sgApp, [
    { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '0.0.0.0/0' }] },
    { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, IpRanges: [{ CidrIp: '0.0.0.0/0' }] },
  ]);
  await ingress(state.sgData, [
    { IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432, UserIdGroupPairs: [{ GroupId: state.sgApp }] },
    { IpProtocol: 'tcp', FromPort: 6379, ToPort: 6379, UserIdGroupPairs: [{ GroupId: state.sgApp }] },
  ]);
  console.log('SGs', state.sgAlb, state.sgApp, state.sgData); save();

  // ---- S3 ----
  state.bucket ||= `${P}-exames-${crypto.randomBytes(4).toString('hex')}`;
  await ok(s3.send(new S3.CreateBucketCommand({ Bucket: state.bucket })), /BucketAlreadyOwnedByYou/);
  console.log('S3', state.bucket); save();

  // ---- DynamoDB ----
  state.auditTable = `${P}-audit`;
  await ok(ddb.send(new DDB.CreateTableCommand({
    TableName: state.auditTable, BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
  })), /ResourceInUse/);
  console.log('DynamoDB', state.auditTable); save();

  // ---- SNS -> SQS ----
  state.topicArn = (await sns.send(new SNS.CreateTopicCommand({ Name: `${P}-exames` }))).TopicArn;
  state.queueUrl = (await sqs.send(new SQS.CreateQueueCommand({ QueueName: `${P}-processamento`, Attributes: { VisibilityTimeout: '120' } }))).QueueUrl;
  const qArn = (await sqs.send(new SQS.GetQueueAttributesCommand({ QueueUrl: state.queueUrl, AttributeNames: ['QueueArn'] }))).Attributes.QueueArn;
  await sqs.send(new SQS.SetQueueAttributesCommand({ QueueUrl: state.queueUrl, Attributes: { Policy: JSON.stringify({
    Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'sns.amazonaws.com' }, Action: 'sqs:SendMessage',
      Resource: qArn, Condition: { ArnEquals: { 'aws:SourceArn': state.topicArn } } }] }) } }));
  await sns.send(new SNS.SubscribeCommand({ TopicArn: state.topicArn, Protocol: 'sqs', Endpoint: qArn }));
  console.log('SNS', state.topicArn, '-> SQS', state.queueUrl); save();

  // ---- RDS PostgreSQL ----
  state.dbPassword ||= crypto.randomBytes(12).toString('base64url');
  state.dbId = `${P}-db`;
  await ok(rds.send(new RDS.CreateDBInstanceCommand({
    DBInstanceIdentifier: state.dbId, Engine: 'postgres', DBInstanceClass: 'db.t3.micro', AllocatedStorage: 20,
    MasterUsername: 'medadmin', MasterUserPassword: state.dbPassword, DBName: 'medcloud',
    VpcSecurityGroupIds: [state.sgData], PubliclyAccessible: false, BackupRetentionPeriod: 0, MultiAZ: false,
  })), /AlreadyExists/);
  console.log('RDS', state.dbId, '(criando, ~5-10 min)'); save();

  // ---- ElastiCache Redis ----
  state.redisId = `${P}-redis`;
  await ok(ec.send(new EC.CreateCacheClusterCommand({
    CacheClusterId: state.redisId, Engine: 'redis', CacheNodeType: 'cache.t3.micro', NumCacheNodes: 1,
    SecurityGroupIds: [state.sgData],
  })), /AlreadyExists/);
  console.log('ElastiCache', state.redisId, '(criando, ~5-10 min)'); save();

  console.log('\nOK. Rode `npm run infra:status` até RDS e Redis ficarem "available" — ele gera o .env.');
}
main().catch((e) => { console.error('ERRO:', e.name, e.message); process.exit(1); });
