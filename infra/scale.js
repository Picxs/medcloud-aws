// Parte 2: Launch Template + ALB + Auto Scaling Group (1..3) + alarmes de CPU (>70% sobe, <25% desce).
// Uso: AWS_SHARED_CREDENTIALS_FILE=.aws/credentials AWS_CONFIG_FILE=.aws/config npm run infra:scale
const fs = require('fs');
const path = require('path');
const EC2 = require('@aws-sdk/client-ec2');
const ELB = require('@aws-sdk/client-elastic-load-balancing-v2');
const AS = require('@aws-sdk/client-auto-scaling');
const CW = require('@aws-sdk/client-cloudwatch');

const region = 'us-east-1';
const P = 'medcloud';
const STATE = path.join(__dirname, 'state.json');
const state = JSON.parse(fs.readFileSync(STATE));
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
const ec2 = new EC2.EC2Client({ region }), elb = new ELB.ElasticLoadBalancingV2Client({ region });
const as = new AS.AutoScalingClient({ region }), cw = new CW.CloudWatchClient({ region });
const ok = async (p, re) => { try { return await p; } catch (e) { if (re.test(e.name + e.message)) return null; throw e; } };

async function main() {
  const ud = path.join(__dirname, 'user-data.local.sh');
  if (!fs.existsSync(ud)) throw new Error('infra/user-data.local.sh não encontrado');

  // Subnets da VPC padrão, excluindo us-east-1e (não oferece t3.micro).
  const subnets = (await ec2.send(new EC2.DescribeSubnetsCommand({ Filters: [{ Name: 'vpc-id', Values: [state.vpcId] }] })))
    .Subnets.filter((s) => s.AvailabilityZone !== 'us-east-1e');
  const subnetIds = subnets.map((s) => s.SubnetId);

  // ---- AMI Amazon Linux 2023 mais recente ----
  const imgs = (await ec2.send(new EC2.DescribeImagesCommand({ Owners: ['amazon'],
    Filters: [{ Name: 'name', Values: ['al2023-ami-2023.*-x86_64'] }, { Name: 'state', Values: ['available'] }] }))).Images;
  const ami = imgs.sort((a, b) => b.CreationDate.localeCompare(a.CreationDate))[0].ImageId;

  // ---- Launch Template (nova versão a cada execução) ----
  state.ltName = `${P}-lt`;
  const data = {
    ImageId: ami, InstanceType: 't3.micro', KeyName: 'vockey',
    SecurityGroupIds: [state.sgApp], IamInstanceProfile: { Name: 'LabInstanceProfile' },
    Monitoring: { Enabled: true }, // métricas de 1 em 1 minuto
    UserData: fs.readFileSync(ud).toString('base64'),
    TagSpecifications: [{ ResourceType: 'instance', Tags: [{ Key: 'Name', Value: `${P}-asg` }] }],
  };
  const created = await ok(ec2.send(new EC2.CreateLaunchTemplateCommand({ LaunchTemplateName: state.ltName, LaunchTemplateData: data })), /AlreadyExists/);
  if (!created) {
    const v = await ec2.send(new EC2.CreateLaunchTemplateVersionCommand({ LaunchTemplateName: state.ltName, LaunchTemplateData: data }));
    await ec2.send(new EC2.ModifyLaunchTemplateCommand({ LaunchTemplateName: state.ltName, DefaultVersion: String(v.LaunchTemplateVersion.VersionNumber) }));
  }
  console.log('Launch Template', state.ltName, 'AMI', ami); save();

  // ---- Target Group + ALB + Listener ----
  const tg = (await elb.send(new ELB.CreateTargetGroupCommand({
    Name: `${P}-tg`, Protocol: 'HTTP', Port: 80, VpcId: state.vpcId, TargetType: 'instance',
    HealthCheckPath: '/api/health', HealthCheckIntervalSeconds: 15, HealthyThresholdCount: 2, UnhealthyThresholdCount: 3,
  }))).TargetGroups[0];
  state.tgArn = tg.TargetGroupArn;
  await elb.send(new ELB.ModifyTargetGroupAttributesCommand({ TargetGroupArn: state.tgArn,
    Attributes: [{ Key: 'deregistration_delay.timeout_seconds', Value: '30' }] }));

  const lb = (await elb.send(new ELB.CreateLoadBalancerCommand({
    Name: `${P}-alb`, Subnets: subnetIds, SecurityGroups: [state.sgAlb], Scheme: 'internet-facing', Type: 'application',
  }))).LoadBalancers[0];
  state.albArn = lb.LoadBalancerArn; state.albDns = lb.DNSName;
  const listeners = (await elb.send(new ELB.DescribeListenersCommand({ LoadBalancerArn: state.albArn }))).Listeners;
  if (!listeners.length) await elb.send(new ELB.CreateListenerCommand({ LoadBalancerArn: state.albArn, Protocol: 'HTTP', Port: 80,
    DefaultActions: [{ Type: 'forward', TargetGroupArn: state.tgArn }] }));
  console.log('ALB', state.albDns); save();

  // ---- Auto Scaling Group ----
  state.asgName = `${P}-asg`;
  const asgCfg = {
    AutoScalingGroupName: state.asgName, LaunchTemplate: { LaunchTemplateName: state.ltName, Version: '$Default' },
    MinSize: 1, MaxSize: 3, DesiredCapacity: 1, VPCZoneIdentifier: subnetIds.join(','),
    TargetGroupARNs: [state.tgArn], HealthCheckType: 'ELB', HealthCheckGracePeriod: 240, DefaultCooldown: 60,
  };
  const made = await ok(as.send(new AS.CreateAutoScalingGroupCommand(asgCfg)), /AlreadyExists/);
  if (!made) { delete asgCfg.TargetGroupARNs; await as.send(new AS.UpdateAutoScalingGroupCommand(asgCfg)); }
  await as.send(new AS.EnableMetricsCollectionCommand({ AutoScalingGroupName: state.asgName, Granularity: '1Minute' }));
  console.log('ASG', state.asgName, '(min 1, max 3)'); save();

  // ---- Políticas + alarmes ----
  async function policy(name, adj, alarm, op, threshold) {
    const pol = await as.send(new AS.PutScalingPolicyCommand({
      AutoScalingGroupName: state.asgName, PolicyName: name, PolicyType: 'SimpleScaling',
      AdjustmentType: 'ChangeInCapacity', ScalingAdjustment: adj, Cooldown: 60,
    }));
    await cw.send(new CW.PutMetricAlarmCommand({
      AlarmName: alarm, Namespace: 'AWS/EC2', MetricName: 'CPUUtilization', Statistic: 'Average',
      Dimensions: [{ Name: 'AutoScalingGroupName', Value: state.asgName }],
      Period: 60, EvaluationPeriods: 1, Threshold: threshold, ComparisonOperator: op,
      AlarmActions: [pol.PolicyARN], TreatMissingData: 'notBreaching',
    }));
    console.log('Alarme', alarm);
  }
  await policy(`${P}-scale-out`, 1, `${P}-cpu-alta-70`, 'GreaterThanThreshold', 70);
  await policy(`${P}-scale-in`, -1, `${P}-cpu-baixa-25`, 'LessThanThreshold', 25);
  save();
  console.log(`\nPronto. Em ~4 min acesse: http://${state.albDns}`);
}
main().catch((e) => { console.error('ERRO:', e.name, e.message); process.exit(1); });
