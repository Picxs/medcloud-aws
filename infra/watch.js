// Monitor para o vídeo: mostra a cada 10s instâncias do ASG, saúde no ALB, estado dos alarmes e atividades.
const fs = require('fs');
const path = require('path');
const AS = require('@aws-sdk/client-auto-scaling');
const ELB = require('@aws-sdk/client-elastic-load-balancing-v2');
const CW = require('@aws-sdk/client-cloudwatch');

const region = 'us-east-1';
const s = JSON.parse(fs.readFileSync(path.join(__dirname, 'state.json')));
const as = new AS.AutoScalingClient({ region }), elb = new ELB.ElasticLoadBalancingV2Client({ region }), cw = new CW.CloudWatchClient({ region });

async function tick() {
  const g = (await as.send(new AS.DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [s.asgName] }))).AutoScalingGroups[0];
  const th = (await elb.send(new ELB.DescribeTargetHealthCommand({ TargetGroupArn: s.tgArn }))).TargetHealthDescriptions;
  const al = (await cw.send(new CW.DescribeAlarmsCommand({ AlarmNamePrefix: 'medcloud-cpu' }))).MetricAlarms;
  const cpu = (await cw.send(new CW.GetMetricStatisticsCommand({
    Namespace: 'AWS/EC2', MetricName: 'CPUUtilization',
    Dimensions: [{ Name: 'AutoScalingGroupName', Value: s.asgName }], StartTime: new Date(Date.now() - 5 * 60e3), EndTime: new Date(),
    Period: 60, Statistics: ['Average']
  }))).Datapoints.sort((a, b) => a.Timestamp - b.Timestamp).map((d) => d.Average.toFixed(0) + '%');
  const act = (await as.send(new AS.DescribeScalingActivitiesCommand({ AutoScalingGroupName: s.asgName, MaxRecords: 3 }))).Activities;
  console.clear();
  console.log(new Date().toLocaleTimeString('pt-BR'), `| ASG desejado=${g.DesiredCapacity} (min ${g.MinSize}, max ${g.MaxSize})`);
  console.log('CPU média (últimos min):', cpu.join(' → ') || '—');
  al.forEach((a) => console.log(`Alarme ${a.AlarmName}: ${a.StateValue}`));
  console.log('\nInstâncias:');
  g.Instances.forEach((i) => console.log(` ${i.InstanceId} ${i.AvailabilityZone} ${i.LifecycleState} ALB=${th.find((t) => t.Target.Id === i.InstanceId)?.TargetHealth.State || '—'}`));
  console.log('\nÚltimas atividades:');
  act.forEach((a) => console.log(` [${a.StatusCode}] ${a.Description}`));
  console.log(`\nALB: http://${s.albDns}`);
}
(async () => { for (; ;) { await tick().catch((e) => console.error(e.message)); await new Promise((r) => setTimeout(r, 10000)); } })();
