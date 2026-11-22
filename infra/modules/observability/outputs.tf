output "dashboard_name" {
  value = aws_cloudwatch_dashboard.this.dashboard_name
}

output "alarms_topic_arn" {
  value = aws_sns_topic.alarms.arn
}

output "alarm_names" {
  value = [
    aws_cloudwatch_metric_alarm.error_rate.alarm_name,
    aws_cloudwatch_metric_alarm.latency_p95.alarm_name,
    aws_cloudwatch_metric_alarm.unhealthy_hosts.alarm_name,
    aws_cloudwatch_metric_alarm.ecs_memory.alarm_name,
    aws_cloudwatch_metric_alarm.dlq_depth.alarm_name,
    aws_cloudwatch_metric_alarm.queue_age.alarm_name,
  ]
}
